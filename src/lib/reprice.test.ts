import { describe, it, expect } from "vitest";
import { repriceRows, type RepriceRow } from "./reprice";

const row = (over: Partial<RepriceRow>): RepriceRow => ({
  symbol: "X",
  triggerLevel: 100,
  distancePct: null,
  pricedSession: null,
  ...over,
});

describe("repriceRows", () => {
  it("measures with the sweep's sign: a demand level below price is negative", () => {
    // The 2026-10-03 case: CCDBF's trigger 66.08 against Friday's 65.97
    // close is +0.167%, which the sweep had stored as -0.542 from Thursday.
    const r = repriceRows(
      [row({ symbol: "CCDBF", triggerLevel: 66.08, distancePct: -0.5418, pricedSession: "2026-10-01" })],
      new Map([["CCDBF", 65.97]]),
      "2026-10-02",
    );
    expect(r.items).toEqual([
      { symbol: "CCDBF", triggerLevel: 66.08, distancePct: 0.1667, pricedSession: "2026-10-02" },
    ]);
  });

  it("is negative when the level sits below price", () => {
    const r = repriceRows([row({ triggerLevel: 98 })], new Map([["X", 100]]), "2026-10-02");
    expect(r.items[0].distancePct).toBe(-2);
  });

  it("leaves a symbol with no close untouched rather than zeroing it", () => {
    const r = repriceRows([row({ distancePct: -1.5 })], new Map(), "2026-10-02");
    expect(r.items).toEqual([]);
    expect(r.missing).toEqual(["X"]);
  });

  it("never moves a row back to an older session", () => {
    const r = repriceRows(
      [row({ pricedSession: "2026-10-02" })],
      new Map([["X", 90]]),
      "2026-10-01",
    );
    expect(r.items).toEqual([]);
    expect(r.current).toEqual(["X"]);
  });

  it("skips a row already priced at this session", () => {
    const r = repriceRows([row({ pricedSession: "2026-10-02" })], new Map([["X", 90]]), "2026-10-02");
    expect(r.current).toEqual(["X"]);
  });

  it("reprices a row whose session is unknown", () => {
    const r = repriceRows([row({ pricedSession: null })], new Map([["X", 90]]), "2026-10-02");
    expect(r.items).toHaveLength(1);
  });

  it("cannot measure a row with no trigger", () => {
    const r = repriceRows([row({ triggerLevel: null })], new Map([["X", 90]]), "2026-10-02");
    expect(r.untriggered).toEqual(["X"]);
  });
});
