/**
 * The zone engine — a faithful port of the MTF Supply & Demand / Order
 * Blocks v3 Pine indicator, with the drawing stripped out.
 *
 * Why this exists rather than reading the numbers off a chart: Pine runs on
 * one symbol at a time and its output lives in the rendered chart, so every
 * level currently reaches the database by being transcribed out of a
 * screenshot. That is the one step in the pipeline with no verification.
 * The detection itself is fifteen lines of arithmetic over OHLC, so running
 * it over API bars gives the same zones for the whole universe, in one job,
 * with no reading involved.
 *
 * The indicator remains the oracle. `describe("agrees with the indicator")`
 * in zones.test.ts asserts this reproduces its table.
 *
 * Ported from the v3 source with defaults: Wick for all four draw/create
 * modes, updateZones on, deleteBrk on, maxZones/maxLines 12.
 */

export type Bar = {
  /** Epoch ms of the bar's open. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type Zone = {
  direction: "demand" | "supply";
  /** Box edges. `top` for demand and `bottom` for supply move as price
   *  penetrates — see `updateZones` below. */
  top: number;
  bottom: number;
  /** Proximal edge: where you enter. */
  entry: number;
  /** Midpoint of entry and stop. */
  mid: number;
  /** Distal edge: where the zone is wrong. */
  sl: number;
  /** Open time of the order-block candle. Identity, and the sort key for
   *  "newest first". */
  createdAt: number;
  /** Price has traded into it. NOT the same as broken — most good zones are
   *  mitigated. The indicator calls this Mitigated vs Fresh. */
  mitigated: boolean;
  /** Price has reached the 50% line. */
  fiftyReached: boolean;
};

export type ZoneOptions = {
  /** Zones are dropped once this many newer ones exist. Indicator default 12. */
  maxZones?: number;
  /** Shrink a zone's proximal edge to the deepest penetration price has made
   *  into it. On by default in the indicator, and the reason a mitigated
   *  zone's entry no longer sits at the original candle extreme. */
  updateZones?: boolean;
  /** Delete a zone once price CLOSES through its distal edge. A wick through
   *  does not count. */
  deleteBroken?: boolean;
};

/**
 * A three-bar imbalance. The candidate is `bars[i - 2]`; `bars[i]` confirms
 * that price gapped clean away from it, leaving unfilled orders behind.
 *
 *   demand — the candidate closed down, and the confirming bar's LOW sits
 *            entirely above the candidate's HIGH
 *   supply — the candidate closed up, and the confirming bar's HIGH sits
 *            entirely below the candidate's LOW
 */
function detect(candidate: Bar, confirm: Bar) {
  const isDemand = candidate.c < candidate.o && confirm.l > candidate.h;
  const isSupply = candidate.c > candidate.o && confirm.h < candidate.l;
  return { isDemand, isSupply };
}

function refresh(z: Zone) {
  z.entry = z.direction === "demand" ? z.top : z.bottom;
  z.sl = z.direction === "demand" ? z.bottom : z.top;
  z.mid = (z.top + z.bottom) / 2;
}

/** One bar of maintenance over the live set. Mirrors the indicator's
 *  `maintain()`, including the order of the checks — mitigation is tested
 *  before the edge is shrunk, which changes the answer on the bar that first
 *  enters a zone. */
function maintain(zones: Zone[], bar: Bar, opts: Required<ZoneOptions>) {
  for (let i = zones.length - 1; i >= 0; i--) {
    const z = zones[i];

    // Broken: a CLOSE through the distal edge, not merely a wick.
    if (
      opts.deleteBroken &&
      (z.direction === "demand" ? bar.c < z.bottom : bar.c > z.top)
    ) {
      zones.splice(i, 1);
      continue;
    }

    if (
      !z.mitigated &&
      (z.direction === "demand" ? bar.l <= z.top : bar.h >= z.bottom)
    ) {
      z.mitigated = true;
    }

    if (opts.updateZones) {
      if (z.direction === "demand" && bar.l < z.top && bar.l > z.bottom) {
        z.top = bar.l;
      }
      if (z.direction === "supply" && bar.h > z.bottom && bar.h < z.top) {
        z.bottom = bar.h;
      }
      refresh(z);
    }

    if (
      !z.fiftyReached &&
      (z.direction === "demand" ? bar.l <= z.mid : bar.h >= z.mid)
    ) {
      z.fiftyReached = true;
    }
  }

  // The indicator frees a zone's drawings once `maxZones` newer ones exist,
  // and drops it from the array when nothing is left to draw. Headless, that
  // is simply a cap on the most recently created.
  if (zones.length > opts.maxZones) zones.splice(0, zones.length - opts.maxZones);
}

/**
 * Run the indicator over a series and return the zones still live at the
 * last bar, newest first. Bars must be chronological and gap-free for the
 * timeframe.
 */
export function computeZones(bars: Bar[], options: ZoneOptions = {}): Zone[] {
  const opts: Required<ZoneOptions> = {
    maxZones: options.maxZones ?? 12,
    updateZones: options.updateZones ?? true,
    deleteBroken: options.deleteBroken ?? true,
  };

  const zones: Zone[] = [];
  let lastCreatedAt: number | null = null;

  for (let i = 0; i < bars.length; i++) {
    if (i >= 2) {
      const candidate = bars[i - 2];
      const { isDemand, isSupply } = detect(candidate, bars[i]);

      // The indicator guards on the candidate's timestamp, so a run of
      // confirming bars produces one zone, not one per bar.
      if ((isDemand || isSupply) && candidate.t !== lastCreatedAt) {
        lastCreatedAt = candidate.t;
        const z: Zone = {
          direction: isDemand ? "demand" : "supply",
          top: candidate.h,
          bottom: candidate.l,
          entry: 0,
          mid: 0,
          sl: 0,
          createdAt: candidate.t,
          mitigated: false,
          fiftyReached: false,
        };
        refresh(z);
        zones.push(z);
      }
    }

    maintain(zones, bars[i], opts);
  }

  return [...zones].sort((a, b) => b.createdAt - a.createdAt);
}

/** Signed distance from price to the zone's entry, as a percentage.
 *  Negative means the zone sits below price. Matches the Dist % column. */
export function distancePct(entry: number, price: number): number {
  return ((entry - price) / price) * 100;
}

/**
 * The indicator's own table: nearest zones first, capped at `rows`.
 * Reproducing the ordering matters because it is what makes the on-chart
 * table directly comparable to this output.
 */
export function zoneTable(zones: Zone[], price: number, rows = 8): Zone[] {
  return [...zones]
    .sort((a, b) => Math.abs(price - a.entry) - Math.abs(price - b.entry))
    .slice(0, rows);
}

/**
 * Exponential moving average of closes, aligned to `bars`. Entries before
 * the average has enough data to mean anything are null rather than a
 * short-window approximation — a 200 EMA computed off 40 bars is a
 * different statistic wearing the same name.
 */
export function ema(bars: Bar[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let prev: number | null = null;

  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].c;
    prev = prev === null ? c : c * k + prev * (1 - k);
    out.push(i + 1 >= period ? prev : null);
  }
  return out;
}

export type Trend = "uptrend" | "downtrend" | "contested";

/**
 * The trend half of the quadrant model. Price above a rising average is an
 * uptrend; below a falling one is a downtrend. When the two disagree there
 * is no trend to trade with — which is exactly what the schema's
 * `contested` means, and why it is a distinct answer rather than a coin
 * flip between the other two.
 *
 * `lookback` is how far back the slope is measured, in bars.
 */
export function classifyTrend(
  bars: Bar[],
  period = 200,
  lookback = 20,
): { trend: Trend; ma: number | null } {
  const line = ema(bars, period);
  const ma = line.at(-1) ?? null;
  const past = line.at(-1 - lookback) ?? null;
  const price = bars.at(-1)?.c;

  if (ma === null || past === null || price === undefined) {
    return { trend: "contested", ma };
  }

  const above = price > ma;
  const rising = ma > past;

  if (above && rising) return { trend: "uptrend", ma };
  if (!above && !rising) return { trend: "downtrend", ma };
  return { trend: "contested", ma };
}

/**
 * Roll daily bars into weekly ones, so a single daily pull covers both
 * timeframes. Weeks start Monday; a partial trailing week is kept, matching
 * a live chart's forming candle.
 */
export function toWeekly(daily: Bar[]): Bar[] {
  const weeks = new Map<number, Bar>();

  for (const b of daily) {
    const d = new Date(b.t);
    // Monday 00:00 UTC of this bar's week.
    const dow = (d.getUTCDay() + 6) % 7;
    const monday = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() - dow,
    );

    const w = weeks.get(monday);
    if (!w) {
      weeks.set(monday, { t: monday, o: b.o, h: b.h, l: b.l, c: b.c });
    } else {
      w.h = Math.max(w.h, b.h);
      w.l = Math.min(w.l, b.l);
      w.c = b.c;
    }
  }

  return [...weeks.values()].sort((a, b) => a.t - b.t);
}
