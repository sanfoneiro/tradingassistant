import { describe, it, expect } from "vitest";
import { buildQueue } from "./sweep-queue";

const CORE = ["AAPL", "ADBE", "AMZN", "CSCO", "GOOGL", "NFLX", "QCOM", "TXN"];

describe("buildQueue", () => {
  it("sweeps a core name the filter did NOT return", () => {
    // The whole reason the list exists: NFLX is not on the EMA 200 screen.
    const p = buildQueue({ core: CORE, base: ["XOM", "CBRE"], limit: 100 });
    expect(p.queue).toContain("NFLX");
    expect(p.dropped).toEqual([]);
  });

  it("sweeps a core name once when the filter returns it too", () => {
    const p = buildQueue({ core: CORE, base: ["AMZN", "GOOGL", "XOM"], limit: 100 });
    expect(p.queue.filter((s) => s === "AMZN")).toHaveLength(1);
    expect(p.queue.filter((s) => s === "GOOGL")).toHaveLength(1);
    expect(p.queue).toContain("XOM");
  });

  it("puts core at the FRONT, so a capped run cannot skip the list", () => {
    const base = Array.from({ length: 200 }, (_, i) => `S${i}`);
    const p = buildQueue({ core: CORE, base, limit: 20 });
    expect(p.queue.slice(0, CORE.length)).toEqual(CORE);
    expect(p.core).toEqual(CORE);
    expect(p.dropped).toEqual([]);
    expect(p.queue).toHaveLength(20);
  });

  /* The cap is an instruction and is obeyed even when it hurts — but the run
   * has to be able to SAY the list was not covered, rather than reporting a
   * clean sweep over a truncated one. */
  it("names the core symbols a too-small limit cut", () => {
    const p = buildQueue({ core: CORE, base: ["XOM"], limit: 3 });
    expect(p.queue).toEqual(["AAPL", "ADBE", "AMZN"]);
    expect(p.core).toEqual(["AAPL", "ADBE", "AMZN"]);
    expect(p.dropped).toEqual(["CSCO", "GOOGL", "NFLX", "QCOM", "TXN"]);
  });

  it("gives an explicit request exactly what it asked for, core or not", () => {
    const p = buildQueue({ explicit: ["RL"], core: CORE, base: ["XOM"], limit: 100 });
    expect(p.queue).toEqual(["RL"]);
    expect(p.core).toEqual([]);
    expect(p.dropped).toEqual([]);
  });

  it("works with no core list at all — the behaviour before this existed", () => {
    const p = buildQueue({ base: ["XOM", "CBRE"], limit: 100 });
    expect(p.queue).toEqual(["XOM", "CBRE"]);
    expect(p.core).toEqual([]);
  });

  it("preserves the base ordering the app already chose", () => {
    // /api/state returns coverage oldest-analysed first, nulls ahead of all.
    const p = buildQueue({ core: ["AAPL"], base: ["NEW", "OLD", "OLDER"], limit: 100 });
    expect(p.queue).toEqual(["AAPL", "NEW", "OLD", "OLDER"]);
  });

  it("does not fall over on a zero or negative limit", () => {
    expect(buildQueue({ core: CORE, base: ["XOM"], limit: 0 }).queue).toEqual([]);
    expect(buildQueue({ core: CORE, base: ["XOM"], limit: -5 }).queue).toEqual([]);
    expect(buildQueue({ core: CORE, base: ["XOM"], limit: 0 }).dropped).toEqual(CORE);
  });
});
