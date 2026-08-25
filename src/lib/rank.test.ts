import { describe, it, expect } from "vitest";
import {
  deriveQuadrant,
  isWithTrend,
  scoreCandidate,
  overlaps,
  WORTH_OPENING_A_CHART,
  type Candidate,
} from "./rank";

describe("deriveQuadrant", () => {
  it("reads a zone against the trend it sits in", () => {
    expect(deriveQuadrant("uptrend", "demand")).toBe("up_demand");
    expect(deriveQuadrant("downtrend", "supply")).toBe("down_supply");
    expect(deriveQuadrant("uptrend", "supply")).toBe("up_supply");
    expect(deriveQuadrant("downtrend", "demand")).toBe("down_demand");
  });

  it("a contested trend makes every zone contested — the shape alone says nothing", () => {
    expect(deriveQuadrant("contested", "demand")).toBe("contested");
    expect(deriveQuadrant("contested", "supply")).toBe("contested");
    expect(deriveQuadrant(null, "demand")).toBe("contested");
  });

  it("only the two with-trend quadrants count as with-trend", () => {
    expect(isWithTrend("up_demand")).toBe(true);
    expect(isWithTrend("down_supply")).toBe(true);
    expect(isWithTrend("up_supply")).toBe(false);
    expect(isWithTrend("down_demand")).toBe(false);
    expect(isWithTrend("contested")).toBe(false);
  });
});

const base: Candidate = {
  quadrant: "up_demand",
  timeframe: "1W",
  fresh: true,
  confluence: true,
  distancePct: 0,
};

describe("scoreCandidate", () => {
  it("the best possible structure scores near 100", () => {
    const s = scoreCandidate(base);
    expect(s.score).toBeGreaterThan(95);
  });

  it("the worst scores near zero and says why", () => {
    const s = scoreCandidate({
      quadrant: "contested",
      timeframe: "1D",
      fresh: false,
      confluence: false,
      distancePct: 1.9,
    });
    expect(s.score).toBeLessThan(15);
    expect(s.reasons.some((r) => /no trend/.test(r))).toBe(true);
  });

  it("trend direction outweighs every other single factor", () => {
    // A countertrend setup with everything else perfect must still rank below
    // a with-trend one that has nothing else going for it — that is the whole
    // claim the quadrant model makes.
    const counter = scoreCandidate({ ...base, quadrant: "down_demand" });
    const withTrend = scoreCandidate({
      quadrant: "up_demand",
      timeframe: "1D",
      fresh: false,
      confluence: false,
      distancePct: 1.9,
    });
    expect(withTrend.score).toBeGreaterThan(counter.score);
  });

  it("confluence is worth more than the timeframe or freshness alone", () => {
    const withConf = scoreCandidate({ ...base, timeframe: "1D", fresh: false });
    const noConf = scoreCandidate({ ...base, confluence: false, timeframe: "1D", fresh: false });
    expect(withConf.score - noConf.score).toBe(20);
  });

  /**
   * The property the weights exist to guarantee, not a sampled example:
   * every with-trend setup outranks every countertrend one, whatever else is
   * true of either. If this ever fails, a weight was changed without checking
   * what the quadrant model claims.
   */
  it("the WORST with-trend setup outranks the BEST countertrend one", () => {
    const worstWithTrend = scoreCandidate({
      quadrant: "up_demand", timeframe: "1D", fresh: false,
      confluence: false, distancePct: 2,
    });
    const bestCountertrend = scoreCandidate({
      quadrant: "down_demand", timeframe: "1W", fresh: true,
      confluence: true, distancePct: 0,
    });
    expect(worstWithTrend.score).toBeGreaterThan(bestCountertrend.score);
  });

  it("proximity barely matters — everything here is already at its level", () => {
    const atLevel = scoreCandidate({ ...base, distancePct: 0 });
    const edgeOfBand = scoreCandidate({ ...base, distancePct: 2 });
    expect(atLevel.score - edgeOfBand.score).toBeLessThanOrEqual(5);
  });

  it("distance is signed-agnostic — above or below the level score the same", () => {
    expect(scoreCandidate({ ...base, distancePct: 1.2 }).score).toBe(
      scoreCandidate({ ...base, distancePct: -1.2 }).score,
    );
  });

  it("every score carries the reasons behind it", () => {
    const s = scoreCandidate(base);
    expect(s.reasons).toContain("with-trend (up_demand)");
    expect(s.reasons).toContain("daily and weekly agree at this price");
    expect(s.reasons).toContain("fresh — never traded into");
  });
});

describe("the cutoff separates a setup from structure-by-accident", () => {
  it("a with-trend weekly zone clears it on its own", () => {
    const s = scoreCandidate({
      quadrant: "down_supply",
      timeframe: "1W",
      fresh: false,
      confluence: false,
      distancePct: 1.5,
    });
    expect(s.score).toBeGreaterThanOrEqual(WORTH_OPENING_A_CHART);
  });

  it("a countertrend mitigated daily zone never does, however close", () => {
    const s = scoreCandidate({
      quadrant: "up_supply",
      timeframe: "1D",
      fresh: false,
      confluence: false,
      distancePct: 0,
    });
    expect(s.score).toBeLessThan(WORTH_OPENING_A_CHART);
  });

  it("a contested name cannot clear it even with confluence and freshness", () => {
    const s = scoreCandidate({
      quadrant: "contested",
      timeframe: "1W",
      fresh: true,
      confluence: true,
      distancePct: 0,
    });
    expect(s.score).toBeLessThan(WORTH_OPENING_A_CHART);
  });
});

describe("overlaps", () => {
  it("treats levels within a percent of each other as the same price", () => {
    expect(overlaps(100, 100.5)).toBe(true);
    expect(overlaps(100, 102)).toBe(false);
  });

  it("works at both ends of the price range", () => {
    expect(overlaps(3.0, 3.02)).toBe(true);
    expect(overlaps(700, 703)).toBe(true);
    expect(overlaps(700, 720)).toBe(false);
  });

  it("rejects nonsense rather than dividing by zero", () => {
    expect(overlaps(0, 0)).toBe(false);
    expect(overlaps(-5, 5)).toBe(false);
  });
});
