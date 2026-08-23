import { NextRequest, NextResponse } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { trades, journal, tradeTags, rules } from "@/db/schema";
import { computeDerived } from "@/lib/metrics";
import { isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";

const body = z.object({
  tradeId: z.number().int(),
  /** The confirmed fill, read off the platform. Required the first time a
   *  trade is reviewed — the sync only ever records a provisional mark. */
  exitActual: z.number().nullable().optional(),
  exitReason: z.enum([
    "target_hit",
    "stop_hit",
    "time_stop",
    "thesis_broken",
    "discretionary",
    "trailed_out",
    "gapped",
  ]),
  execution: z.enum([
    "followed_plan",
    "deviated_entry",
    "deviated_exit",
    "exited_early",
    "exited_late",
    "no_exit_plan",
  ]),
  emotion: z
    .enum(["confident", "fomo", "hesitant", "revenge", "bored", "anxious"])
    .nullable(),
  mistakeTagIds: z.array(z.number().int()).default([]),
  whatWorked: z.string().min(1),
  whatFailed: z.string().min(1),
  lesson: z.string().min(1),
  recurring: z.boolean().default(false),
  playbookEntry: z.string().nullable().optional(),
  playbookExit: z.string().nullable().optional(),
});

export async function POST(req: NextRequest) {
  if (!(await isAuthed()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 422 },
    );

  const b = parsed.data;

  const [t] = await db.select().from(trades).where(eq(trades.id, b.tradeId));
  if (!t) return NextResponse.json({ error: "no such trade" }, { status: 404 });

  // The real fill. Until it is supplied the trade cannot be priced, so a
  // provisional mark is never silently promoted into one.
  const exitActual = b.exitActual ?? t.exitActual;
  if (exitActual == null)
    return NextResponse.json(
      {
        error: "exitActual required",
        detail:
          "this trade has no confirmed exit price — supply the fill from the platform",
        provisional: t.exitProvisional,
      },
      { status: 422 },
    );

  const d = computeDerived({
    side: t.side,
    entryPlanned: t.entryPlanned,
    stopPlanned: t.stopPlanned,
    targetPlanned: t.targetPlanned,
    entryActual: t.entryActual,
    exitActual,
    qty: t.qty,
    fees: t.fees,
    // Captured while the trade was open; this is the only place they can
    // become maeR / mfeR.
    maePrice: t.maePrice,
    mfePrice: t.mfePrice,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
  });

  await db
    .update(trades)
    .set({
      status: "closed",
      exitActual,
      exitReason: b.exitReason,
      execution: b.execution,
      emotion: b.emotion,
      plUsd: d.plUsd ?? t.plUsd,
      plPct: d.plPct ?? t.plPct,
      rMultiple: d.rMultiple ?? t.rMultiple,
      rrPlanned: d.rrPlanned ?? t.rrPlanned,
      rrActual: d.rrActual ?? t.rrActual,
      slippageEntryR: d.slippageEntryR,
      slippageExitR: d.slippageExitR,
      maeR: d.maeR,
      mfeR: d.mfeR,
      efficiency: d.efficiency,
      holdDays: d.holdDays,
      dayOfWeek: d.dayOfWeek,
    })
    .where(eq(trades.id, b.tradeId));

  // Journal entry — one per trade.
  const existing = await db
    .select()
    .from(journal)
    .where(eq(journal.tradeId, b.tradeId));

  if (existing.length) {
    await db
      .update(journal)
      .set({
        whatWorked: b.whatWorked,
        whatFailed: b.whatFailed,
        lesson: b.lesson,
        recurring: b.recurring,
        playbookEntry: b.playbookEntry ?? null,
        playbookExit: b.playbookExit ?? null,
        writtenAt: new Date(),
      })
      .where(eq(journal.id, existing[0].id));
  } else {
    await db.insert(journal).values({
      tradeId: b.tradeId,
      whatWorked: b.whatWorked,
      whatFailed: b.whatFailed,
      lesson: b.lesson,
      recurring: b.recurring,
      playbookEntry: b.playbookEntry ?? null,
      playbookExit: b.playbookExit ?? null,
    });
  }

  // Mistake tags — replace the set.
  await db.delete(tradeTags).where(eq(tradeTags.tradeId, b.tradeId));
  if (b.mistakeTagIds.length) {
    await db
      .insert(tradeTags)
      .values(b.mistakeTagIds.map((tagId) => ({ tradeId: b.tradeId, tagId })))
      .onConflictDoNothing();
  }

  // A lesson flagged recurring three times has stopped being a lesson and
  // become a rule. Surface it rather than letting it repeat a fourth time.
  let promotion: string | null = null;
  if (b.recurring) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(journal)
      .where(eq(journal.recurring, true));
    if (count >= 3) {
      promotion = `${count} recurring lessons logged — review them in the weekly and decide which become gates.`;
    }
  }

  return NextResponse.json({ ok: true, promotion });
}
