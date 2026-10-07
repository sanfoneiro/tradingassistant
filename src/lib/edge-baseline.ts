/**
 * Does a zone beat NO zone?
 *
 * The trend split compares zones with zones, which can rank them and can never
 * say whether any of them is worth trading. This compares every zone trade
 * with the IDENTICAL order placed where there is no zone — same symbol, same
 * side, same stop width, same 3R target — so the only thing that differs is
 * the claim being tested. Same side matters: a long control against a long
 * zone cancels the drift of the tape, which a pooled comparison cannot.
 *
 *   zone            limit at the proximal edge (zone-backtest's trade)
 *   shifted         same DATE, the level moved 0.25–1.5 ADR off the zone,
 *                   still a resting order. Tests the zone's PRICE.
 *   random_day      a random date within ±30 sessions, the same distance from
 *                   price in ADR. Tests the zone's TIMING.
 *   reject          the method as written: wait for a touch AND a rejection
 *                   close, enter at the next open (rule 4, zone_must_reject)
 *   reject_shifted  the same rule around a shifted box. Tests whether the
 *                   rejection is about the zone or about any level.
 *
 * First run, 2026-10-07, 900 symbols: zone = shifted, reject = reject_shifted,
 * and random_day beat both. See CLAUDE.md, "Does a zone beat no zone?".
 */
import { computeZonesDetailed, classifyTrend, type Bar } from "./zones";
import { rollingRange, TRIGGER_WINDOW, RESOLVE_WINDOW, TARGET_R } from "./zone-backtest";
import { replaySignal, type ReplayResult } from "./replay";
import { deriveQuadrant, type Quadrant } from "./rank";
import { MIN_BARS_FOR_TREND } from "./bars-store";

export type Variant = "zone" | "shifted" | "random_day" | "reject" | "reject_shifted";
export const VARIANTS: Variant[] = ["zone", "shifted", "random_day", "reject", "reject_shifted"];

/** Controls per zone. Five keeps the control's own noise well under the zone's. */
export const CONTROLS_PER_ZONE = 5;
/** How far a random_day control may sit from the zone's own start, in sessions. */
export const DATE_JITTER = 30;
/** The shifted level's distance from the zone edge, in ADR. */
export const SHIFT_MIN_ADR = 0.25;
export const SHIFT_MAX_ADR = 1.5;

export type EdgeTrade = {
  variant: Variant;
  symbol: string;
  side: "long" | "short";
  /** Classified on bars before the trade could start, never on the full series. */
  quadrant: Quadrant | null;
  /** Epoch ms of the fill, or of the first bar searched when it never filled. */
  t: number;
  resolution: ReplayResult["resolution"];
  /** Net R when the target or the stop decided it, else null. */
  r: number | null;
  /** As `r`, plus unresolved trades marked at the close that ends the window. */
  rAllIn: number | null;
};

/** Seeded, so a rerun reproduces its own controls. */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A fixed split of the universe into two halves that never overlap: design on
 * one, confirm on the other. A hash rather than a sorted slice, because a
 * "holdout" built with `order by count(*) ... offset 300` overlapped the first
 * run by 150 of 600 symbols — ties in the count broke differently each time.
 */
export function symbolHalf(symbol: string): "a" | "b" {
  let h = 0x811c9dc5;
  for (let i = 0; i < symbol.length; i++) h = Math.imul(h ^ symbol.charCodeAt(i), 0x01000193);
  return (h >>> 0) % 2 === 0 ? "a" : "b";
}

/**
 * R in units of the PLANNED risk.
 *
 * Replay divides by the risk left after the fill, so a limit that gaps in near
 * its own stop reports a winner as 11R where the money made 3.7R: size is set
 * off the planned stop, and dollars follow the planned stop. Comparing a level
 * that gaps often with one that rarely does on replay's R would rank them by
 * that artefact rather than by what they earned.
 */
export function plannedR(
  res: ReplayResult,
  fwd: Bar[],
  side: "long" | "short",
  plannedRisk: number,
  feeR: number,
  resolveWindow = RESOLVE_WINDOW,
): { r: number | null; rAllIn: number | null } {
  const dir = side === "long" ? 1 : -1;
  if (res.entryPrice == null || !(plannedRisk > 0)) return { r: null, rAllIn: null };
  if ((res.resolution === "hit_target" || res.resolution === "hit_stop") && res.exitPrice != null) {
    const r = (dir * (res.exitPrice - res.entryPrice)) / plannedRisk - feeR;
    return { r, rAllIn: r };
  }
  if (res.resolution === "unresolved" && res.triggerIdx != null) {
    const last = Math.min(fwd.length - 1, res.triggerIdx + resolveWindow);
    return { r: null, rAllIn: (dir * (fwd[last].c - res.entryPrice)) / plannedRisk - feeR };
  }
  // never_triggered, ambiguous, gapped_through, bad_input: no honest number
  return { r: null, rAllIn: null };
}

/**
 * A level near the zone that is still a RESTING order: below price for a long,
 * above it for a short. A level on the wrong side would fill at the next open,
 * which is a market order and a different test. Null when ten draws all land
 * on the wrong side — the zone sits too close to price to shift.
 */
export function shiftLevel(
  side: "long" | "short",
  edge: number,
  adr: number,
  price: number,
  rnd: () => number,
): number | null {
  for (let tries = 0; tries < 10; tries++) {
    const mag = SHIFT_MIN_ADR + rnd() * (SHIFT_MAX_ADR - SHIFT_MIN_ADR);
    const e = edge + (rnd() < 0.5 ? -1 : 1) * mag * adr;
    if (e > 0 && (side === "long" ? e < price : e > price)) return e;
  }
  return null;
}

/**
 * Rule 4 as an entry: price must touch the level AND reject it — a close back
 * beyond the entry or in the far third of the day's range — and the trade is
 * taken at the next open. A close through the distal edge first means the zone
 * broke and there is no trade. The stop goes beyond the distal edge and never
 * tighter than one ADR (rule 8).
 */
export function rejectEntry(
  side: "long" | "short",
  bars: Bar[],
  from: number,
  entry: number,
  distal: number,
  adrAt: number[],
  triggerWindow = TRIGGER_WINDOW,
): { idx: number; entry: number; risk: number } | null {
  const long = side === "long";
  for (let i = from; i < Math.min(bars.length - 1, from + triggerWindow); i++) {
    const b = bars[i];
    if (long ? b.c < distal : b.c > distal) return null;
    if (!(long ? b.l <= entry : b.h >= entry)) continue;
    const range = b.h - b.l;
    const pos = range > 0 ? (b.c - b.l) / range : 0.5;
    const rejected = long ? b.c > entry || pos >= 2 / 3 : b.c < entry || pos <= 1 / 3;
    if (!rejected) continue;
    const e = bars[i + 1].o;
    if (long ? e <= distal : e >= distal) return null; // opened back through the zone
    return { idx: i + 1, entry: e, risk: Math.max(Math.abs(e - distal), adrAt[i]) };
  }
  return null;
}

type Ctx = { symbol: string; bars: Bar[]; feeR: number; quadrant: Quadrant | null; out: EdgeTrade[] };

function trade(
  ctx: Ctx,
  variant: Variant,
  side: "long" | "short",
  startIdx: number,
  entry: number,
  risk: number,
  triggerWindow: number,
) {
  const long = side === "long";
  const fwd = ctx.bars.slice(startIdx);
  const res = replaySignal(
    {
      symbol: ctx.symbol,
      side,
      entryLow: entry,
      entryHigh: entry,
      stop: long ? entry - risk : entry + risk,
      target: long ? entry + TARGET_R * risk : entry - TARGET_R * risk,
    },
    fwd,
    { triggerWindow, resolveWindow: RESOLVE_WINDOW },
  );
  const { r, rAllIn } = plannedR(res, fwd, side, risk, ctx.feeR);
  ctx.out.push({
    variant,
    symbol: ctx.symbol,
    side,
    quadrant: ctx.quadrant,
    t: res.triggerIdx != null ? fwd[res.triggerIdx].t : fwd[0].t,
    resolution: res.resolution,
    r,
    rAllIn,
  });
}

/**
 * Every zone a series produced, each with its controls. The zone trade itself
 * is zone-backtest's: confirmation + 1 is the first bar it may fill on, the
 * ORIGINAL box, and a stop beyond the distal edge floored at one local ADR.
 */
export function edgeTrades(
  symbol: string,
  bars: Bar[],
  opts: { riskBudget: number; fees: number; rnd: () => number; controls?: number },
): EdgeTrade[] {
  const k = opts.controls ?? CONTROLS_PER_ZONE;
  const out: EdgeTrade[] = [];
  const adrAt = rollingRange(bars);
  const { live, broken } = computeZonesDetailed(bars, {
    maxZones: Number.MAX_SAFE_INTEGER,
    updateZones: false,
  });
  const idxOf = new Map(bars.map((b, i) => [b.t, i]));

  for (const z of [...live, ...broken.map((b) => b.zone)]) {
    const ci = idxOf.get(z.createdAt);
    if (ci == null) continue;
    const confirmIdx = ci + 2;
    const from = confirmIdx + 1;
    if (from >= bars.length - 1) continue;

    const side: "long" | "short" = z.direction === "demand" ? "long" : "short";
    const long = side === "long";
    const adr = adrAt[confirmIdx];
    const risk = Math.max(Math.abs(z.entry - z.sl), adr);
    if (!(risk > 0) || !(adr > 0)) continue;

    const quadrant =
      from >= MIN_BARS_FOR_TREND
        ? deriveQuadrant(classifyTrend(bars.slice(0, from)).trend, z.direction)
        : null;
    const ctx: Ctx = { symbol, bars, feeR: opts.fees / opts.riskBudget, quadrant, out };
    const price = bars[confirmIdx].c;

    trade(ctx, "zone", side, from, z.entry, risk, TRIGGER_WINDOW);
    const rj = rejectEntry(side, bars, from, z.entry, z.sl, adrAt);
    if (rj) trade(ctx, "reject", side, rj.idx, rj.entry, rj.risk, 1);

    const distAdr = Math.abs(price - z.entry) / adr;
    const riskAdr = risk / adr;
    const height = z.entry - z.sl; // signed: positive for demand
    for (let n = 0; n < k; n++) {
      const shifted = shiftLevel(side, z.entry, adr, price, opts.rnd);
      if (shifted != null) {
        trade(ctx, "shifted", side, from, shifted, risk, TRIGGER_WINDOW);
        const distal = shifted - height;
        if (distal > 0) {
          const sr = rejectEntry(side, bars, from, shifted, distal, adrAt);
          if (sr) trade(ctx, "reject_shifted", side, sr.idx, sr.entry, sr.risk, 1);
        }
      }
      const j = Math.max(
        21,
        Math.min(bars.length - 2, from + Math.round((opts.rnd() * 2 - 1) * DATE_JITTER)),
      );
      const a = adrAt[j - 1];
      const e = long ? bars[j - 1].c - distAdr * a : bars[j - 1].c + distAdr * a;
      if (e > 0 && a > 0) trade(ctx, "random_day", side, j, e, riskAdr * a, TRIGGER_WINDOW);
    }
  }
  return out;
}

export type EdgeSummary = {
  decided: number;
  winRate: number | null;
  avgR: number | null;
  allIn: number;
  avgRAllIn: number | null;
};

export function summariseEdge(ts: EdgeTrade[]): EdgeSummary {
  const decided = ts.filter((t) => t.resolution === "hit_target" || t.resolution === "hit_stop");
  const wins = decided.filter((t) => t.resolution === "hit_target").length;
  const allIn = ts.filter((t) => t.rAllIn != null);
  return {
    decided: decided.length,
    winRate: decided.length ? wins / decided.length : null,
    avgR: decided.length ? decided.reduce((s, t) => s + t.r!, 0) / decided.length : null,
    allIn: allIn.length,
    avgRAllIn: allIn.length ? allIn.reduce((s, t) => s + t.rAllIn!, 0) / allIn.length : null,
  };
}

/**
 * The difference between two variants with a 95% interval from resampling
 * SYMBOLS, not trades: one name's zones share its tape, so treating them as
 * independent would make the interval look far tighter than it is.
 */
export function bootstrapDiff(
  ts: EdgeTrade[],
  a: Variant,
  b: Variant,
  rnd: () => number,
  iterations = 2000,
): { winPp: [number, number]; rAllIn: [number, number] } | null {
  type Acc = { w: number; d: number; r: number; n: number };
  const by = new Map<string, Record<string, Acc>>();
  for (const t of ts) {
    if (t.variant !== a && t.variant !== b) continue;
    const m = by.get(t.symbol) ?? {};
    const acc = (m[t.variant] ??= { w: 0, d: 0, r: 0, n: 0 });
    if (t.resolution === "hit_target" || t.resolution === "hit_stop") {
      acc.d++;
      if (t.resolution === "hit_target") acc.w++;
    }
    if (t.rAllIn != null) {
      acc.r += t.rAllIn;
      acc.n++;
    }
    by.set(t.symbol, m);
  }
  const syms = [...by.keys()];
  if (syms.length < 2) return null;
  const dW: number[] = [];
  const dR: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const A: Acc = { w: 0, d: 0, r: 0, n: 0 };
    const B: Acc = { w: 0, d: 0, r: 0, n: 0 };
    for (let i = 0; i < syms.length; i++) {
      const m = by.get(syms[Math.floor(rnd() * syms.length)])!;
      for (const [acc, v] of [[A, a], [B, b]] as const) {
        const x = m[v];
        if (x) {
          acc.w += x.w;
          acc.d += x.d;
          acc.r += x.r;
          acc.n += x.n;
        }
      }
    }
    if (!A.d || !B.d || !A.n || !B.n) continue;
    dW.push(100 * (A.w / A.d - B.w / B.d));
    dR.push(A.r / A.n - B.r / B.n);
  }
  if (dW.length < iterations / 2) return null;
  const ci = (xs: number[]): [number, number] => {
    const s = [...xs].sort((p, q) => p - q);
    return [s[Math.floor(0.025 * (s.length - 1))], s[Math.ceil(0.975 * (s.length - 1))]];
  };
  return { winPp: ci(dW), rAllIn: ci(dR) };
}
