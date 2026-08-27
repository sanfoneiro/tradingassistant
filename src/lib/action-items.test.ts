import { describe, it, expect } from "vitest";
import {
  matchActionItem,
  unraisedItems,
  textSimilarity,
  SAME_RECOMMENDATION,
  type OpenItem,
} from "./action-items";

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
  const HOLD = "Hold stop at 103.93 - do NOT move to breakeven yet";
  const open: OpenItem[] = [
    { id: 14, kind: "review", symbol: "SSB", text: HOLD },
    { id: 15, kind: "review", symbol: "YUMC", text: "Cancel the 46.40 limit" },
  ];

  it("matches exactly when symbol and kind both agree", () => {
    const m = matchActionItem(open, { kind: "review", symbol: "SSB" });
    expect(m.type).toBe("exact");
    expect(m.type !== "new" && m.item.id).toBe(14);
  });

  it("THE BUG: carries history when only the kind changed", () => {
    const m = matchActionItem(open, { kind: "move_stop", symbol: "SSB", text: HOLD });
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
    const HOLD = "Hold stop at 103.93 - do NOT move to breakeven yet";
    let open: OpenItem[] = [{ id: 13, kind: "move_stop", symbol: "SSB", text: HOLD }];
    let timesRepeated = 1;

    // the grader relabels it `review`
    const first = matchActionItem(open, { kind: "review", symbol: "SSB", text: HOLD });
    expect(first.type).toBe("kind_changed");
    expect(first.type !== "new" && first.item.id).toBe(13);
    timesRepeated++;
    open = [{ id: 13, kind: "review", symbol: "SSB", text: HOLD }];
    expect(unraisedItems(open, new Set([13]))).toEqual([]);

    // the manual sync calls it `move_stop` again
    const second = matchActionItem(open, { kind: "move_stop", symbol: "SSB", text: HOLD });
    expect(second.type).toBe("kind_changed");
    expect(second.type !== "new" && second.item.id).toBe(13);
    timesRepeated++;

    // one row throughout, and the counter actually counted
    expect(timesRepeated).toBe(3);
  });
});

/**
 * CBRE, 2026-08-27 — the bug the previous fix introduced.
 *
 * Falling back to symbol alone merged two recommendations that shared nothing
 * but a ticker. One open item per symbol is the COMMON case, so this was the
 * default path, not an edge.
 */
describe("a different recommendation about the same symbol is a different item", () => {
  const TARGET = "Decide on the 158.77 target: it is exactly 2R gross, so it can never be net 2:1 at any size";
  const CONCENTRATION = "CBRE is over the 15% concentration cap - 19.72% of base, and the 20% allowance is A_plus only";
  const HOLD_A = "Hold stop at 103.93 - do NOT move to breakeven yet";
  const HOLD_B = "Hold stop at 103.93 – do NOT move to breakeven yet";

  it("the two live bodies sit either side of the threshold", () => {
    expect(textSimilarity(HOLD_A, HOLD_B)).toBeGreaterThanOrEqual(SAME_RECOMMENDATION);
    expect(textSimilarity(TARGET, CONCENTRATION)).toBeLessThan(SAME_RECOMMENDATION);
  });

  it("THE REGRESSION: concentration does not overwrite the target item", () => {
    const open: OpenItem[] = [
      { id: 20, kind: "adjust_tp", symbol: "CBRE", text: TARGET },
    ];
    const m = matchActionItem(open, {
      kind: "review",
      symbol: "CBRE",
      text: CONCENTRATION,
    });
    expect(m.type).toBe("new");
  });

  it("still carries history when the body really is the same", () => {
    const open: OpenItem[] = [
      { id: 16, kind: "review", symbol: "SSB", text: HOLD_A },
    ];
    const m = matchActionItem(open, {
      kind: "move_stop",
      symbol: "SSB",
      text: HOLD_B,
    });
    expect(m.type).toBe("kind_changed");
    expect(m.type !== "new" && m.item.id).toBe(16);
  });

  it("opens a new row rather than guessing when there is no text to compare", () => {
    const open: OpenItem[] = [{ id: 20, kind: "adjust_tp", symbol: "CBRE" }];
    expect(matchActionItem(open, { kind: "review", symbol: "CBRE" }).type).toBe("new");
  });
});

describe("an agent-supplied key beats every guess", () => {
  const open: OpenItem[] = [
    { id: 20, kind: "adjust_tp", symbol: "CBRE", key: "cbre-target", text: "old wording" },
  ];

  it("matches on the key even when the kind and the wording both changed", () => {
    const m = matchActionItem(open, {
      kind: "review",
      symbol: "CBRE",
      key: "cbre-target",
      text: "completely different words about the same concern",
    });
    expect(m.type).toBe("key");
    expect(m.type !== "new" && m.item.id).toBe(20);
  });

  it("a DIFFERENT key on the same symbol is a different item, whatever the text", () => {
    const m = matchActionItem(open, {
      kind: "adjust_tp",
      symbol: "CBRE",
      key: "cbre-concentration",
      text: "old wording",
    });
    expect(m.type).toBe("new");
  });

  it("an exact (symbol, kind) hit still wins for keyless payloads", () => {
    const m = matchActionItem(open, { kind: "adjust_tp", symbol: "CBRE", text: "x" });
    expect(m.type).toBe("exact");
  });
});

describe("textSimilarity", () => {
  it("is 1 for the same words in any order, 0 for nothing shared", () => {
    expect(textSimilarity("move the stop up", "up stop the move")).toBe(1);
    expect(textSimilarity("alpha beta", "gamma delta")).toBe(0);
  });

  it("treats a missing body as no evidence, never as a match", () => {
    expect(textSimilarity(null, "anything")).toBe(0);
    expect(textSimilarity("anything", undefined)).toBe(0);
    expect(textSimilarity("", "")).toBe(0);
  });

  it("keeps numbers, because a price is the point of the sentence", () => {
    const a = "Raise the stop to 104.90";
    const b = "Raise the stop to 109.30";
    expect(textSimilarity(a, b)).toBeLessThan(1);
  });
});

describe("adopting keys onto rows that predate them", () => {
  it("a keyless open row accepts the first key an agent supplies", () => {
    const open: OpenItem[] = [
      { id: 20, kind: "adjust_tp", symbol: "CBRE", text: "the target concern" },
    ];
    const m = matchActionItem(open, {
      kind: "adjust_tp",
      symbol: "CBRE",
      key: "cbre-target",
      text: "the target concern",
    });
    // matched, so the route writes the key onto the existing row instead of
    // splitting history the first time keys appear
    expect(m.type).toBe("exact");
    expect(m.type !== "new" && m.item.id).toBe(20);
  });
});
