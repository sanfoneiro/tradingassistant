import { describe, it, expect } from "vitest";
import {
  checkRow,
  summarise,
  TOLERANCE,
  toleranceFor,
  type ColmexPosition,
} from "./colmex";

/**
 * The screenshot of 2026-08-23, transcribed by hand. This is the fixture that
 * says the invariants match the real platform rather than a model of it.
 */
const DIS: ColmexPosition = {
  symbol: "DIS",
  side: "long",
  qty: 10,
  openPrice: 102.3355,
  currentPrice: 107.88,
  slPrice: 105.47,
  tpPrice: 110,
  fee: 2,
  netPl: 53.44,
  slValue: 31.34,
};

describe("agrees with the platform — DIS, 2026-08-23", () => {
  it("reproduces Net P/L and SL,value from the other columns", () => {
    const c = checkRow(DIS);
    expect(c.ok).toBe(true);
    expect(Math.abs(c.computedNetPl - 53.44)).toBeLessThan(TOLERANCE);
    expect(Math.abs(c.computedSlValue! - 31.34)).toBeLessThan(TOLERANCE);
  });

  /**
   * The exact figure is 31.345 and the platform prints 31.34 — it truncates
   * to the cent rather than rounding. That half-cent is why the tolerance is
   * a couple of cents and not exact equality; tightening it to a rounding
   * boundary would reject correct transcriptions of real screens.
   */
  it("tolerates the platform truncating to the cent", () => {
    const c = checkRow(DIS);
    expect(c.computedSlValue).toBeCloseTo(31.345, 3);
    expect(c.slValueDelta).toBeGreaterThan(0);
    expect(Math.abs(c.slValueDelta!)).toBeLessThan(TOLERANCE);
  });
});

describe("catches a misread digit", () => {
  it("rejects a transposed current price", () => {
    // 107.88 read as 107.98 — one digit, and Net P/L no longer ties out.
    const c = checkRow({ ...DIS, currentPrice: 107.98 });
    expect(c.ok).toBe(false);
    expect(c.problems[0]).toMatch(/Net P\/L does not tie out/);
  });

  it("rejects a misread stop", () => {
    // The stop moves but SL,value doesn't follow, so the second check fires
    // while the first still passes — which is why there are two.
    const c = checkRow({ ...DIS, slPrice: 106.47 });
    expect(c.ok).toBe(false);
    expect(c.problems.some((p) => /SL,value does not tie out/.test(p))).toBe(true);
    expect(c.problems.some((p) => /Net P\/L/.test(p))).toBe(false);
  });

  it("rejects a misread quantity", () => {
    const c = checkRow({ ...DIS, qty: 100 });
    expect(c.ok).toBe(false);
    expect(c.problems.length).toBeGreaterThanOrEqual(2); // both invariants fail
  });

  it("rejects a flipped side", () => {
    const c = checkRow({ ...DIS, side: "short" });
    expect(c.ok).toBe(false);
  });
});

describe("shorts are checked in their own direction", () => {
  const ba: ColmexPosition = {
    symbol: "BA",
    side: "short",
    qty: 5,
    openPrice: 234.1361,
    currentPrice: 225.87,
    slPrice: 230.04,
    tpPrice: 221,
    fee: 2,
    // (234.1361 − 225.87) × 5 − 2
    netPl: 39.33,
    slValue: 20.48,
  };

  it("a profitable short ties out", () => {
    expect(checkRow(ba).ok).toBe(true);
  });

  it("the same numbers read as a long do not", () => {
    expect(checkRow({ ...ba, side: "long" }).ok).toBe(false);
  });
});

describe("stop-side plausibility", () => {
  it("flags a long whose stop sits above both entry and price", () => {
    const c = checkRow({
      symbol: "X", side: "long", qty: 10,
      openPrice: 100, currentPrice: 99, slPrice: 105, tpPrice: null,
      fee: 2, netPl: -12, slValue: 50,
    });
    expect(c.problems.some((p) => /wrong side/.test(p))).toBe(true);
  });

  it("does not flag a long whose stop is above entry but below price", () => {
    // A stop trailed past breakeven — DIS's actual situation.
    expect(checkRow(DIS).ok).toBe(true);
  });
});

describe("missing values are missing, not zero", () => {
  it("a position with no stop skips the SL check rather than failing it", () => {
    const c = checkRow({
      ...DIS, slPrice: null, slValue: null,
      currentPrice: 107.88, netPl: 53.44,
    });
    expect(c.ok).toBe(true);
    expect(c.computedSlValue).toBeNull();
  });
});

describe("summarise", () => {
  it("an unreadable screenshot is not ok even when every row checks out", () => {
    const s = summarise(
      {
        accountLabel: "COLH70142", balance: 7551.85, equity: 7607.33,
        positions: [DIS], unreadable: true, notes: "SL column cut off",
      },
      [checkRow(DIS)],
    );
    expect(s.ok).toBe(false);
    expect(s.verified).toBe(1);
  });

  it("counts verified and rejected separately", () => {
    const s = summarise(
      {
        accountLabel: "COLH70142", balance: 7551.85, equity: 7607.33,
        positions: [], unreadable: false, notes: "",
      },
      [checkRow(DIS), checkRow({ ...DIS, qty: 99 })],
    );
    expect(s.ok).toBe(false);
    expect(s.verified).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.problems.length).toBeGreaterThan(0);
  });

  it("a flat book is a valid, ok result", () => {
    const s = summarise(
      {
        accountLabel: "COLH70142", balance: 7551.85, equity: 7551.85,
        positions: [], unreadable: false, notes: "",
      },
      [],
    );
    expect(s.ok).toBe(true);
    expect(s.positions).toBe(0);
  });
});

/**
 * The tolerance has to scale with quantity, and for a while it did not.
 *
 * Colmex displays Current price to two decimals but computes Net P/L from
 * full precision, so a perfectly-transcribed row is already out by up to half
 * a cent PER SHARE. A flat $0.02 therefore rejects correct transcriptions of
 * anything bigger than a couple of shares — the check fires on good data,
 * which is how a check stops being believed.
 */
describe("tolerance scales with quantity", () => {
  it("is half a cent a share, plus the flat allowance", () => {
    expect(toleranceFor(1)).toBeCloseTo(0.03, 10);
    expect(toleranceFor(15)).toBeCloseTo(0.17, 10);
    expect(toleranceFor(100)).toBeCloseTo(1.02, 10);
    // and it never goes negative on a badly-signed qty
    expect(toleranceFor(-15)).toBeCloseTo(0.17, 10);
  });

  /**
   * NKE as it actually sat: 15 shares, open 67.89, true price 40.7349 which
   * the screen renders as 40.73. The platform's Net P/L is computed from the
   * true price; the transcriber can only read the rounded one.
   */
  const NKE_ROUNDED: ColmexPosition = {
    symbol: "NKE",
    side: "long",
    qty: 15,
    openPrice: 67.89,
    currentPrice: 40.73, // as displayed
    slPrice: null,
    tpPrice: null,
    fee: 2,
    netPl: -409.33, // as displayed, computed by the platform from 40.7349
    slValue: null,
  };

  it("accepts a correctly-read row whose only error is the screen's rounding", () => {
    const r = checkRow(NKE_ROUNDED);
    // the miss is real, and larger than the old flat tolerance
    expect(Math.abs(r.netPlDelta)).toBeGreaterThan(TOLERANCE);
    // but it is inside the scaled one, so the row is accepted
    expect(Math.abs(r.netPlDelta)).toBeLessThan(toleranceFor(15));
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("still catches a genuinely misread digit at the same quantity", () => {
    // 40.73 read as 47.03 — a transposition, not a rounding artefact
    const r = checkRow({ ...NKE_ROUNDED, currentPrice: 47.03 });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/Net P\/L does not tie out/);
  });

  it("scales the SL,value check too, not just Net P/L", () => {
    const base: ColmexPosition = {
      symbol: "BIG",
      side: "long",
      qty: 50,
      openPrice: 100.0,
      currentPrice: 101.0,
      slPrice: 98.0,
      tpPrice: null,
      fee: 2,
      netPl: 48,
      slValue: 100.4, // true value 100.00, out by 0.40
    };
    // 0.40 would fail a flat 0.02 but sits inside 0.01*50 + 0.02 = 0.52
    expect(Math.abs(0.4)).toBeGreaterThan(TOLERANCE);
    expect(checkRow(base).ok).toBe(true);
    // push it past the scaled tolerance and it fails again
    expect(checkRow({ ...base, slValue: 101.0 }).ok).toBe(false);
  });
});
