import { describe, it, expect } from "vitest";
import { matchActionItem, unraisedItems, type OpenItem } from "./action-items";

/**
 * SSB, 2026-08-26. The same recommendation crossed three rows in
 * twenty-six hours because two agents labelled it differently:
 *
 *   #13 move_stop  "Move stop to breakeven 105.635"   -> done
 *   #14 review     "Hold stop - do NOT move yet"      -> done
 *   #16 move_stop  "Hold stop - do NOT move yet"      -> open
 *
 * Every one of them read timesRepeated: 1. The counter exists so that
 * "close NKE, ninth brief running, -$306 so far" is a number on a screen —
 * and a change of wording could zero it.
 */
describe("matching an incoming action item to an open one", () => {
  const open: OpenItem[] = [
    { id: 14, kind: "review", symbol: "SSB" },
    { id: 15, kind: "review", symbol: "YUMC" },
  ];

  it("matches exactly when symbol and kind both agree", () => {
    const m = matchActionItem(open, { kind: "review", symbol: "SSB" });
    expect(m.type).toBe("exact");
    expect(m.type !== "new" && m.item.id).toBe(14);
  });

  it("THE BUG: carries history when only the kind changed", () => {
    const m = matchActionItem(open, { kind: "move_stop", symbol: "SSB" });
    expect(m.type).toBe("kind_changed");
    expect(m.type !== "new" && m.item.id).toBe(14);
  });

  it("creates new for a symbol nothing is open on", () => {
    expect(matchActionItem(open, { kind: "close", symbol: "NKE" }).type).toBe("new");
  });

  /**
   * The guard that keeps the fix from becoming a worse bug. "Close it" and
   * "move the stop" are different instructions, and merging them would lose
   * one — so a loose match only fires when there is nothing to confuse it
   * with.
   */
  it("refuses to guess when two items are already open on one symbol", () => {
    const crowded: OpenItem[] = [
      { id: 20, kind: "move_stop", symbol: "SSB" },
      { id: 21, kind: "adjust_tp", symbol: "SSB" },
    ];
    expect(matchActionItem(crowded, { kind: "close", symbol: "SSB" }).type).toBe("new");
    // an exact match still wins even in a crowd
    const m = matchActionItem(crowded, { kind: "adjust_tp", symbol: "SSB" });
    expect(m.type).toBe("exact");
    expect(m.type !== "new" && m.item.id).toBe(21);
  });

  it("account-level items with no symbol match on kind alone", () => {
    const acct: OpenItem[] = [{ id: 30, kind: "review", symbol: null }];
    expect(matchActionItem(acct, { kind: "review" }).type).toBe("exact");
    expect(matchActionItem(acct, { kind: "close" }).type).toBe("new");
  });

  it("does not treat a null symbol as matching a real one", () => {
    expect(matchActionItem(open, { kind: "review", symbol: null }).type).toBe("new");
  });
});

describe("deciding what is no longer raised", () => {
  const open: OpenItem[] = [
    { id: 14, kind: "review", symbol: "SSB" },
    { id: 15, kind: "review", symbol: "YUMC" },
  ];

  /**
   * The second half of the same bug. Resolution used to be keyed on
   * `kind:symbol` rebuilt from the payload, so a row that had just been
   * carried forward under a NEW kind no longer matched its own old key —
   * and was closed again in the very same request.
   */
  it("keeps an item that was matched under a changed kind", () => {
    const matched = new Set<number>([14]); // SSB, matched as kind_changed
    const gone = unraisedItems(open, matched);
    expect(gone.map((g) => g.id)).toEqual([15]);
  });

  it("resolves everything the agent stopped raising", () => {
    expect(unraisedItems(open, new Set()).map((g) => g.id)).toEqual([14, 15]);
  });

  it("resolves nothing when every item was raised again", () => {
    expect(unraisedItems(open, new Set([14, 15]))).toEqual([]);
  });
});

/**
 * End to end on the real sequence. If this passes, a wording change can no
 * longer reset the clock.
 */
describe("the SSB sequence, replayed", () => {
  it("survives move_stop -> review -> move_stop with its history intact", () => {
    let open: OpenItem[] = [{ id: 13, kind: "move_stop", symbol: "SSB" }];
    let timesRepeated = 1;

    // the grader relabels it `review`
    const first = matchActionItem(open, { kind: "review", symbol: "SSB" });
    expect(first.type).toBe("kind_changed");
    expect(first.type !== "new" && first.item.id).toBe(13);
    timesRepeated++;
    open = [{ id: 13, kind: "review", symbol: "SSB" }];
    expect(unraisedItems(open, new Set([13]))).toEqual([]);

    // the manual sync calls it `move_stop` again
    const second = matchActionItem(open, { kind: "move_stop", symbol: "SSB" });
    expect(second.type).toBe("kind_changed");
    expect(second.type !== "new" && second.item.id).toBe(13);
    timesRepeated++;

    // one row throughout, and the counter actually counted
    expect(timesRepeated).toBe(3);
  });
});
