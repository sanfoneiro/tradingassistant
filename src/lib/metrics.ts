/**
 * Every cross-trade comparison in this app is in R, never in dollars.
 * A $400 loss on a $2,000 position and a $400 loss on a $400 position
 * are different mistakes; only R tells them apart.
 */

export type TradeLike = {
  side: "long" | "short";
  entryPlanned: number | null;
  stopPlanned: number | null;
  targetPlanned: number | null;
  entryActual: number | null;
  exitActual: number | null;
  qty: number | null;
  fees: number | null;
  plUsd: number | null;
  rMultiple: number | null;
  mfeR: number | null;
  maeR: number | null;
  openedAt: Date | null;
  closedAt: Date | null;
};

export function riskPerShare(entry: number, stop: number) {
  return Math.abs(entry - stop);
}

/**
 * The three risk numbers for an open position. They are not
 * interchangeable and conflating them produces confidently wrong advice.
 *
 *   capitalAtRisk  what is actually lost if the stop fills, from entry.
 *                  Zero when the stop is past breakeven. This is what a
 *                  move-to-breakeven removes.
 *   riskFromMark   what equity drops by if the stop fills today, from the
 *                  current mark. The number today's decision hangs on.
 *   lockedGain     profit guaranteed even if the stop fills. Positive
 *                  means the position cannot lose.
 *
 * Worked example — a long at 690.98 with the stop raised to 707.37:
 * capitalAtRisk 0, lockedGain +$49, riskFromMark $70 of giveback. Taking
 * |entry − stop| instead would report $49 of "risk" on a position that is
 * incapable of losing money.
 */
export function positionRisk(p: {
  side: "long" | "short";
  entry: number;
  stop: number | null;
  mark: number | null;
  qty: number;
}) {
  if (p.stop == null) {
    // No stop is not zero risk — it is unbounded and unknowable. Say so
    // with null rather than implying safety with a 0.
    return { capitalAtRisk: null, riskFromMark: null, lockedGain: null };
  }
  const dir = p.side === "long" ? 1 : -1;

  // Signed distance from entry to stop, in the direction that loses money.
  const adverse = dir * (p.entry - p.stop);

  const capitalAtRisk = Math.max(0, adverse) * p.qty;
  const lockedGain = Math.max(0, -adverse) * p.qty;

  const riskFromMark =
    p.mark == null ? null : Math.max(0, dir * (p.mark - p.stop)) * p.qty;

  return { capitalAtRisk, riskFromMark, lockedGain };
}

/**
 * A free stop move: the position is in profit and the stop is still on the
 * losing side of entry, so moving it to breakeven converts a possible loss
 * into a guaranteed non-loss at zero cost.
 *
 * Direction matters and is easy to invert. LONG: breakeven is entry, a stop
 * BELOW entry is the losing side, move it UP. SHORT: breakeven is entry, a
 * stop ABOVE entry is the losing side, move it DOWN.
 */
export function freeStopMove(p: {
  side: "long" | "short";
  entry: number;
  stop: number | null;
  mark: number | null;
  qty: number;
}) {
  const { capitalAtRisk } = positionRisk(p);
  if (!capitalAtRisk || p.mark == null) return null;
  const dir = p.side === "long" ? 1 : -1;
  const inProfit = dir * (p.mark - p.entry) > 0;
  if (!inProfit) return null;
  return { to: p.entry, removes: capitalAtRisk };
}

export function computeDerived(t: {
  side: "long" | "short";
  entryPlanned?: number | null;
  stopPlanned?: number | null;
  targetPlanned?: number | null;
  entryActual?: number | null;
  exitActual?: number | null;
  qty?: number | null;
  fees?: number | null;
  mfePrice?: number | null;
  maePrice?: number | null;
  openedAt?: Date | null;
  closedAt?: Date | null;
}) {
  const dir = t.side === "long" ? 1 : -1;
  const entry = t.entryActual ?? t.entryPlanned ?? null;
  const stop = t.stopPlanned ?? null;
  const qty = t.qty ?? null;

  const rps = entry != null && stop != null ? riskPerShare(entry, stop) : null;
  const initialRisk = rps != null && qty != null ? rps * qty : null;

  const plUsd =
    entry != null && t.exitActual != null && qty != null
      ? dir * (t.exitActual - entry) * qty - (t.fees ?? 0)
      : null;

  const plPct =
    entry != null && t.exitActual != null
      ? ((dir * (t.exitActual - entry)) / entry) * 100
      : null;

  const rMultiple =
    plUsd != null && initialRisk != null && initialRisk > 0
      ? plUsd / initialRisk
      : null;

  const rrPlanned =
    t.entryPlanned != null && t.stopPlanned != null && t.targetPlanned != null
      ? Math.abs(t.targetPlanned - t.entryPlanned) /
        Math.abs(t.entryPlanned - t.stopPlanned)
      : null;

  const rrActual =
    entry != null && t.exitActual != null && rps != null && rps > 0
      ? Math.abs(t.exitActual - entry) / rps
      : null;

  // Slippage in R: how much the actual entry/exit cost versus the plan.
  const slippageEntryR =
    t.entryActual != null && t.entryPlanned != null && rps != null && rps > 0
      ? (dir * (t.entryActual - t.entryPlanned)) / rps
      : null;

  const slippageExitR =
    t.exitActual != null && t.targetPlanned != null && rps != null && rps > 0
      ? (dir * (t.exitActual - t.targetPlanned)) / rps
      : null;

  // Excursions, in R. Captured live while the trade is open — these
  // cannot be reconstructed from entry and exit alone.
  const mfeR =
    t.mfePrice != null && entry != null && rps != null && rps > 0
      ? (dir * (t.mfePrice - entry)) / rps
      : null;

  const maeR =
    t.maePrice != null && entry != null && rps != null && rps > 0
      ? (dir * (t.maePrice - entry)) / rps
      : null;

  // How much of the move that was actually on offer did we take home?
  const efficiency =
    plUsd != null && mfeR != null && mfeR > 0 && initialRisk != null
      ? plUsd / (mfeR * initialRisk)
      : null;

  const holdDays =
    t.openedAt && t.closedAt
      ? (t.closedAt.getTime() - t.openedAt.getTime()) / 86400000
      : null;

  return {
    plUsd,
    plPct,
    rMultiple,
    rrPlanned,
    rrActual,
    slippageEntryR,
    slippageExitR,
    mfeR,
    maeR,
    efficiency,
    holdDays,
    initialRisk,
    dayOfWeek: t.openedAt ? t.openedAt.getUTCDay() : null,
  };
}

/* ---------------- aggregate stats ---------------- */

export type Stats = {
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  avgR: number | null;
  expectancy: number | null;
  maxDrawdown: number;
};

export function stats(rows: { plUsd: number | null; rMultiple: number | null }[]): Stats {
  const closed = rows.filter((r) => r.plUsd != null);
  const n = closed.length;
  const wins = closed.filter((r) => (r.plUsd ?? 0) > 0);
  const losses = closed.filter((r) => (r.plUsd ?? 0) < 0);

  const grossProfit = wins.reduce((a, r) => a + (r.plUsd ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((a, r) => a + (r.plUsd ?? 0), 0));
  const netPl = grossProfit - grossLoss;

  const rs = closed.map((r) => r.rMultiple).filter((r): r is number => r != null);

  // Peak-to-trough on the cumulative curve, in the order given.
  let peak = 0;
  let cum = 0;
  let maxDrawdown = 0;
  for (const r of closed) {
    cum += r.plUsd ?? 0;
    peak = Math.max(peak, cum);
    maxDrawdown = Math.max(maxDrawdown, peak - cum);
  }

  const winRate = n ? (wins.length / n) * 100 : null;
  const avgWin = wins.length ? grossProfit / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;

  return {
    n,
    wins: wins.length,
    losses: losses.length,
    winRate,
    netPl,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgWin,
    avgLoss,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    expectancy:
      winRate != null && avgWin != null && avgLoss != null
        ? (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss
        : null,
    maxDrawdown,
  };
}

/**
 * Below this many trades a statistic is noise and the UI greys it out.
 * A 100% win rate on two trades has burned better traders than us.
 */
export const MIN_SAMPLE = 5;
