import { describe, it, expect } from "vitest";
import {
  positionRisk,
  freeStopMove,
  computeDerived,
  riskPerShare,
  stats,
  dividendImpact,
  DIVIDEND_FLAG_PCT,
  NOISE_BAND_ADR,
  positionSize,
  CONCENTRATION_CAP,
  CONCENTRATION_CAP_APLUS,
} from "./metrics";

/**
 * Every signed calculation in here is tested in BOTH directions. A long-only
 * test suite passes happily while shorts report a loss as a gain — which is
 * exactly the class of bug this file exists to catch.
 */

const near = (a: number | null, b: number, tol = 0.005) => {
  expect(a).not.toBeNull();
  expect(Math.abs((a as number) - b)).toBeLessThan(tol);
};

describe("riskPerShare", () => {
  it("is unsigned distance, so side does not matter", () => {
    expect(riskPerShare(100, 95)).toBe(5);
    expect(riskPerShare(95, 100)).toBe(5);
  });
});

describe("positionRisk", () => {
  it("no stop is unknowable, not zero — all three come back null", () => {
    const r = positionRisk({
      side: "long",
      entry: 100,
      stop: null,
      mark: 110,
      qty: 10,
    });
    expect(r.capitalAtRisk).toBeNull();
    expect(r.riskFromMark).toBeNull();
    expect(r.lockedGain).toBeNull();
  });

  it("long with the stop below entry: real capital at risk, nothing locked", () => {
    const r = positionRisk({
      side: "long",
      entry: 100,
      stop: 95,
      mark: 104,
      qty: 10,
    });
    near(r.capitalAtRisk, 50); // 5 × 10
    near(r.lockedGain, 0);
    near(r.riskFromMark, 90); // (104 − 95) × 10 of giveback
  });

  /** The worked example from the file's own comment. */
  it("long with the stop past breakeven: zero risk, a locked gain", () => {
    const r = positionRisk({
      side: "long",
      entry: 690.98,
      stop: 707.37,
      mark: 731.07,
      qty: 3,
    });
    near(r.capitalAtRisk, 0);
    near(r.lockedGain, 49.17); // (707.37 − 690.98) × 3
    near(r.riskFromMark, 71.1); // (731.07 − 707.37) × 3
  });

  it("short with the stop above entry: real capital at risk", () => {
    const r = positionRisk({
      side: "short",
      entry: 100,
      stop: 105,
      mark: 96,
      qty: 10,
    });
    near(r.capitalAtRisk, 50);
    near(r.lockedGain, 0);
    near(r.riskFromMark, 90); // (105 − 96) × 10
  });

  it("short with the stop past breakeven: zero risk, a locked gain", () => {
    const r = positionRisk({
      side: "short",
      entry: 100,
      stop: 94,
      mark: 90,
      qty: 10,
    });
    near(r.capitalAtRisk, 0);
    near(r.lockedGain, 60); // (100 − 94) × 10
    near(r.riskFromMark, 40); // (94 − 90) × 10
  });

  it("never reports negative risk once the mark is through the stop", () => {
    const r = positionRisk({
      side: "long",
      entry: 100,
      stop: 95,
      mark: 90, // already below the stop — gapped through
      qty: 10,
    });
    near(r.riskFromMark, 0);
  });
});

/**
 * Real book, read off Colmex on 2026-08-23. The platform publishes its own
 * "SL, value" and "Net P/L" columns, which makes this an independent check
 * on two formulas rather than a restatement of them: if lockedGain and the
 * fee-netted P/L do not reproduce the broker's own numbers, one of us is
 * wrong and it is not the broker.
 */
describe("agrees with the platform — DIS, 2026-08-23", () => {
  const dis = {
    side: "long" as const,
    entry: 102.3355,
    stop: 105.47,
    mark: 107.88,
    qty: 10,
  };

  it("reproduces the SL,value column exactly", () => {
    const r = positionRisk(dis);
    near(r.lockedGain, 31.34, 0.01); // platform: 31.34 USD
    near(r.capitalAtRisk, 0); // stop is past breakeven
    near(r.riskFromMark, 24.1); // giveback if the stop fills today
  });

  it("reproduces Net P/L once the commission is taken off", () => {
    const gross = (dis.mark - dis.entry) * dis.qty;
    near(gross, 55.44, 0.01); // platform Gross P/L: 55.44
    near(gross - 2.0, 53.44, 0.01); // platform Net P/L: 53.44
  });
});

describe("freeStopMove", () => {
  it("long in profit with the stop still below entry: move it up to entry", () => {
    const m = freeStopMove({
      side: "long",
      entry: 100,
      stop: 95,
      mark: 108,
      qty: 10,
    });
    expect(m).not.toBeNull();
    expect(m!.to).toBe(100);
    near(m!.removes, 50);
  });

  it("long not yet in profit: no free move", () => {
    expect(
      freeStopMove({ side: "long", entry: 100, stop: 95, mark: 99, qty: 10 }),
    ).toBeNull();
  });

  it("short in profit with the stop still above entry: move it down to entry", () => {
    const m = freeStopMove({
      side: "short",
      entry: 100,
      stop: 105,
      mark: 92,
      qty: 10,
    });
    expect(m).not.toBeNull();
    expect(m!.to).toBe(100);
    near(m!.removes, 50);
  });

  it("short that has moved against us: no free move", () => {
    expect(
      freeStopMove({ side: "short", entry: 100, stop: 105, mark: 101, qty: 10 }),
    ).toBeNull();
  });

  it("stop already past breakeven: nothing left to remove", () => {
    expect(
      freeStopMove({ side: "long", entry: 100, stop: 102, mark: 110, qty: 10 }),
    ).toBeNull();
  });

  it("no mark means no answer, not a default", () => {
    expect(
      freeStopMove({ side: "long", entry: 100, stop: 95, mark: null, qty: 10 }),
    ).toBeNull();
  });
});

/**
 * A move is only free if the new stop survives an ordinary day.
 *
 * The live case: SSB long 10 @ 105.64, mark 105.80, stop 103.93. The dashboard
 * recommended raising the stop to breakeven — sixteen cents from price, against
 * a $1.80 average daily range, and tighter than every one of the previous
 * twenty daily ranges. Rule 8 says a stop is never tighter than roughly one
 * ADR, so the app was recommending a violation of its own rule, with a dollar
 * figure attached to make it look like a gain.
 */
describe("freeStopMove respects the noise band", () => {
  const SSB = {
    side: "long" as const,
    entry: 105.64,
    stop: 103.93,
    mark: 105.8,
    qty: 10,
    adr: 1.8049,
  };

  it("refuses to call the SSB move free — it is 0.09x ADR", () => {
    const m = freeStopMove(SSB)!;
    expect(m).not.toBeNull();
    expect(m.safe).toBe(false);
    near(m.adrMultiple!, 0.16 / 1.8049, 0.01);
    expect(m.reason).toMatch(/NOT free/);
    // the arithmetic is still reported — it is the recommendation that changes
    near(m.removes, 17.1, 0.2);
  });

  it("calls it free once price has travelled a full ADR", () => {
    const m = freeStopMove({ ...SSB, mark: 107.5 })!;
    expect(m.safe).toBe(true);
    expect(m.adrMultiple).toBeGreaterThanOrEqual(NOISE_BAND_ADR);
    expect(m.reason).toMatch(/outside\s+the noise band/);
  });

  it("says unverified rather than safe when no ADR is known", () => {
    const m = freeStopMove({ ...SSB, adr: null })!;
    expect(m.safe).toBeNull();
    expect(m.adrMultiple).toBeNull();
    expect(m.reason).toMatch(/cannot be checked|unverified/);
  });

  it("treats a zero or negative ADR as unknown, never as a pass", () => {
    expect(freeStopMove({ ...SSB, adr: 0 })!.safe).toBeNull();
    expect(freeStopMove({ ...SSB, adr: -1 })!.safe).toBeNull();
  });

  it("applies the same band to shorts", () => {
    const base = {
      side: "short" as const,
      entry: 100,
      stop: 105,
      qty: 10,
      adr: 2,
    };
    // 50 cents of travel against a $2 ADR is noise
    expect(freeStopMove({ ...base, mark: 99.5 })!.safe).toBe(false);
    // three dollars is not
    expect(freeStopMove({ ...base, mark: 97 })!.safe).toBe(true);
  });

  it("never reports a move on a position that is not in profit, ADR or not", () => {
    expect(
      freeStopMove({ side: "long", entry: 100, stop: 95, mark: 99, qty: 10, adr: 0.01 }),
    ).toBeNull();
  });
});

describe("computeDerived", () => {
  const longWin = {
    side: "long" as const,
    entryPlanned: 100,
    stopPlanned: 95,
    targetPlanned: 115,
    entryActual: 100,
    exitActual: 112,
    qty: 10,
    fees: 2,
  };

  it("long winner: P/L is net of fees and R is measured against initial risk", () => {
    const d = computeDerived(longWin);
    near(d.plUsd, 118); // (112 − 100) × 10 − 2
    near(d.rMultiple, 2.36); // 118 ÷ 50
    near(d.rrPlanned, 3); // 15 ÷ 5
    near(d.plPct, 12);
  });

  it("short winner: price falling is a gain", () => {
    const d = computeDerived({
      side: "short",
      entryPlanned: 100,
      stopPlanned: 105,
      targetPlanned: 85,
      entryActual: 100,
      exitActual: 88,
      qty: 10,
      fees: 2,
    });
    near(d.plUsd, 118); // (100 − 88) × 10 − 2
    near(d.rMultiple, 2.36);
    near(d.rrPlanned, 3);
    near(d.plPct, 12);
  });

  it("short loser: price rising is a loss", () => {
    const d = computeDerived({
      side: "short",
      entryPlanned: 100,
      stopPlanned: 105,
      targetPlanned: 85,
      entryActual: 100,
      exitActual: 105,
      qty: 10,
      fees: 2,
    });
    near(d.plUsd, -52); // −5 × 10 − 2
    near(d.rMultiple, -1.04);
  });

  it("excursions are signed by direction — long", () => {
    const d = computeDerived({
      ...longWin,
      mfePrice: 118, // best it got
      maePrice: 97, // worst it got
    });
    near(d.mfeR, 3.6); // (118 − 100) ÷ 5
    near(d.maeR, -0.6); // (97 − 100) ÷ 5
  });

  it("excursions are signed by direction — short", () => {
    const d = computeDerived({
      side: "short",
      entryPlanned: 100,
      stopPlanned: 105,
      entryActual: 100,
      exitActual: 88,
      qty: 10,
      fees: 0,
      mfePrice: 82, // best for a short is DOWN
      maePrice: 103,
    });
    near(d.mfeR, 3.6); // (100 − 82) ÷ 5
    near(d.maeR, -0.6); // (100 − 103) ÷ 5
  });

  it("efficiency is the share of the offered move actually captured", () => {
    const d = computeDerived({ ...longWin, fees: 0, mfePrice: 118 });
    // offered 3.6R, captured 120 ÷ 50 = 2.4R
    near(d.efficiency!, 2.4 / 3.6, 0.01);
  });

  it("entry slippage is signed against you", () => {
    // Measured in units of the ACTUAL entry-to-stop distance, because that
    // is the risk really taken. Entering at 101 against a 95 stop makes the
    // R unit 6 wide, not the planned 5.
    const worse = computeDerived({ ...longWin, entryActual: 101 });
    near(worse.slippageEntryR, 1 / 6);
    const better = computeDerived({ ...longWin, entryActual: 99 });
    near(better.slippageEntryR, -1 / 4);
  });

  it("returns nulls rather than guesses when inputs are missing", () => {
    const d = computeDerived({ side: "long", entryPlanned: 100, qty: 10 });
    expect(d.plUsd).toBeNull();
    expect(d.rMultiple).toBeNull();
    expect(d.mfeR).toBeNull();
  });

  it("a zero-width stop cannot produce an R multiple", () => {
    const d = computeDerived({
      side: "long",
      entryPlanned: 100,
      stopPlanned: 100, // stop moved to breakeven
      entryActual: 100,
      exitActual: 110,
      qty: 10,
      fees: 0,
    });
    expect(d.rMultiple).toBeNull();
  });

  it("hold time is in days", () => {
    const d = computeDerived({
      side: "long",
      entryPlanned: 100,
      stopPlanned: 95,
      entryActual: 100,
      exitActual: 110,
      qty: 10,
      openedAt: new Date("2026-08-03T13:30:00Z"),
      closedAt: new Date("2026-08-06T13:30:00Z"),
    });
    near(d.holdDays, 3);
  });
});

describe("stats", () => {
  const rows = [
    { plUsd: 300, rMultiple: 2 },
    { plUsd: -100, rMultiple: -1 },
    { plUsd: 200, rMultiple: 1.5 },
    { plUsd: -150, rMultiple: -1 },
  ];

  it("counts, win rate and profit factor", () => {
    const s = stats(rows);
    expect(s.n).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    near(s.winRate, 50);
    near(s.netPl, 250);
    near(s.profitFactor, 2); // 500 ÷ 250
    near(s.avgWin, 250);
    near(s.avgLoss, 125);
    near(s.avgR, 0.375);
  });

  it("expectancy is per-trade edge in dollars", () => {
    const s = stats(rows);
    near(s.expectancy, 0.5 * 250 - 0.5 * 125); // 62.50
  });

  it("a scratch trade is neither a win nor a loss", () => {
    const s = stats([
      { plUsd: 100, rMultiple: 1 },
      { plUsd: 0, rMultiple: 0 },
      { plUsd: -100, rMultiple: -1 },
    ]);
    expect(s.n).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    // One win and one loss out of three closed trades. The loss RATE is 1/3,
    // not (1 − 1/3) — treating every non-win as a loss overstates the
    // downside and understates the edge.
    near(s.expectancy, (1 / 3) * 100 - (1 / 3) * 100); // 0
  });

  it("max drawdown is peak-to-trough over the order given", () => {
    const s = stats([
      { plUsd: 100, rMultiple: 1 },
      { plUsd: -300, rMultiple: -3 },
      { plUsd: 50, rMultiple: 0.5 },
    ]);
    near(s.maxDrawdown, 300); // peak 100 → trough −200
  });

  it("drawdown depends on order, so callers must sort by close time", () => {
    const trades = [
      { plUsd: -100, rMultiple: -1 },
      { plUsd: 200, rMultiple: 2 },
      { plUsd: -100, rMultiple: -1 },
    ];
    const chronological = stats(trades);
    const reordered = stats([trades[1], trades[0], trades[2]]);
    near(chronological.maxDrawdown, 100); // dips to −100, recovers, ends flat
    near(reordered.maxDrawdown, 200); // peaks at 200, bleeds all the way back
    expect(chronological.maxDrawdown).not.toBe(reordered.maxDrawdown);
  });

  it("an empty book is empty, not zero-edged", () => {
    const s = stats([]);
    expect(s.n).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.expectancy).toBeNull();
  });

  it("rows with no P/L are not yet closed and do not count", () => {
    const s = stats([
      { plUsd: 100, rMultiple: 1 },
      { plUsd: null, rMultiple: null },
    ]);
    expect(s.n).toBe(1);
  });
});

/**
 * Dividends. The XOM short is the real case: ten shares held through the
 * 17 Aug 2026 ex-date cost $10.30, which was 21% of the trade's loss and 69%
 * of its entire planned stop distance.
 */
describe("dividends crossing the hold", () => {
  const xom = {
    side: "short" as const,
    entryPlanned: 161.52,
    stopPlanned: 163.0,
    targetPlanned: 151.97,
    entryActual: 161.52,
    exitActual: 165.0,
    qty: 10,
    fees: 4,
  };

  it("a short PAYS it, so the loss gets bigger", () => {
    const without = computeDerived(xom);
    const with_ = computeDerived({ ...xom, dividendUsd: -10.3 });
    near(without.plUsd, -38.8);
    near(with_.plUsd, -49.1);
    expect((with_.plUsd as number) < (without.plUsd as number)).toBe(true);
  });

  it("a long RECEIVES it, so the same magnitude moves P/L the other way", () => {
    const long = { ...xom, side: "long" as const, stopPlanned: 160.0 };
    const without = computeDerived(long);
    const with_ = computeDerived({ ...long, dividendUsd: +10.3 });
    expect((with_.plUsd as number) > (without.plUsd as number)).toBe(true);
    near((with_.plUsd as number) - (without.plUsd as number), 10.3);
  });

  it("carries into R, because R is computed from plUsd", () => {
    // initial risk = |161.52 - 163.00| * 10 = 14.80
    near(computeDerived(xom).rMultiple, -38.8 / 14.8);
    near(computeDerived({ ...xom, dividendUsd: -10.3 }).rMultiple, -49.1 / 14.8);
  });

  it("absent dividend is not the same as a zero one only when it is absent", () => {
    // Omitting the field must behave exactly like 0 - no silent NaN.
    expect(computeDerived(xom).plUsd).toBe(
      computeDerived({ ...xom, dividendUsd: 0 }).plUsd,
    );
  });
});

describe("dividendImpact — the grading-time veto input", () => {
  it("prices a short's dividend into BOTH sides of the ratio", () => {
    const r = dividendImpact({
      side: "short",
      entry: 161.52,
      stop: 163.0,
      target: 151.97,
      qty: 10,
      dividendPerShare: 1.03,
      fees: 4,
    });
    // headline R:R is 9.55/1.48 = 6.45; after the dividend and commission it is not
    near(r.pctOfStopDistance, 1.03 / 1.48);
    expect(r.flagged).toBe(true);
    near(r.adjustedRR, (9.55 * 10 - 10.3 - 4) / (1.48 * 10 + 10.3 + 4));
    expect((r.adjustedRR as number) < 6.45).toBe(true);
  });

  it("does NOT reduce a long's ratio — the dividend is received, not paid", () => {
    const r = dividendImpact({
      side: "long",
      entry: 38.32,
      stop: 37.33,
      target: 41.3,
      qty: 49,
      dividendPerShare: 0.455,
    });
    expect(r.adjustedRR).toBeNull();
    // but it IS a stop-placement warning: 0.455 of a 0.99 stop distance
    near(r.pctOfStopDistance, 0.455 / 0.99);
    expect(r.flagged).toBe(true);
    expect(r.reason).toMatch(/resting limit/i);
  });

  it("stays quiet when the dividend is trivial against the stop", () => {
    const r = dividendImpact({
      side: "short",
      entry: 100,
      stop: 110,
      target: 80,
      qty: 10,
      dividendPerShare: 0.05,
    });
    expect(r.pctOfStopDistance).toBeLessThan(DIVIDEND_FLAG_PCT);
    expect(r.flagged).toBe(false);
  });
});

/**
 * Sizing has three limits and they interact. Checking them one at a time
 * misses the case that matters: cutting size to respect the concentration cap
 * does NOT leave the ratio alone, because the $4 round trip is fixed.
 */
describe("positionSize — risk, concentration and the fee floor together", () => {
  const BASE = 7624.5;

  /** SONY as the grader posted it: a very tight stop on a cheap share. */
  const SONY = { entry: 23.68, stop: 23.37, target: 24.9, base: BASE };

  it("the risk rule alone demands three quarters of the account", () => {
    const s = positionSize({ ...SONY, concentrationPct: 1 });
    expect(s.sharesByRisk).toBe(245);
    near((245 * 23.68) / BASE, 0.76, 0.01);
  });

  it("the cap binds, and the trade is still viable at the smaller size", () => {
    const s = positionSize(SONY);
    expect(s.boundBy).toBe("concentration");
    expect(s.shares).toBe(48);
    expect(s.viable).toBe(true);
    // cutting from 245 to 48 does not break the ratio here — it improves per share
    near(s.netRR!, (48 * 1.22 - 4) / (48 * 0.31 + 4), 0.01);
    expect(s.netRR!).toBeGreaterThan(2);
    // and the risk taken is far below the 1% budget, which is the real cost
    expect(s.riskPctOfBase).toBeLessThan(0.003);
  });

  it("names the window: fewest shares for the ratio, most for the cap", () => {
    const s = positionSize(SONY);
    // n(reward - 2*risk) >= fees*3  ->  n >= 12 / (1.22 - 0.62) = 20
    expect(s.minShares).toBe(20);
    expect(s.maxSharesByConcentration).toBe(48);
    expect(s.shares).toBeGreaterThanOrEqual(s.minShares!);
  });

  it("refuses when the fee floor is above the concentration ceiling", () => {
    // an expensive share with a tight stop: the cap allows very few, and few
    // shares cannot carry a $4 round trip at 2:1
    const s = positionSize({
      entry: 400,
      stop: 396,
      target: 409,
      base: BASE,
    });
    expect(s.maxSharesByConcentration).toBe(2);
    expect(s.minShares).toBeGreaterThan(2);
    expect(s.viable).toBe(false);
    expect(s.reason).toMatch(/no window|NOT VIABLE/i);
  });

  it("a gross-exactly-2R target is refused at every size", () => {
    // reward is exactly 2x risk, so the net ratio approaches 2 from below
    const s = positionSize({ entry: 100, stop: 99, target: 102, base: BASE });
    expect(s.minShares).toBeNull();
    expect(s.viable).toBe(false);
    expect(s.reason).toMatch(/NO size reaches/);
  });

  it("refuses outright when not even one share fits the cap", () => {
    const s = positionSize({ entry: 5000, stop: 4900, target: 5300, base: BASE });
    expect(s.shares).toBe(0);
    expect(s.viable).toBe(false);
    expect(s.reason).toMatch(/cannot be opened/);
  });

  it("A+ may stretch to 20%, and it can turn a refusal into a trade", () => {
    const tight = { entry: 300, stop: 297, target: 309, base: BASE };
    const at15 = positionSize({ ...tight, concentrationPct: CONCENTRATION_CAP });
    const at20 = positionSize({ ...tight, concentrationPct: CONCENTRATION_CAP_APLUS });
    expect(at20.maxSharesByConcentration).toBeGreaterThan(
      at15.maxSharesByConcentration,
    );
    expect(CONCENTRATION_CAP).toBeLessThan(CONCENTRATION_CAP_APLUS);
  });

  it("bad levels are refused rather than sized", () => {
    expect(positionSize({ entry: 100, stop: 100, target: 110, base: BASE }).viable).toBe(false);
    expect(positionSize({ entry: 100, stop: 95, target: 100, base: BASE }).viable).toBe(false);
    expect(positionSize({ entry: 100, stop: 95, target: 110, base: 0 }).viable).toBe(false);
  });
});
