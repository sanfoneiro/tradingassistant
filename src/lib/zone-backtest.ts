/**
 * Replaying every zone a name ever produced, as the trade it implies.
 *
 * Shared by the shortlist screen and the trend split so there is ONE
 * definition of what a zone trade is. Two copies of this arithmetic would
 * drift, and a sign error in one of them would invert the answer while still
 * printing a confident table.
 *
 * The trade: enter at the proximal edge, stop beyond the distal edge and
 * never tighter than one local ADR (rule 8), target 3R gross — because a
 * gross-exactly-2R target can never be net 2:1 at any size.
 *
 * Three things this is careful about, each of which was got wrong first:
 *
 *   - **Look-ahead in the fill.** A zone's `createdAt` is the CANDIDATE bar,
 *     two bars before the imbalance is confirmed. Replaying from there lets a
 *     zone fill on the very bars that formed it. Replay starts at
 *     confirmation + 1.
 *   - **Look-ahead in the trend.** The quadrant is classified on bars up to
 *     and including the confirming bar, never on the full series.
 *   - **A stale volatility floor.** Rule 8's ADR must be the volatility that
 *     existed when the zone did. Applying today's dollar ADR to a zone from
 *     two years ago gave MU a 33.9% stop and moved its result by 34R.
 */
import { computeZonesDetailed, classifyTrend, type Bar, type Zone, type Trend } from "./zones";
import { deriveQuadrant, type Quadrant } from "./rank";
import { replaySignal, type ReplayResult, type Signal } from "./replay";
import { MIN_BARS_FOR_TREND } from "./bars-store";

/** Sessions price has to come back to the level before the idea is abandoned.
 *  Longer than replay's default of 10, because a wishlist entry legitimately
 *  waits — `triggeredAt` exists so "at its level since Tuesday" is answerable. */
export const TRIGGER_WINDOW = 60;
/** Sessions after filling to reach target or stop. A days-to-weeks hold, and
 *  a B-grade's time stop is 8-10, so twenty is generous rather than tight. */
export const RESOLVE_WINDOW = 20;
export const TARGET_R = 3;
export const FEES = 4;
const ADR_FLOOR_LOOKBACK = 20;

export type ZoneTrade = {
  symbol: string;
  direction: "demand" | "supply";
  side: "long" | "short";
  /** Classified on bars up to the CONFIRMING bar only. Null when there is not
   *  enough history to run a 200-EMA, which is a different answer from
   *  `contested` and must not be folded into it. */
  trend: Trend | null;
  quadrant: Quadrant | null;
  /** Stop distance as a percentage of entry, after the rule 8 floor. */
  riskPct: number;
  result: ReplayResult;
};

/**
 * A rolling range floor in dollars, at each bar. This is the rule 8 minimum
 * stop, evaluated locally rather than once at the end of the series.
 */
export function rollingRange(bars: Bar[], lookback = ADR_FLOOR_LOOKBACK): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += (bars[i].h - bars[i].l) / bars[i].c;
    if (i >= lookback) {
      const old = bars[i - lookback];
      sum -= (old.h - old.l) / old.c;
    }
    out.push((sum / Math.min(i + 1, lookback)) * bars[i].c);
  }
  return out;
}

/**
 * The trade a zone implies. Demand is a long entered at the box top with the
 * stop below; supply is a short entered at the box bottom with the stop
 * above. Both directions are tested, because a long-only check passes happily
 * while every short is inverted.
 */
export function signalFor(
  z: Zone,
  adrDollars: number,
  targetR = TARGET_R,
): { signal: Signal; riskPct: number } | null {
  const long = z.direction === "demand";
  const entry = z.entry;
  const risk = Math.max(Math.abs(entry - z.sl), adrDollars);
  if (!(risk > 0) || !(entry > 0) || !Number.isFinite(risk)) return null;
  return {
    signal: {
      symbol: "",
      side: long ? "long" : "short",
      entryLow: entry,
      entryHigh: entry,
      stop: long ? entry - risk : entry + risk,
      target: long ? entry + targetR * risk : entry - targetR * risk,
    },
    riskPct: (risk / entry) * 100,
  };
}

export function replayZones(
  symbol: string,
  bars: Bar[],
  opts: { riskBudget: number; targetR?: number; classifyTrends?: boolean },
): ZoneTrade[] {
  const targetR = opts.targetR ?? TARGET_R;
  const rangeAt = rollingRange(bars);
  const { live, broken } = computeZonesDetailed(bars, {
    maxZones: Number.MAX_SAFE_INTEGER,
    // The ORIGINAL box. A shrunken proximal edge is hindsight: at the moment
    // the zone formed, nothing had penetrated it yet.
    updateZones: false,
  });
  const zones = [...live, ...broken.map((b) => b.zone)];
  const idxOf = new Map(bars.map((b, i) => [b.t, i]));

  const out: ZoneTrade[] = [];
  for (const z of zones) {
    const ci = idxOf.get(z.createdAt);
    if (ci == null) continue;
    const confirmIdx = ci + 2;
    const from = confirmIdx + 1;
    if (from >= bars.length) continue;

    const s = signalFor(z, rangeAt[confirmIdx], targetR);
    if (!s) continue;

    let trend: Trend | null = null;
    if (opts.classifyTrends) {
      const history = bars.slice(0, from);
      // Below the 200-EMA's requirement classifyTrend returns `contested` for
      // want of data, which is NOT the same claim as "the trend is contested".
      trend = history.length >= MIN_BARS_FOR_TREND
        ? classifyTrend(history).trend
        : null;
    }

    out.push({
      symbol,
      direction: z.direction,
      side: s.signal.side,
      trend,
      quadrant: trend ? deriveQuadrant(trend, z.direction) : null,
      riskPct: s.riskPct,
      result: replaySignal({ ...s.signal, symbol }, bars.slice(from), {
        triggerWindow: TRIGGER_WINDOW,
        resolveWindow: RESOLVE_WINDOW,
        fees: FEES,
        riskBudget: opts.riskBudget,
      }),
    });
  }
  return out;
}

/** Two-proportion z-test. Positive z means `a` wins more often than `b`. */
export function compareRates(
  a: { wins: number; losses: number },
  b: { wins: number; losses: number },
) {
  const na = a.wins + a.losses;
  const nb = b.wins + b.losses;
  if (!na || !nb) return null;
  const pa = a.wins / na;
  const pb = b.wins / nb;
  const pooled = (a.wins + b.wins) / (na + nb);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb));
  return se ? { pa, pb, diff: pa - pb, z: (pa - pb) / se, na, nb } : null;
}
