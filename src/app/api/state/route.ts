import { NextRequest, NextResponse } from "next/server";
import { desc, eq, and, gt, or, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  positions,
  orders,
  zones,
  wishlist,
  screenerCoverage,
  suggestions,
  actionItems,
  rules,
  catalysts,
  runs,
} from "@/db/schema";
import { checkIngestToken } from "@/lib/auth";
import { freeStopMove } from "@/lib/metrics";

export const dynamic = "force-dynamic";

/**
 * Read side of the agent contract.
 *
 * Agents used to load account state from a memory file, which meant every
 * scheduled run reasoned from whatever a previous run happened to write
 * down. This returns the book as the database actually holds it, so the
 * grader never has to guess what is open or what has already been
 * recommended.
 */
export async function GET(req: NextRequest) {
  if (!checkIngestToken(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await readState());
  } catch (e) {
    // An agent must be able to tell "the book is empty" from "I could not
    // read the book". Returning zeros for the second is how a run ends up
    // reasoning confidently about a book it never saw.
    console.error("state read failed", e);
    return NextResponse.json(
      { error: "state unavailable", detail: String(e) },
      { status: 503 },
    );
  }
}

async function readState() {
  const [account] = await db
    .select()
    .from(accounts)
    .orderBy(desc(accounts.updatedAt))
    .limit(1);

  const open = await db
    .select()
    .from(positions)
    .where(eq(positions.isOpen, true));

  const [lastRun] = await db
    .select()
    .from(runs)
    .orderBy(desc(runs.startedAt))
    .limit(1);

  const base = account?.sizingBase ?? account?.balance ?? null;
  const totalRiskFromMark = open.reduce((a, p) => a + (p.riskFromMark ?? 0), 0);
  const totalCapitalAtRisk = open.reduce((a, p) => a + (p.riskUsd ?? 0), 0);

  const free = open
    .map((p) => {
      const m = freeStopMove({
        side: p.side,
        entry: p.entry,
        stop: p.stop,
        mark: p.mark,
        qty: p.qty,
      });
      return m
        ? {
            symbol: p.symbol,
            side: p.side,
            direction: p.side === "long" ? "raise" : "lower",
            from: p.stop,
            to: Number(m.to.toFixed(4)),
            removes: Number(m.removes.toFixed(2)),
          }
        : null;
    })
    .filter(Boolean);

  return {
    /** Marks are only as fresh as the last sync — check this before
     *  treating any price here as current. */
    asOf: account?.updatedAt ?? null,
    markSource: account?.source ?? null,
    lastRun: lastRun
      ? {
          agent: lastRun.agent,
          at: lastRun.startedAt,
          status: lastRun.status,
          degraded: lastRun.degraded,
        }
      : null,

    account: account
      ? {
          label: account.label,
          balance: account.balance,
          equity: account.equity,
          sizingBase: base,
          riskBudget1pct: base ? Number((base * 0.01).toFixed(2)) : null,
        }
      : null,

    risk: {
      totalRiskFromMark: Number(totalRiskFromMark.toFixed(2)),
      totalCapitalAtRisk: Number(totalCapitalAtRisk.toFixed(2)),
      pctOfBase: base
        ? Number(((totalRiskFromMark / base) * 100).toFixed(2))
        : null,
      unstopped: open.filter((p) => p.stop == null).map((p) => p.symbol),
    },

    positions: open.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      entry: p.entry,
      stop: p.stop,
      target: p.target,
      mark: p.mark,
      markAt: p.markAt,
      pl: p.pl,
      capitalAtRisk: p.riskUsd,
      riskFromMark: p.riskFromMark,
      lockedGain: p.lockedGain,
    })),

    freeStopMoves: free,

    orders: await db.select().from(orders),

    zones: await db.select().from(zones),

    wishlist: await db
      .select()
      .from(wishlist)
      .where(eq(wishlist.active, true))
      .orderBy(wishlist.distancePct),

    /**
     * Rotation memory. The symbol universe lives in the saved TradingView
     * screen, not here — this is only what the app has already looked at,
     * oldest first. A run takes its batch from the top of this list (plus
     * anything on the screen that appears nowhere in it), so coverage
     * rotates instead of re-reading the same large-caps every session.
     */
    screenerCoverage: (
      await db
        .select()
        .from(screenerCoverage)
        .orderBy(
          sql`${screenerCoverage.analyzedAt} ASC NULLS FIRST`,
        )
    ).map((s) => ({
      symbol: s.symbol,
      /** Last seen on the saved screen. */
      lastScreenedAt: s.lastScreenedAt,
      /** Null = in the universe, charts never read. These come first. */
      analyzedAt: s.analyzedAt,
      distancePct: s.distancePct,
      nearZone: s.nearZone,
      trend: s.trend,
      timesScreened: s.timesScreened,
    })),

    /** An idea past its own expiry is not open, whatever the status column
     *  says. Nothing sweeps expiresAt, so it has to be honoured at read
     *  time — otherwise the grader is handed a setup that lapsed days ago
     *  and told it is live. */
    openSuggestions: await db
      .select()
      .from(suggestions)
      .where(
        and(
          eq(suggestions.status, "open"),
          or(isNull(suggestions.expiresAt), gt(suggestions.expiresAt, new Date())),
        ),
      ),

    openActionItems: await db
      .select()
      .from(actionItems)
      .where(eq(actionItems.status, "open")),

    /** The gates and vetoes every suggestion must be checked against. */
    rules: await db.select().from(rules).where(eq(rules.active, true)),

    catalysts: await db
      .select()
      .from(catalysts)
      .where(gt(catalysts.eventAt, new Date())),
  };
}
