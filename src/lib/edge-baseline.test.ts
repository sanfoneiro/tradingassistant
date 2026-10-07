import { describe, it, expect } from "vitest";
import {
  plannedR,
  shiftLevel,
  rejectEntry,
  symbolHalf,
  edgeTrades,
  bootstrapDiff,
  mulberry32,
  SHIFT_MIN_ADR,
  SHIFT_MAX_ADR,
  type EdgeTrade,
} from "./edge-baseline";
import { replaySignal, type Bar } from "./replay";
import { replayZones } from "./zone-backtest";

/**
 * Both directions, always — and every artefact asserted to EXIST before the
 * fix for it is asserted to work, so none of these can pass on a fixture that
 * never exercised the case.
 */

const bar = (o: number, h: number, l: number, c: number, t = 0): Bar => ({ t, o, h, l, c });
const FEE_R = 4 / 75;

describe("plannedR — dollars follow the PLANNED stop", () => {
  it("does not let a gap fill near the stop inflate a long winner", () => {
    // Limit at 100, stop 97, target 109. Opens at 98: fills at 98, a point
    // above the stop, then runs to the target.
    const bars = [bar(98, 99, 97.5, 98.5), bar(99, 110, 98.5, 109.5)];
    const res = replaySignal(
      { symbol: "X", side: "long", entryLow: 100, entryHigh: 100, stop: 97, target: 109 },
      bars,
    );
    expect(res.resolution).toBe("hit_target");
    expect(res.rGross).toBeCloseTo(11, 9); // the artefact is real
    const { r, rAllIn } = plannedR(res, bars, "long", 3, FEE_R);
    expect(r).toBeCloseTo(11 / 3 - FEE_R, 9);
    expect(rAllIn).toBe(r);
  });

  it("does the same for a short that gaps up into its entry", () => {
    const bars = [bar(102, 102.5, 101, 101.5), bar(101, 101.5, 90, 90.5)];
    const res = replaySignal(
      { symbol: "X", side: "short", entryLow: 100, entryHigh: 100, stop: 103, target: 91 },
      bars,
    );
    expect(res.resolution).toBe("hit_target");
    expect(res.rGross).toBeCloseTo(11, 9);
    expect(plannedR(res, bars, "short", 3, FEE_R).r).toBeCloseTo(11 / 3 - FEE_R, 9);
  });

  it("marks an unresolved trade at the close that ends the window, signed by side", () => {
    const bars = [bar(100, 100.5, 99.5, 100), bar(100, 101, 99.8, 100.9), bar(101, 101.6, 100.7, 101.5)];
    const long = replaySignal(
      { symbol: "X", side: "long", entryLow: 100, entryHigh: 100, stop: 97, target: 109 },
      bars,
      { resolveWindow: 2 },
    );
    expect(long.resolution).toBe("unresolved");
    const l = plannedR(long, bars, "long", 3, FEE_R, 2);
    expect(l.r).toBeNull();
    expect(l.rAllIn).toBeCloseTo(1.5 / 3 - FEE_R, 9);

    const short = replaySignal(
      { symbol: "X", side: "short", entryLow: 100, entryHigh: 100, stop: 103, target: 91 },
      bars,
      { resolveWindow: 2 },
    );
    expect(short.resolution).toBe("unresolved");
    expect(plannedR(short, bars, "short", 3, FEE_R, 2).rAllIn).toBeCloseTo(-1.5 / 3 - FEE_R, 9);
  });
});

describe("shiftLevel — a resting order, never a market one", () => {
  const rnd = mulberry32(7);

  it("keeps a long below price and a short above it, within the ADR band", () => {
    for (let i = 0; i < 500; i++) {
      const long = shiftLevel("long", 100, 2, 101, rnd);
      if (long != null) {
        expect(long).toBeLessThan(101);
        expect(Math.abs(long - 100)).toBeGreaterThanOrEqual(SHIFT_MIN_ADR * 2 - 1e-9);
        expect(Math.abs(long - 100)).toBeLessThanOrEqual(SHIFT_MAX_ADR * 2 + 1e-9);
      }
      const short = shiftLevel("short", 100, 2, 99, rnd);
      if (short != null) {
        expect(short).toBeGreaterThan(99);
        expect(Math.abs(short - 100)).toBeLessThanOrEqual(SHIFT_MAX_ADR * 2 + 1e-9);
      }
    }
  });

  it("refuses rather than returning a marketable level", () => {
    // Every draw shifts UP; a long whose price sits 0.1 above the edge can
    // only be shifted down, so ten upward draws must come back null.
    const up = () => 0.9;
    expect(shiftLevel("long", 100, 1, 100.1, up)).toBeNull();
    const down = () => 0.1;
    expect(shiftLevel("short", 100, 1, 99.9, down)).toBeNull();
  });
});

describe("rejectEntry — touch, THEN rejection, then the next open", () => {
  const adr = Array(10).fill(2);

  it("skips a touch that closes weak and enters after the one that rejects (long)", () => {
    const bars = [
      bar(104, 105, 103, 104),
      bar(103, 103.5, 100.5, 100.8), // touches 101, closes below it in the low third
      bar(100.8, 102.2, 99.5, 102), // touches and closes back above
      bar(101.8, 103, 101.5, 102.5),
    ];
    const r = rejectEntry("long", bars, 0, 101, 98, adr)!;
    expect(r.idx).toBe(3);
    expect(r.entry).toBe(101.8);
    expect(r.risk).toBeCloseTo(3.8, 9);
  });

  it("mirrors for a short at supply", () => {
    const bars = [
      bar(96, 97, 95, 96),
      bar(97, 99.5, 96.5, 99.2), // touches 99, closes above it in the high third
      bar(99.2, 100.5, 97.8, 98), // touches and closes back below
      bar(98.2, 98.5, 97, 97.5),
    ];
    const r = rejectEntry("short", bars, 0, 99, 102, adr)!;
    expect(r.idx).toBe(3);
    expect(r.entry).toBe(98.2);
    expect(r.risk).toBeCloseTo(3.8, 9);
  });

  it("returns nothing once the zone has closed through its distal edge", () => {
    const longBars = [bar(104, 105, 103, 104), bar(103, 103, 97, 97.5), bar(97.5, 102, 97, 101.9), bar(102, 103, 101, 102)];
    expect(rejectEntry("long", longBars, 0, 101, 98, adr)).toBeNull();
    const shortBars = [bar(96, 97, 95, 96), bar(97, 103, 97, 102.5), bar(102.5, 103, 98, 98.1), bar(98, 99, 97, 98)];
    expect(rejectEntry("short", shortBars, 0, 99, 102, adr)).toBeNull();
  });

  it("floors the stop at one ADR", () => {
    const bars = [bar(104, 105, 103, 104), bar(102, 102.5, 100.5, 102.3), bar(102.4, 103, 102, 102.8)];
    expect(rejectEntry("long", bars, 0, 101, 100.8, Array(10).fill(5))!.risk).toBe(5);
  });
});

describe("symbolHalf — design and confirmation sets never overlap", () => {
  const syms = Array.from({ length: 400 }, (_, i) => `S${i.toString(36).toUpperCase()}X`);

  it("is deterministic and splits the universe into two real halves", () => {
    const a = syms.filter((s) => symbolHalf(s) === "a");
    const b = syms.filter((s) => symbolHalf(s) === "b");
    expect(a.length + b.length).toBe(syms.length);
    expect(a.some((s) => b.includes(s))).toBe(false);
    expect(a.length / syms.length).toBeGreaterThan(0.35);
    expect(a.length / syms.length).toBeLessThan(0.65);
    expect(syms.map(symbolHalf)).toEqual(syms.map(symbolHalf));
  });
});

describe("edgeTrades — the zone trade is zone-backtest's, and controls keep its side", () => {
  // Thirty flat bars, a demand zone (down candle, then a confirm whose low
  // clears its high), a pullback that tags the zone and rejects, and a rally.
  const up: [number, number, number, number][] = [
    ...Array.from({ length: 30 }, () => [100, 101, 99, 100] as [number, number, number, number]),
    [100, 101, 98.5, 99],
    [100, 103, 100, 102.5],
    [103, 105, 102, 104.5],
    [104, 104.5, 102.8, 103],
    [103, 103.2, 101.6, 101.8],
    [101.8, 102, 100.6, 101.5],
    [101.7, 104, 101.5, 103.8],
    [104, 106, 103.5, 105.8],
    [106, 109, 105.5, 108.8],
    ...Array.from({ length: 12 }, (_, i) => {
      const c = 109 + i * 0.4;
      return [c - 0.2, c + 0.6, c - 0.6, c] as [number, number, number, number];
    }),
  ];
  const DAY = 86_400_000;
  const series = (rows: [number, number, number, number][]) =>
    rows.map(([o, h, l, c], i) => ({ t: i * DAY, o, h, l, c }));
  // The mirror image: every demand zone becomes a supply zone.
  const mirror = (rows: [number, number, number, number][]) =>
    rows.map(([o, h, l, c]) => [200 - o, 200 - l, 200 - h, 200 - c] as [number, number, number, number]);

  for (const [label, rows, side] of [
    ["demand", up, "long"],
    ["supply", mirror(up), "short"],
  ] as const) {
    it(`${label}: every control carries the zone's side, and the zone trade matches replayZones`, () => {
      const bars = series(rows);
      const ts: EdgeTrade[] = edgeTrades("X", bars, { riskBudget: 75, fees: 4, rnd: mulberry32(1) });
      const zoneTrades = ts.filter((t) => t.variant === "zone");
      expect(zoneTrades.length).toBeGreaterThan(0); // the fixture really holds a zone
      expect(ts.every((t) => t.side === side)).toBe(true);
      expect(ts.some((t) => t.variant === "shifted")).toBe(true);
      expect(ts.some((t) => t.variant === "random_day")).toBe(true);
      expect(ts.some((t) => t.variant === "reject")).toBe(true);

      const reference = replayZones("X", bars, { riskBudget: 75 });
      expect(zoneTrades.map((t) => t.resolution)).toEqual(reference.map((r) => r.result.resolution));
      expect(zoneTrades.some((t) => t.resolution === "hit_target")).toBe(true);
    });
  }
});

describe("bootstrapDiff — resamples symbols", () => {
  const mk = (symbol: string, variant: EdgeTrade["variant"], win: boolean): EdgeTrade => ({
    variant,
    symbol,
    side: "long",
    quadrant: null,
    t: 0,
    resolution: win ? "hit_target" : "hit_stop",
    r: win ? 3 : -1,
    rAllIn: win ? 3 : -1,
  });

  it("finds a difference that is there and none that is not", () => {
    const ts: EdgeTrade[] = [];
    for (let i = 0; i < 20; i++) {
      ts.push(mk(`S${i}`, "zone", true), mk(`S${i}`, "zone", false));
      ts.push(mk(`S${i}`, "shifted", true), mk(`S${i}`, "shifted", false));
      ts.push(mk(`S${i}`, "random_day", true), mk(`S${i}`, "random_day", true));
    }
    const same = bootstrapDiff(ts, "zone", "shifted", mulberry32(3))!;
    expect(same.winPp[0]).toBeLessThanOrEqual(0);
    expect(same.winPp[1]).toBeGreaterThanOrEqual(0);
    const worse = bootstrapDiff(ts, "zone", "random_day", mulberry32(3))!;
    expect(worse.winPp[1]).toBeLessThan(0);
    expect(worse.rAllIn[1]).toBeLessThan(0);
  });

  it("refuses a single symbol rather than reporting a zero-width interval", () => {
    expect(bootstrapDiff([mk("A", "zone", true), mk("A", "shifted", false)], "zone", "shifted", mulberry32(1))).toBeNull();
  });
});
