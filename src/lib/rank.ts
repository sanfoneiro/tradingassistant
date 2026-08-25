/**
 * Ranking what to look at first.
 *
 * With ~11 zones a name, price is within the trigger band of *some* level
 * almost by accident — 47 names arrived at a trigger in two days, which is a
 * list nobody works through. An unrankable list is as useless as an empty one.
 *
 * This does NOT grade. It cannot: the decisive question in the grader is what
 * drove price into the zone, and whether the zone has actually rejected —
 * neither is knowable from stored structure. Fundamentals are a veto and live
 * outside the database entirely. What this does is order the queue so the
 * grader's attention lands on the few candidates whose STRUCTURE is worth the
 * cost of looking.
 *
 * Every weight below is a hypothesis, not a finding. The Method report exists
 * to check them: if with-trend candidates are not out-earning countertrend
 * ones once there are closed trades, this scoring was wrong and should change.
 * `scoreReasons` is stored alongside the number so a later review can ask what
 * the score was actually claiming.
 */

export type Trend = "uptrend" | "downtrend" | "contested";
export type ZoneDirection = "demand" | "supply";
export type Quadrant =
  | "up_demand"
  | "up_supply"
  | "down_supply"
  | "down_demand"
  | "contested";

/**
 * The quadrant model, which is the one thing here that is not a guess: a zone
 * only means what it means relative to the trend it sits in. Demand in an
 * uptrend is with-trend and strong; demand in a downtrend is a falling knife
 * wearing the same shape.
 */
export function deriveQuadrant(
  trend: Trend | null | undefined,
  direction: ZoneDirection,
): Quadrant {
  if (trend === "uptrend") return direction === "demand" ? "up_demand" : "up_supply";
  if (trend === "downtrend") return direction === "supply" ? "down_supply" : "down_demand";
  return "contested";
}

/** The two quadrants the method is actually built on. */
export function isWithTrend(q: Quadrant): boolean {
  return q === "up_demand" || q === "down_supply";
}

export type Candidate = {
  quadrant: Quadrant;
  timeframe: "1D" | "1W";
  /** The indicator's own read. "Fresh" = price has never traded into it. */
  fresh: boolean;
  /** A zone on the OTHER timeframe covering the same price. */
  confluence: boolean;
  /** Signed distance from price to the level, in percent. */
  distancePct: number;
};

export type Score = { score: number; reasons: string[] };

/**
 * Weights. Additive, roughly out of 100, and deliberately coarse — a model
 * precise enough to look authoritative would invite trusting it.
 *
 * They are chosen so two properties hold by construction, because both are
 * claims the method actually makes rather than knobs to tune:
 *
 *   1. The worst with-trend setup (50 + 4 + 4 ≈ 58) outranks the best
 *      countertrend one (5 + 20 + 12 + 12 + 4 = 53). Trend is not one factor
 *      among several; it decides the order.
 *   2. The best contested setup (0 + 20 + 12 + 12 + 4 = 48) sits below the
 *      cutoff. When price and the average disagree there is no trend to trade
 *      with, and no amount of structure substitutes for one.
 *
 * Change a weight and re-check both — the tests assert them.
 */
const W = {
  withTrend: 50,
  countertrend: 5,
  confluence: 20,
  weekly: 12,
  daily: 4,
  fresh: 12,
  mitigated: 4,
  /** Proximity is worth little: everything here is already inside the band. */
  proximityMax: 4,
};

export function scoreCandidate(c: Candidate): Score {
  const reasons: string[] = [];
  let score = 0;

  if (isWithTrend(c.quadrant)) {
    score += W.withTrend;
    reasons.push(`with-trend (${c.quadrant})`);
  } else if (c.quadrant === "contested") {
    reasons.push("no trend — price and average disagree");
  } else {
    score += W.countertrend;
    reasons.push(`countertrend (${c.quadrant})`);
  }

  if (c.confluence) {
    score += W.confluence;
    reasons.push("daily and weekly agree at this price");
  }

  if (c.timeframe === "1W") {
    score += W.weekly;
    reasons.push("weekly level");
  } else {
    score += W.daily;
  }

  if (c.fresh) {
    score += W.fresh;
    reasons.push("fresh — never traded into");
  } else {
    score += W.mitigated;
  }

  // Linear from full marks at the level to nothing at 2% away.
  const near = Math.max(0, 1 - Math.abs(c.distancePct) / 2);
  score += near * W.proximityMax;

  return { score: Math.round(score * 10) / 10, reasons };
}

/**
 * Do two levels describe the same price? Used to spot a daily zone sitting on
 * top of a weekly one, which is the confluence the Method report is meant to
 * test. Compared as a percentage so it works at $3 and at $700.
 */
export function overlaps(a: number, b: number, tolerancePct = 1): boolean {
  if (a <= 0 || b <= 0) return false;
  return (Math.abs(a - b) / ((a + b) / 2)) * 100 <= tolerancePct;
}

/** Below this a candidate is structure-by-accident, not a setup worth opening
 *  a chart for. A with-trend weekly zone clears it on its own; a countertrend
 *  mitigated daily zone never does. */
export const WORTH_OPENING_A_CHART = 50;
