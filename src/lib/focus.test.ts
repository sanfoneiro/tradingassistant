import { describe, it, expect } from "vitest";
import { focusFirst, splitByFocus, type Focus } from "./focus";

const CORE = ["AAPL", "ADBE", "AMZN", "CSCO", "GOOGL", "NFLX", "QCOM", "TXN"];
const focus: Focus = {
  list: CORE,
  has: (s) => CORE.includes(s),
  count: CORE.length,
};
const row = (symbol: string, away = 0) => ({ symbol, away });

describe("focusFirst", () => {
  it("lifts focus names above the rest", () => {
    const out = focusFirst(
      [row("XOM"), row("AAPL"), row("CBRE"), row("NFLX")],
      focus,
      (r) => r.symbol,
    );
    expect(out.map((r) => r.symbol)).toEqual(["AAPL", "NFLX", "XOM", "CBRE"]);
  });

  /* The wide sample is what tells you whether the method works at all. A
   * "focus view" that dropped it would quietly delete the control group. */
  it("keeps every non-focus row rather than filtering it out", () => {
    const rows = [row("XOM"), row("AAPL"), row("CBRE")];
    expect(focusFirst(rows, focus, (r) => r.symbol)).toHaveLength(rows.length);
  });

  it("preserves the caller's ordering inside each side", () => {
    // The watchlist is already sorted closest-to-trigger first, and that
    // ordering must survive the lift.
    const out = focusFirst(
      [row("XOM", 1), row("CBRE", 2), row("NFLX", 3), row("AAPL", 4)],
      focus,
      (r) => r.symbol,
    );
    expect(out.map((r) => r.away)).toEqual([3, 4, 1, 2]);
  });

  it("is a no-op when nothing is on the list", () => {
    const empty: Focus = { list: [], has: () => false, count: 0 };
    const rows = [row("XOM"), row("CBRE")];
    expect(focusFirst(rows, empty, (r) => r.symbol).map((r) => r.symbol)).toEqual([
      "XOM",
      "CBRE",
    ]);
  });
});

describe("splitByFocus", () => {
  it("separates the two lists without losing or duplicating a row", () => {
    const rows = [row("XOM"), row("AAPL"), row("CBRE"), row("NFLX"), row("AMZN")];
    const { core, rest } = splitByFocus(rows, focus, (r) => r.symbol);
    expect(core.map((r) => r.symbol)).toEqual(["AAPL", "NFLX", "AMZN"]);
    expect(rest.map((r) => r.symbol)).toEqual(["XOM", "CBRE"]);
    expect(core.length + rest.length).toBe(rows.length);
  });

  /* A focus name with nothing near a level has no wishlist row at all, so an
   * empty core side is the normal quiet morning — not a missing-data bug. */
  it("returns an empty core side when no focus name is near a level", () => {
    const { core, rest } = splitByFocus(
      [row("XOM"), row("CBRE")],
      focus,
      (r) => r.symbol,
    );
    expect(core).toEqual([]);
    expect(rest).toHaveLength(2);
  });
});
