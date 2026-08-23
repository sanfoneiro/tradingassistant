import { describe, it, expect } from "vitest";
import {
  computeZones,
  distancePct,
  zoneTable,
  toWeekly,
  type Bar,
} from "./zones";

/**
 * The indicator is the oracle. These tests pin the detection and maintenance
 * rules that were read out of the v3 Pine source; the live cross-check
 * against a real symbol's table lives in scripts/verify-zones.ts, which needs
 * the market data API.
 */

let clock = Date.UTC(2026, 0, 5); // a Monday
const DAY = 86_400_000;
const bar = (o: number, h: number, l: number, c: number): Bar => {
  const b = { t: clock, o, h, l, c };
  clock += DAY;
  return b;
};
const reset = () => (clock = Date.UTC(2026, 0, 5));

/** Bearish candidate, then a clean gap up: a demand order block. */
const demandSetup = (): Bar[] => {
  reset();
  return [
    bar(100, 101, 99, 100), // filler
    bar(100, 100, 95, 96), //  candidate — closed down, range 95–100
    bar(97, 99, 96, 98), //    the "1 bar later" candle, ignored by detection
    bar(102, 104, 101, 103), // confirm — low 101 clears the candidate's high
  ];
};

/** Bullish candidate, then a clean gap down: a supply order block. */
const supplySetup = (): Bar[] => {
  reset();
  return [
    bar(100, 101, 99, 100),
    bar(96, 105, 96, 104), //  candidate — closed up, range 96–105
    bar(103, 104, 102, 103),
    bar(94, 95, 92, 93), //    confirm — high 95 is below the candidate's low
  ];
};

describe("detection", () => {
  it("finds a demand block on a three-bar gap up", () => {
    const z = computeZones(demandSetup());
    expect(z).toHaveLength(1);
    expect(z[0].direction).toBe("demand");
    expect(z[0].top).toBe(100); // candidate high
    expect(z[0].bottom).toBe(95); // candidate low
    expect(z[0].entry).toBe(100); // proximal — price comes DOWN to it
    expect(z[0].sl).toBe(95); // distal
    expect(z[0].mid).toBe(97.5);
  });

  it("finds a supply block on a three-bar gap down", () => {
    const z = computeZones(supplySetup());
    expect(z).toHaveLength(1);
    expect(z[0].direction).toBe("supply");
    expect(z[0].entry).toBe(96); // proximal — price comes UP to it
    expect(z[0].sl).toBe(105);
    expect(z[0].mid).toBe(100.5);
  });

  it("a gap that does not clear the candidate is not a block", () => {
    reset();
    const bars = [
      bar(100, 101, 99, 100),
      bar(100, 100, 95, 96), // candidate high 100
      bar(97, 99, 96, 98),
      bar(99, 101, 99, 100), // low 99 — overlaps, no imbalance
    ];
    expect(computeZones(bars)).toHaveLength(0);
  });

  it("a bullish candidate cannot make a demand block", () => {
    reset();
    const bars = [
      bar(100, 101, 99, 100),
      bar(95, 100, 95, 99), // closed UP
      bar(97, 99, 96, 98),
      bar(102, 104, 101, 103), // gap up, but wrong candidate direction
    ];
    expect(computeZones(bars)).toHaveLength(0);
  });

  it("one candidate produces one zone, not one per confirming bar", () => {
    reset();
    const bars = [
      bar(100, 101, 99, 100),
      bar(100, 100, 95, 96),
      bar(97, 99, 96, 98),
      bar(102, 104, 101, 103),
      bar(104, 106, 103, 105), // still clears the same candidate
    ];
    expect(computeZones(bars)).toHaveLength(1);
  });
});

describe("maintenance", () => {
  it("trading into a zone marks it mitigated, not broken", () => {
    const bars = [...demandSetup(), bar(103, 103, 99, 101)]; // dips to 99
    const z = computeZones(bars);
    expect(z).toHaveLength(1);
    expect(z[0].mitigated).toBe(true);
  });

  it("the proximal edge shrinks to the deepest penetration", () => {
    const bars = [...demandSetup(), bar(103, 103, 98, 101)];
    const z = computeZones(bars);
    // Entry was 100; price reached 98 inside the zone, so the edge follows.
    expect(z[0].top).toBe(98);
    expect(z[0].entry).toBe(98);
    expect(z[0].sl).toBe(95); // distal never moves
    expect(z[0].mid).toBe(96.5);
  });

  it("a wick through the distal edge does not break the zone", () => {
    const bars = [...demandSetup(), bar(103, 103, 94, 101)]; // wick below 95
    const z = computeZones(bars);
    expect(z).toHaveLength(1);
    expect(z[0].mitigated).toBe(true);
  });

  it("a CLOSE through the distal edge deletes it", () => {
    const bars = [...demandSetup(), bar(99, 99, 93, 94)]; // closes below 95
    expect(computeZones(bars)).toHaveLength(0);
  });

  it("reaching the midpoint is recorded", () => {
    const opts = { updateZones: false }; // fixed edges, so mid stays at 97.5
    const shallow = computeZones([...demandSetup(), bar(103, 103, 99, 101)], opts);
    expect(shallow[0].fiftyReached).toBe(false);
    const deep = computeZones([...demandSetup(), bar(103, 103, 97, 101)], opts);
    expect(deep[0].fiftyReached).toBe(true);
  });

  /**
   * Easy to get wrong, and the indicator's own ordering is the authority:
   * `mid` is recomputed inside updateZones and the 50% test runs after it.
   * So as price eats into a zone the edge follows it down and the midpoint
   * recedes with it — a shallow tag never "reaches 50%", however far in it
   * looks on the original box.
   */
  it("with the edge shrinking, the midpoint recedes ahead of price", () => {
    const z = computeZones([...demandSetup(), bar(103, 103, 97, 101)]);
    expect(z[0].top).toBe(97); // edge pulled down to the low
    expect(z[0].mid).toBe(96); // midpoint moved with it, below the low
    expect(z[0].fiftyReached).toBe(false);

    // Only a push to the distal edge itself — where there is no room left to
    // shrink — counts as reaching the midpoint.
    const atDistal = computeZones([...demandSetup(), bar(103, 103, 95, 101)]);
    expect(atDistal[0].fiftyReached).toBe(true);
  });

  it("keeps only the most recent maxZones", () => {
    reset();
    const bars: Bar[] = [];
    // Ten separate demand blocks on a staircase up, each clearing the last.
    for (let k = 0; k < 10; k++) {
      const base = 100 + k * 20;
      bars.push(bar(base, base + 1, base - 1, base));
      bars.push(bar(base, base, base - 5, base - 4)); // candidate
      bars.push(bar(base + 1, base + 3, base + 1, base + 2));
      bars.push(bar(base + 6, base + 8, base + 5, base + 7)); // confirm
    }
    expect(computeZones(bars).length).toBe(10);
    expect(computeZones(bars, { maxZones: 3 }).length).toBe(3);
  });

  it("returns newest first", () => {
    reset();
    const bars: Bar[] = [];
    for (let k = 0; k < 3; k++) {
      const base = 100 + k * 20;
      bars.push(bar(base, base + 1, base - 1, base));
      bars.push(bar(base, base, base - 5, base - 4));
      bars.push(bar(base + 1, base + 3, base + 1, base + 2));
      bars.push(bar(base + 6, base + 8, base + 5, base + 7));
    }
    const z = computeZones(bars);
    expect(z[0].createdAt).toBeGreaterThan(z[1].createdAt);
    expect(z[1].createdAt).toBeGreaterThan(z[2].createdAt);
  });
});

/**
 * The two arithmetic invariants published in every row of the indicator's
 * table, checked against the RL weekly chart of 2026-08-23 (price 372.59).
 * They are what lets an inbound zone be verified rather than trusted.
 */
describe("agrees with the indicator's table — RL 1W, 2026-08-23", () => {
  const price = 372.59;
  const rows = [
    { entry: 354.13, mid: 339.47, sl: 324.8, dist: -4.95 },
    { entry: 323.34, mid: 320.84, sl: 318.35, dist: -13.22 },
    { entry: 193.82, mid: 192.22, sl: 190.62, dist: -47.98 },
    { entry: 190.62, mid: 187.82, sl: 185.02, dist: -48.84 },
    { entry: 129.06, mid: 125.9, sl: 122.74, dist: -65.36 },
    { entry: 104.4, mid: 101.16, sl: 97.93, dist: -71.98 },
    { entry: 97.93, mid: 96.16, sl: 94.39, dist: -73.72 },
    { entry: 76.53, mid: 73.1, sl: 69.66, dist: -79.46 },
  ];

  it("Dist % is (entry − price) / price", () => {
    for (const r of rows) {
      expect(Math.abs(distancePct(r.entry, price) - r.dist)).toBeLessThan(0.01);
    }
  });

  it("the 50% column is the midpoint of entry and SL", () => {
    for (const r of rows) {
      expect(Math.abs((r.entry + r.sl) / 2 - r.mid)).toBeLessThan(0.006);
    }
  });

  it("every row is a demand zone below price, so entry sits above SL", () => {
    for (const r of rows) {
      expect(r.entry).toBeGreaterThan(r.sl);
      expect(r.entry).toBeLessThan(price);
    }
  });
});

describe("zoneTable", () => {
  it("orders by absolute distance and caps the rows", () => {
    const zones = [
      { entry: 300 },
      { entry: 370 },
      { entry: 100 },
      { entry: 360 },
    ].map((z) => ({ ...z, direction: "demand", top: 0, bottom: 0, mid: 0, sl: 0, createdAt: 0, mitigated: false, fiftyReached: false })) as never;

    const t = zoneTable(zones, 372.59, 2);
    expect(t.map((z) => z.entry)).toEqual([370, 360]);
  });
});

describe("toWeekly", () => {
  /** Explicit dates rather than a running counter — 2026-01-05 is a Monday
   *  and 2026-01-10 is still that same week, which is exactly the off-by-a-
   *  weekend this test exists to catch. */
  const on = (d: number, o: number, h: number, l: number, c: number): Bar => ({
    t: Date.UTC(2026, 0, d),
    o,
    h,
    l,
    c,
  });

  it("rolls daily bars into Monday-anchored weeks", () => {
    const daily = [
      on(5, 10, 12, 9, 11), // Mon
      on(6, 11, 15, 10, 14), // Tue
      on(7, 14, 16, 8, 9), // Wed
      on(8, 9, 10, 7, 8), // Thu
      on(9, 8, 9, 7, 9), // Fri
      on(12, 9, 20, 5, 18), // Mon, the following week
    ];
    const w = toWeekly(daily);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ o: 10, h: 16, l: 7, c: 9 });
    expect(w[1]).toMatchObject({ o: 9, h: 20, l: 5, c: 18 });
  });

  it("a Saturday bar belongs to the week that started that Monday", () => {
    const w = toWeekly([on(9, 8, 9, 7, 9), on(10, 9, 11, 8, 10)]); // Fri, Sat
    expect(w).toHaveLength(1);
    expect(w[0].c).toBe(10);
  });

  it("keeps a partial trailing week, like a forming candle", () => {
    reset();
    const daily = [bar(10, 12, 9, 11), bar(11, 13, 10, 12)];
    const w = toWeekly(daily);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ o: 10, h: 13, l: 9, c: 12 });
  });
});
