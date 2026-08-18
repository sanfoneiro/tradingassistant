import { NextRequest, NextResponse } from "next/server";
import { eq, and, sql, isNull } from "drizzle-orm";
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
  catalysts,
  priceMarks,
  runs,
  trades,
} from "@/db/schema";
import { ingestPayload } from "@/lib/ingest-schema";
import { checkIngestToken } from "@/lib/auth";
import { positionRisk } from "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!checkIngestToken(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = ingestPayload.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const p = parsed.data;

  try {
    switch (p.kind) {
      case "account_sync":
        return NextResponse.json(await handleAccountSync(p));
      case "zone":
        return NextResponse.json(await handleZone(p));
      case "suggestion":
        return NextResponse.json(await handleSuggestion(p));
      case "action_items":
        return NextResponse.json(await handleActionItems(p));
      case "wishlist":
        return NextResponse.json(await handleWishlist(p));
      case "universe":
        return NextResponse.json(await handleUniverse(p));
      case "screener_pass":
        return NextResponse.json(await handleScreenerPass(p));
      case "catalysts":
        return NextResponse.json(await handleCatalysts(p));
      case "run":
        return NextResponse.json(await handleRun(p));
    }
  } catch (e) {
    console.error("ingest failed", e);
    return NextResponse.json(
      { error: "ingest failed", detail: String(e) },
      { status: 500 },
    );
  }
}

/* ------------------------------------------------------------------ */

type P = Awaited<ReturnType<typeof ingestPayload.parse>>;

async function handleAccountSync(p: Extract<P, { kind: "account_sync" }>) {
  // A degraded sync still writes a run row — a skipped agent must be
  // loud, not silent. But it must not overwrite good marks with nulls.
  const [run] = await db
    .insert(runs)
    .values({
      agent: p.agent,
      status: p.degraded ? "degraded" : "ok",
      degraded: p.degraded,
      notes: p.notes ?? null,
      finishedAt: new Date(),
    })
    .returning();

  if (p.degraded) {
    return { ok: true, degraded: true, runId: run.id, wrote: 0 };
  }

  // Account
  const existing = await db
    .select()
    .from(accounts)
    .where(eq(accounts.label, p.account.label))
    .limit(1);

  let accountId: number;
  if (existing.length) {
    accountId = existing[0].id;
    await db
      .update(accounts)
      .set({
        balance: p.account.balance,
        equity: p.account.equity,
        sizingBase: p.account.sizingBase ?? p.account.balance,
        source: p.account.source,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
  } else {
    const [a] = await db
      .insert(accounts)
      .values({
        label: p.account.label,
        broker: p.account.broker ?? null,
        balance: p.account.balance,
        equity: p.account.equity,
        sizingBase: p.account.sizingBase ?? p.account.balance,
        source: p.account.source,
      })
      .returning();
    accountId = a.id;
  }

  // Positions — reconcile against what is currently open.
  const current = await db
    .select()
    .from(positions)
    .where(and(eq(positions.accountId, accountId), eq(positions.isOpen, true)));

  const incoming = new Set(p.positions.map((x) => `${x.symbol}:${x.side}`));
  let marksWritten = 0;

  for (const pos of p.positions) {
    const key = `${pos.symbol}:${pos.side}`;
    const prev = current.find((c) => `${c.symbol}:${c.side}` === key);

    const dir = pos.side === "long" ? 1 : -1;
    const fee = Math.abs(pos.fee ?? 0);

    // Net of commission, so this ties out to the platform's Net P/L
    // column. Gross P/L that almost matches is the same failure mode as
    // a price that almost matches.
    const pl =
      pos.mark != null
        ? dir * (pos.mark - pos.entry) * pos.qty - fee
        : null;
    const plPct =
      pos.mark != null ? ((dir * (pos.mark - pos.entry)) / pos.entry) * 100 : null;

    const risk = positionRisk({
      side: pos.side,
      entry: pos.entry,
      stop: pos.stop ?? null,
      mark: pos.mark,
      qty: pos.qty,
    });

    // Water marks: keep the extreme, never regress. These are the only
    // way MAE/MFE can be known — they cannot be reconstructed later.
    const favourable = pos.side === "long" ? pos.highSinceOpen : pos.lowSinceOpen;
    const adverse = pos.side === "long" ? pos.lowSinceOpen : pos.highSinceOpen;

    const mfe =
      favourable != null
        ? prev?.mfeRunning != null
          ? pos.side === "long"
            ? Math.max(prev.mfeRunning, favourable)
            : Math.min(prev.mfeRunning, favourable)
          : favourable
        : (prev?.mfeRunning ?? null);

    const mae =
      adverse != null
        ? prev?.maeRunning != null
          ? pos.side === "long"
            ? Math.min(prev.maeRunning, adverse)
            : Math.max(prev.maeRunning, adverse)
          : adverse
        : (prev?.maeRunning ?? null);

    const values = {
      accountId,
      symbol: pos.symbol,
      side: pos.side,
      qty: pos.qty,
      entry: pos.entry,
      stop: pos.stop ?? null,
      target: pos.target ?? null,
      mark: pos.mark,
      markSource: pos.markSource,
      markAt: pos.markAt,
      fee,
      pl,
      plPct,
      riskUsd: risk.capitalAtRisk,
      riskFromMark: risk.riskFromMark,
      lockedGain: risk.lockedGain,
      mfeRunning: mfe,
      maeRunning: mae,
      openedAt: pos.openedAt ?? prev?.openedAt ?? new Date(),
      isOpen: true,
    };

    if (prev) {
      await db.update(positions).set(values).where(eq(positions.id, prev.id));
    } else {
      await db.insert(positions).values(values);
    }

    if (pos.mark != null && pos.markSource && pos.markAt) {
      await db.insert(priceMarks).values({
        symbol: pos.symbol,
        price: pos.mark,
        source: pos.markSource,
        capturedAt: pos.markAt,
      });
      marksWritten++;
    }
  }

  // Anything that vanished from the platform has been closed. Flip it to
  // pending_review — the dashboard stays blocked until it is journalled.
  const disappeared = current.filter(
    (c) => !incoming.has(`${c.symbol}:${c.side}`),
  );
  for (const gone of disappeared) {
    await db
      .update(positions)
      .set({ isOpen: false, closedAt: new Date() })
      .where(eq(positions.id, gone.id));

    await db.insert(trades).values({
      symbol: gone.symbol,
      side: gone.side,
      status: "pending_review",
      entryPlanned: gone.entry,
      entryActual: gone.entry,
      stopPlanned: gone.stop,
      targetPlanned: gone.target,
      exitActual: gone.mark,
      qty: gone.qty,
      openedAt: gone.openedAt,
      closedAt: new Date(),
    });
  }

  // Orders: replace wholesale, they are cheap and always fully reported.
  await db.delete(orders).where(eq(orders.accountId, accountId));
  if (p.orders.length) {
    await db.insert(orders).values(
      p.orders.map((o) => ({
        accountId,
        symbol: o.symbol,
        type: o.type,
        level: o.level ?? null,
        qty: o.qty ?? null,
        status: o.status ?? "working",
        placedAt: new Date(),
      })),
    );
  }

  await db
    .update(runs)
    .set({ marksWritten })
    .where(eq(runs.id, run.id));

  return {
    ok: true,
    runId: run.id,
    positions: p.positions.length,
    marksWritten,
    closedToReview: disappeared.length,
  };
}

/**
 * Zones upsert on (symbol, timeframe, direction), so the timeframe string IS
 * part of the primary key in practice. Two agents writing "daily" and "1D"
 * for the same level produce two rows that never converge — which is exactly
 * what happened on 2026-08-18 (26 zones, two conventions). Normalise here, at
 * the only door into the table, rather than trusting every prompt to agree.
 */
function normalizeTimeframe(tf: string): string {
  const t = tf.trim().toLowerCase();
  const map: Record<string, string> = {
    daily: "1D", d: "1D", "1d": "1D", "1 d": "1D",
    weekly: "1W", w: "1W", "1w": "1W", "1 w": "1W",
    monthly: "1M", m: "1M", "1m": "1M",
    "4h": "4H", h4: "4H", "1h": "1H", h1: "1H",
    "15m": "15M", "5m": "5M",
  };
  return map[t] ?? tf.trim().toUpperCase();
}

async function handleZone(p: Extract<P, { kind: "zone" }>) {
  const timeframe = normalizeTimeframe(p.timeframe);

  // The MTF indicator reports entry (proximal) and SL (distal + buffer)
  // rather than a box. Derive the box so the agent can transcribe the
  // table column-for-column without doing arithmetic — arithmetic in a
  // transcription step is where digits get invented.
  const low =
    p.low ??
    (p.entryLevel != null && p.stopLevel != null
      ? Math.min(p.entryLevel, p.stopLevel)
      : null);
  const high =
    p.high ??
    (p.entryLevel != null && p.stopLevel != null
      ? Math.max(p.entryLevel, p.stopLevel)
      : null);

  if (low == null || high == null) {
    return {
      ok: false,
      error:
        "give either low+high, or entryLevel+stopLevel — the box is derived from them",
    };
  }

  const extra = {
    entryLevel: p.entryLevel ?? null,
    midLevel:
      p.midLevel ??
      (p.entryLevel != null && p.stopLevel != null
        ? (p.entryLevel + p.stopLevel) / 2
        : null),
    stopLevel: p.stopLevel ?? null,
    distancePct: p.distancePct ?? null,
    indicatorState: p.indicatorState ?? null,
    lastSeenAt: new Date(),
  };

  const existing = await db
    .select()
    .from(zones)
    .where(
      and(
        eq(zones.symbol, p.symbol),
        eq(zones.timeframe, timeframe),
        eq(zones.direction, p.direction),
      ),
    )
    .limit(1);

  if (existing.length) {
    const wasBroken =
      p.status === "tested_broken" && existing[0].status !== "tested_broken";
    await db
      .update(zones)
      .set({
        low,
        high,
        ...extra,
        status: p.status,
        confluence: p.confluence,
        note: p.note ?? existing[0].note,
        screenshotUrl: p.screenshotUrl ?? existing[0].screenshotUrl,
        invalidatedAt: wasBroken ? new Date() : existing[0].invalidatedAt,
      })
      .where(eq(zones.id, existing[0].id));

    // A broken zone kills every suggestion that depended on it.
    if (wasBroken) {
      await db
        .update(suggestions)
        .set({ status: "expired" })
        .where(
          and(
            eq(suggestions.zoneId, existing[0].id),
            eq(suggestions.status, "open"),
          ),
        );
    }
    return { ok: true, zoneId: existing[0].id, updated: true };
  }

  const [z] = await db
    .insert(zones)
    .values({
      symbol: p.symbol,
      direction: p.direction,
      low,
      high,
      ...extra,
      timeframe,
      status: p.status,
      confluence: p.confluence,
      note: p.note ?? null,
      screenshotUrl: p.screenshotUrl ?? null,
    })
    .returning();
  return { ok: true, zoneId: z.id, created: true };
}

async function handleSuggestion(p: Extract<P, { kind: "suggestion" }>) {
  const [s] = await db
    .insert(suggestions)
    .values({
      symbol: p.symbol,
      side: p.side,
      grade: p.grade,
      quadrant: p.quadrant,
      catalystState: p.catalystState,
      entryMechanic: p.entryMechanic,
      confluenceCount: p.confluenceCount ?? null,
      zoneId: p.zoneId ?? null,
      entry: p.entry,
      stop: p.stop,
      target: p.target,
      rr: p.rr,
      sizeUsd: p.sizeUsd ?? null,
      shares: p.shares ?? null,
      gatesPassed: p.gatesPassed,
      gatesFailed: p.gatesFailed,
      vetoesCleared: p.vetoesCleared,
      thesis: p.thesis ?? null,
      invalidation: p.invalidation ?? null,
      expiresAt: p.expiresAt ?? null,
    })
    .returning();
  return { ok: true, suggestionId: s.id, gatesFailed: p.gatesFailed };
}

async function handleActionItems(p: Extract<P, { kind: "action_items" }>) {
  const open = await db
    .select()
    .from(actionItems)
    .where(eq(actionItems.status, "open"));

  let repeated = 0;
  let created = 0;

  for (const item of p.items) {
    const prev = open.find(
      (o) => o.symbol === (item.symbol ?? null) && o.kind === item.kind,
    );

    if (prev) {
      // Repeat. Price what waiting has cost since the first raise —
      // this is the number that makes a nine-brief nag visible.
      const cost =
        prev.markAtFirstRaise != null && item.mark != null
          ? costOfDelay(prev.kind, prev.markAtFirstRaise, item.mark, prev.qtyAtFirstRaise ?? item.qty ?? 0)
          : prev.costOfDelayUsd;

      await db
        .update(actionItems)
        .set({
          text: item.text,
          rationale: item.rationale ?? prev.rationale,
          timesRepeated: prev.timesRepeated + 1,
          lastRaisedAt: new Date(),
          costOfDelayUsd: cost,
        })
        .where(eq(actionItems.id, prev.id));
      repeated++;
    } else {
      await db.insert(actionItems).values({
        kind: item.kind,
        symbol: item.symbol ?? null,
        text: item.text,
        rationale: item.rationale ?? null,
        markAtFirstRaise: item.mark ?? null,
        qtyAtFirstRaise: item.qty ?? null,
        costOfDelayUsd: 0,
      });
      created++;
    }
  }

  // Items no longer raised are considered resolved.
  const stillRaised = new Set(p.items.map((i) => `${i.kind}:${i.symbol ?? ""}`));
  const resolved = open.filter(
    (o) => !stillRaised.has(`${o.kind}:${o.symbol ?? ""}`),
  );
  for (const r of resolved) {
    await db
      .update(actionItems)
      .set({ status: "done", resolvedAt: new Date() })
      .where(eq(actionItems.id, r.id));
  }

  return { ok: true, created, repeated, resolved: resolved.length };
}

/**
 * "Close it" that was ignored: the cost is how much worse the exit got.
 * "Move the stop": the cost is the extra risk still being carried.
 * Both are signed so a delay that happened to help shows as a gain —
 * the ledger has to be honest in both directions or it is just nagging.
 */
function costOfDelay(
  kind: string,
  markThen: number,
  markNow: number,
  qty: number,
): number {
  if (!qty) return 0;
  if (kind === "close") return (markNow - markThen) * qty;
  if (kind === "move_stop") return 0; // risk-carried, not realised P&L
  return 0;
}

async function handleWishlist(p: Extract<P, { kind: "wishlist" }>) {
  let created = 0;
  let updated = 0;
  for (const w of p.items) {
    const [prev] = await db
      .select()
      .from(wishlist)
      .where(eq(wishlist.symbol, w.symbol))
      .limit(1);

    const values = {
      symbol: w.symbol,
      side: w.side ?? null,
      thesis: w.thesis ?? null,
      zoneId: w.zoneId ?? null,
      triggerNote: w.triggerNote ?? null,
      triggerLevel: w.triggerLevel ?? null,
      distancePct: w.distancePct ?? null,
      priority: w.priority ?? 3,
      active: w.active ?? true,
      updatedAt: new Date(),
    };

    if (prev) {
      await db.update(wishlist).set(values).where(eq(wishlist.id, prev.id));
      updated++;
    } else {
      await db.insert(wishlist).values(values);
      created++;
    }
  }
  return { ok: true, created, updated };
}

/**
 * Weekly list refresh. Adds new names with analyzedAt left null so they go
 * to the front of the analysis queue, and refreshes lastScreenedAt on ones
 * already known — without touching analyzedAt, because appearing on the
 * screen again is not the same as having been looked at.
 */
async function handleUniverse(p: Extract<P, { kind: "universe" }>) {
  let added = 0;
  let refreshed = 0;

  for (const symbol of p.symbols) {
    const [prev] = await db
      .select()
      .from(screenerCoverage)
      .where(eq(screenerCoverage.symbol, symbol))
      .limit(1);

    if (prev) {
      await db
        .update(screenerCoverage)
        .set({ lastScreenedAt: new Date() })
        .where(eq(screenerCoverage.id, prev.id));
      refreshed++;
    } else {
      await db.insert(screenerCoverage).values({
        symbol,
        analyzedAt: null,
        note: `from ${p.screen}`,
      });
      added++;
    }
  }

  let removed = 0;
  for (const symbol of p.removed) {
    const r = await db
      .delete(screenerCoverage)
      .where(eq(screenerCoverage.symbol, symbol))
      .returning();
    removed += r.length;
  }

  const queue = await db
    .select()
    .from(screenerCoverage)
    .where(isNull(screenerCoverage.analyzedAt));

  return {
    ok: true,
    screen: p.screen,
    added,
    refreshed,
    removed,
    universeSize: p.symbols.length,
    awaitingAnalysis: queue.length,
  };
}

async function handleScreenerPass(p: Extract<P, { kind: "screener_pass" }>) {
  let seen = 0;
  for (const s of p.symbols) {
    const [prev] = await db
      .select()
      .from(screenerCoverage)
      .where(eq(screenerCoverage.symbol, s.symbol))
      .limit(1);

    if (prev) {
      await db
        .update(screenerCoverage)
        .set({
          analyzedAt: new Date(),
          distancePct: s.distancePct ?? null,
          nearZone: s.nearZone,
          trend: s.trend ?? null,
          note: s.note ?? null,
          timesScreened: prev.timesScreened + 1,
        })
        .where(eq(screenerCoverage.id, prev.id));
    } else {
      await db.insert(screenerCoverage).values({
        symbol: s.symbol,
        analyzedAt: new Date(),
        distancePct: s.distancePct ?? null,
        nearZone: s.nearZone,
        trend: s.trend ?? null,
        note: s.note ?? null,
      });
    }
    seen++;
  }
  return {
    ok: true,
    recorded: seen,
    nearZone: p.symbols.filter((s) => s.nearZone).length,
  };
}

async function handleCatalysts(p: Extract<P, { kind: "catalysts" }>) {
  if (!p.items.length) return { ok: true, inserted: 0 };
  await db.execute(sql`DELETE FROM catalysts WHERE event_at > NOW()`);
  await db.insert(catalysts).values(
    p.items.map((c) => ({
      symbol: c.symbol,
      kind: c.kind,
      eventAt: c.eventAt,
      note: c.note ?? null,
    })),
  );
  return { ok: true, inserted: p.items.length };
}

async function handleRun(p: Extract<P, { kind: "run" }>) {
  const [r] = await db
    .insert(runs)
    .values({
      agent: p.agent,
      status: p.status,
      degraded: p.degraded,
      notes: p.notes ?? null,
      finishedAt: new Date(),
    })
    .returning();
  return { ok: true, runId: r.id };
}
