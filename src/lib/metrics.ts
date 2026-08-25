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
 *
 * **It is only free if the new stop can survive an ordinary day.** For a long
 * while, this reported any move on any position a cent in profit, which is
 * arithmetic rather than advice. On SSB it recommended raising the stop to
 * 105.64 with price at 105.80 — sixteen cents, against a $1.80 average daily
 * range, and tighter than every one of the previous twenty daily ranges. That
 * stop is hit by noise whether or not the trade is right, and rule 8
 * (`stop_beyond_structure`) says a stop is never tighter than roughly one ADR.
 *
 * So the move is still computed, but it carries whether it is actually safe.
 * A caller with no ADR gets `safe: null` — unknown, which is not the same as
 * yes and must not be rendered as a recommendation.
 */
export type StopMove = {
  /** Where the stop would go. */
  to: number;
  /** Capital-at-risk this removes. */
  removes: number;
  /** How far the new stop sits from the current mark, in ADR. Null when no
   *  ADR is known for the symbol. */
  adrMultiple: number | null;
  /** True only when the new stop clears the noise band. Null = unverifiable. */
  safe: boolean | null;
  reason: string;
};

/** A stop closer to price than this many ADR is inside the noise band. */
export const NOISE_BAND_ADR = 1;

export function freeStopMove(p: {
  side: "long" | "short";
  entry: number;
  stop: number | null;
  mark: number | null;
  qty: number;
  /** 14-day average daily range for the symbol, in dollars. */
  adr?: number | null;
}): StopMove | null {
  const { capitalAtRisk } = positionRisk(p);
  if (!capitalAtRisk || p.mark == null) return null;
  const dir = p.side === "long" ? 1 : -1;
  const inProfit = dir * (p.mark - p.entry) > 0;
  if (!inProfit) return null;

  // Distance the new stop would sit from where price actually is. Breakeven is
  // entry, so this is simply how far price has travelled since entry.
  const gap = Math.abs(p.mark - p.entry);
  const adr = p.adr ?? null;

  if (adr == null || adr <= 0) {
    return {
      to: p.entry,
      removes: capitalAtRisk,
      adrMultiple: null,
      safe: null,
      reason:
        "no ADR known for this symbol, so whether the breakeven stop clears " +
        "the noise band cannot be checked — treat as unverified, not as free",
    };
  }

  const adrMultiple = gap / adr;
  const safe = adrMultiple >= NOISE_BAND_ADR;

  return {
    to: p.entry,
    removes: capitalAtRisk,
    adrMultiple,
    safe,
    reason: safe
      ? `breakeven sits ${adrMultiple.toFixed(2)}x ADR below the mark — outside ` +
        `the noise band, so it removes ${capitalAtRisk.toFixed(2)} without ` +
        `handing the position back to a normal day's movement`
      : `NOT free: breakeven would sit ${gap.toFixed(2)} from the mark, only ` +
        `${adrMultiple.toFixed(2)}x the ${adr.toFixed(2)} average daily range. ` +
        `A stop inside one day's range is hit whether or not the thesis is ` +
        `right — rule 8 says never tighter than roughly one ADR. Price needs ` +
        `to travel further before this move costs nothing`,
  };
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
  /** Signed cash effect of any dividend crossing the hold: negative when a
   *  short pays it. */
  dividendUsd?: number | null;
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

  // A dividend that crossed the hold is realised money like any other. A short
  // held through an ex-date pays it, and leaving it out reports a smaller loss
  // than the account actually took.
  const plUsd =
    entry != null && t.exitActual != null && qty != null
      ? dir * (t.exitActual - entry) * qty - (t.fees ?? 0) + (t.dividendUsd ?? 0)
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
    /**
     * Per-trade edge in dollars. Both rates are measured over closed trades
     * directly: a scratch is neither a win nor a loss, and `1 − winRate`
     * silently counts it as one — which overstates the downside and can
     * bury a real edge. A book with no wins (or no losses) still has an
     * expectancy; only an empty book has none.
     */
    expectancy: n
      ? (wins.length / n) * (avgWin ?? 0) - (losses.length / n) * (avgLoss ?? 0)
      : null,
    maxDrawdown,
  };
}

/**
 * Below this many trades a statistic is noise and the UI greys it out.
 * A 100% win rate on two trades has burned better traders than us.
 */
export const MIN_SAMPLE = 5;

/* ------------------------------------------------------------------ *
 * Dividends at grading time
 * ------------------------------------------------------------------ */

/**
 * What an ex-date inside the expected hold does to a setup.
 *
 * This is a VETO input, not an accounting entry — the accounting is
 * `dividendUsd` on the closed trade. The point of computing it before entry
 * is that a dividend is the rarest thing in this system: a price move whose
 * size and date are both known in advance.
 *
 * The two sides are not symmetric, and treating them the same is the mistake:
 *
 *   SHORT — you PAY it. Straight cash cost. It widens risk and narrows
 *   reward simultaneously, so R:R degrades from both ends. XOM's $1.03/share
 *   was 69% of a $1.48 stop distance: the dividend alone was most of the
 *   risk budget, and the headline 6.45 R:R was really 2.79 after it and the
 *   commission.
 *
 *   LONG — you RECEIVE it, so there is no cash cost. But the price drops by
 *   roughly the dividend on the ex-date, which walks it mechanically toward
 *   your stop for a reason that has nothing to do with order flow. That is a
 *   stop-placement warning, not an R:R adjustment. BIP's $0.455 was 46% of a
 *   $0.99 stop distance — a resting limit there fills on the dividend.
 */
export type DividendImpact = {
  side: "long" | "short";
  /** Dividend as a share of the planned stop distance. The number to look at:
   *  above ~0.25 the ex-date is a material part of the whole risk budget. */
  pctOfStopDistance: number;
  /** Shorts only — R:R after paying it, and after commission. Null for longs,
   *  because a long's total return is not reduced by a dividend it receives. */
  adjustedRR: number | null;
  /** True when the setup needs a decision before the ex-date rather than a
   *  resting order through it. */
  flagged: boolean;
  reason: string;
};

/** Above this share of the stop distance, the ex-date is a material event
 *  rather than a detail. A quarter of the risk budget is the line. */
export const DIVIDEND_FLAG_PCT = 0.25;

export function dividendImpact(p: {
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  qty: number;
  /** Per share, always positive — direction comes from `side`. */
  dividendPerShare: number;
  /** Round-trip commission, if it should be included in the adjusted R:R. */
  fees?: number;
}): DividendImpact {
  const riskPerShare = Math.abs(p.entry - p.stop);
  const rewardPerShare = Math.abs(p.target - p.entry);
  const d = Math.abs(p.dividendPerShare);
  const pctOfStopDistance = riskPerShare > 0 ? d / riskPerShare : Infinity;
  const flagged = pctOfStopDistance >= DIVIDEND_FLAG_PCT;

  if (p.side === "long") {
    return {
      side: "long",
      pctOfStopDistance,
      adjustedRR: null,
      flagged,
      reason: flagged
        ? `ex-date drop of ${d.toFixed(4)}/share is ${(pctOfStopDistance * 100).toFixed(0)}% of the ` +
          `${riskPerShare.toFixed(4)} stop distance — a resting limit at the zone edge fills on the ` +
          `dividend, not on demand. Decide before the ex-date.`
        : `ex-date drop is ${(pctOfStopDistance * 100).toFixed(0)}% of the stop distance — not material.`,
    };
  }

  // Short: paid, so it hits risk and reward at the same time.
  const fees = p.fees ?? 0;
  const riskUsd = riskPerShare * p.qty + d * p.qty + fees;
  const rewardUsd = rewardPerShare * p.qty - d * p.qty - fees;
  return {
    side: "short",
    pctOfStopDistance,
    adjustedRR: riskUsd > 0 ? rewardUsd / riskUsd : null,
    flagged,
    reason: flagged
      ? `short pays ${d.toFixed(4)}/share, ${(pctOfStopDistance * 100).toFixed(0)}% of the ` +
        `${riskPerShare.toFixed(4)} stop distance — it is a cost on both sides of the ratio.`
      : `short pays ${d.toFixed(4)}/share, ${(pctOfStopDistance * 100).toFixed(0)}% of the stop distance.`,
  };
}
