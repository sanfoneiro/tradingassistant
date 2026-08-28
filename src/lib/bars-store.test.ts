import { describe, it, expect } from "vitest";
import { barTime, MIN_BARS_FOR_TREND } from "./bars-store";
import { classifyTrend, type Bar } from "./zones";

describe("barTime", () => {
  /**
   * The stored column is a session DATE, because grouped daily and the
   * per-ticker endpoint stamp the same session sixteen hours apart. Reading
   * it back has to reproduce the per-ticker convention exactly, or the two
   * sweep paths are not comparable.
   *
   * 1787716800000 is a real value returned by the API for NKE, 2026-08-26.
   */
  it("reproduces the per-ticker endpoint's stamp for a session date", () => {
    expect(barTime("2026-08-26")).toBe(1787716800000);
    expect(new Date(barTime("2026-08-26")).toISOString()).toBe(
      "2026-08-26T04:00:00.000Z",
    );
  });

  it("uses the right offset either side of the DST change", () => {
    // EDT: midnight ET is 04:00Z. EST: 05:00Z. US DST ends 2026-11-01.
    expect(new Date(barTime("2026-08-26")).toISOString()).toBe("2026-08-26T04:00:00.000Z");
    expect(new Date(barTime("2026-12-09")).toISOString()).toBe("2026-12-09T05:00:00.000Z");
  });
});

/**
 * The reason MIN_BARS_FOR_TREND exists, asserted rather than assumed.
 *
 * A short history does not produce a wrong trend, it produces `contested` —
 * and rank.ts guarantees by construction that no contested name can clear the
 * bar. So sweeping against a half-filled bars table would not surface bad
 * candidates, it would surface NONE, and the run would look clean while the
 * funnel quietly emptied.
 */
describe("the floor under classifyTrend", () => {
  const rising = (n: number): Bar[] =>
    Array.from({ length: n }, (_, i) => ({
      t: barTime("2026-01-02") + i * 86_400_000,
      o: 100 + i,
      h: 101 + i,
      l: 99 + i,
      c: 100 + i,
    }));

  it("returns contested — not a trend — when history is below the floor", () => {
    const { trend } = classifyTrend(rising(MIN_BARS_FOR_TREND - 1));
    expect(trend).toBe("contested");
  });

  /**
   * The floor is set by the LOOKBACK, not the EMA. At 219 bars the average
   * itself is available — ema() yields a value from bar 200 — but
   * `line.at(-21)` still lands on a null, so the trend cannot be told rising
   * from falling. Checking `ma !== null` would therefore have reported a
   * healthy classification on data that produces contested.
   */
  it("is the lookback that binds, not the average", () => {
    const justShort = classifyTrend(rising(MIN_BARS_FOR_TREND - 1));
    expect(justShort.ma).not.toBeNull(); // the average IS available
    expect(justShort.trend).toBe("contested"); // and still no trend
  });

  it("classifies the same shape once the floor is met", () => {
    // Precondition: identical data, only longer. If this did not flip, the
    // test above would be passing for the wrong reason.
    const long = rising(MIN_BARS_FOR_TREND + 40);
    const { trend, ma } = classifyTrend(long);
    expect(ma).not.toBeNull();
    expect(trend).toBe("uptrend");
  });

  it("the floor is at least the EMA period plus its lookback", () => {
    // classifyTrend(bars, period = 200, lookback = 20) needs period + lookback
    // bars before `past` is non-null.
    expect(MIN_BARS_FOR_TREND).toBeGreaterThanOrEqual(220);
  });
});
