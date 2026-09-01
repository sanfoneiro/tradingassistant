import { describe, it, expect } from "vitest";
import { signalFor, rollingRange, compareRates, TARGET_R } from "./zone-backtest";
import type { Zone } from "./zones";

/**
 * Both directions, always. A long-only suite passes happily while every short
 * is inverted — and here an inverted short would not crash, it would quietly
 * turn the trend split's answer upside down.
 */

const zone = (over: Partial<Zone> & Pick<Zone, "direction" | "top" | "bottom">): Zone => ({
  entry: over.direction === "demand" ? over.top : over.bottom,
  sl: over.direction === "demand" ? over.bottom : over.top,
  mid: (over.top + over.bottom) / 2,
  createdAt: 0,
  mitigated: false,
  fiftyReached: false,
  ...over,
});

describe("signalFor — the trade a zone implies", () => {
  it("puts a demand stop BELOW the entry and the target above", () => {
    const s = signalFor(zone({ direction: "demand", top: 100, bottom: 96 }), 0)!;
    expect(s.signal.side).toBe("long");
    expect(s.signal.entryLow).toBe(100);
    expect(s.signal.stop).toBe(96);
    expect(s.signal.target).toBe(100 + TARGET_R * 4);
    expect(s.riskPct).toBeCloseTo(4, 6);
  });

  it("puts a supply stop ABOVE the entry and the target below", () => {
    const s = signalFor(zone({ direction: "supply", top: 104, bottom: 100 }), 0)!;
    expect(s.signal.side).toBe("short");
    expect(s.signal.entryLow).toBe(100);
    expect(s.signal.stop).toBe(104);
    expect(s.signal.target).toBe(100 - TARGET_R * 4);
    expect(s.riskPct).toBeCloseTo(4, 6);
  });

  it("widens a too-tight stop to the ADR floor, in both directions", () => {
    const long = signalFor(zone({ direction: "demand", top: 100, bottom: 99.5 }), 3)!;
    expect(long.signal.stop).toBe(97);
    expect(long.signal.target).toBe(109);

    const short = signalFor(zone({ direction: "supply", top: 100.5, bottom: 100 }), 3)!;
    expect(short.signal.stop).toBe(103);
    expect(short.signal.target).toBe(91);
  });

  it("leaves a stop that already clears the floor alone", () => {
    const s = signalFor(zone({ direction: "demand", top: 100, bottom: 90 }), 3)!;
    expect(s.signal.stop).toBe(90);
  });

  it("refuses a zone with no width and no floor rather than returning one", () => {
    expect(signalFor(zone({ direction: "demand", top: 100, bottom: 100 }), 0)).toBeNull();
    expect(signalFor(zone({ direction: "supply", top: 100, bottom: 100 }), 0)).toBeNull();
  });
});

describe("rollingRange — the rule 8 floor is LOCAL", () => {
  const flat = (c: number, range: number) => ({ t: 0, o: c, h: c + range / 2, l: c - range / 2, c });

  it("tracks the price level it is measured at, not the last one", () => {
    // Ten bars at $10 with a $1 range, then ten at $100 with a $10 range:
    // the same 10% volatility at two very different prices.
    const bars = [
      ...Array.from({ length: 10 }, () => flat(10, 1)),
      ...Array.from({ length: 10 }, () => flat(100, 10)),
    ];
    const r = rollingRange(bars, 5);
    expect(r[9]).toBeCloseTo(1, 6);
    expect(r[19]).toBeCloseTo(10, 6);
    // The bug this replaces used r.at(-1) everywhere, which would have
    // charged the early zones a $10 stop on a $10 share.
    expect(r[9]).toBeLessThan(r[19]);
  });

  it("uses what history exists before the lookback is full", () => {
    const r = rollingRange([flat(10, 1), flat(10, 1)], 20);
    expect(r[0]).toBeCloseTo(1, 6);
    expect(r).toHaveLength(2);
  });
});

describe("compareRates", () => {
  it("signs z by which side wins more often", () => {
    const c = compareRates({ wins: 60, losses: 140 }, { wins: 30, losses: 170 })!;
    expect(c.diff).toBeGreaterThan(0);
    expect(c.z).toBeGreaterThan(2);
  });

  it("reports a null result rather than dividing by an empty side", () => {
    expect(compareRates({ wins: 0, losses: 0 }, { wins: 5, losses: 5 })).toBeNull();
  });

  it("finds no difference where there is none", () => {
    const c = compareRates({ wins: 50, losses: 150 }, { wins: 50, losses: 150 })!;
    expect(c.z).toBeCloseTo(0, 6);
  });
});
