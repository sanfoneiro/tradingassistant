/**
 * Which open action item is an incoming one talking about?
 *
 * Pulled out of the ingest route so it can be tested. The route needs a
 * database; this decision does not, and it is the part that was wrong.
 *
 * The bug it exists to prevent, from 2026-08-26: two agents described the
 * same recommendation with different `kind` values — the grader raised
 * "hold the SSB stop" as `review`, the manual sync raised it as `move_stop`.
 * Matching on `(symbol, kind)` alone saw no match, so it closed the first row
 * and opened a second with `firstRaisedAt` reset to now and `timesRepeated`
 * back to one. The same item moved across three rows in twenty-six hours and
 * every one of them read "raised once".
 *
 * That silently defeats the only thing the counter is for. "Close NKE, ninth
 * brief running, -$306 so far" is a number on a screen precisely because the
 * clock survives repetition — and a wording change could zero it.
 */

export type OpenItem = {
  id: number;
  kind: string;
  symbol: string | null;
};

export type IncomingItem = {
  kind: string;
  symbol?: string | null;
};

export type Match<T extends OpenItem = OpenItem> =
  | { type: "exact"; item: T }
  /** Same symbol, different kind, and it is the only thing open for that
   *  symbol — so it is the same recommendation wearing a different label.
   *  History carries; the kind is updated to whatever the agent now calls it. */
  | { type: "kind_changed"; item: T }
  | { type: "new" };

/**
 * Symbol alone is deliberately NOT enough. Two genuinely different
 * recommendations can be open on one name — "close it" and "move the stop"
 * are not the same instruction — so a loose match would merge them and lose
 * one. The `kind_changed` path only fires when exactly one item is open for
 * that symbol, which is the case where there is nothing to confuse it with.
 *
 * Items with no symbol (account-level advice) match on kind alone; there is
 * no symbol to disambiguate them by.
 */
export function matchActionItem<T extends OpenItem>(
  open: T[],
  incoming: IncomingItem,
): Match<T> {
  const symbol = incoming.symbol ?? null;

  const exact = open.find((o) => o.symbol === symbol && o.kind === incoming.kind);
  if (exact) return { type: "exact", item: exact };

  if (symbol != null) {
    const sameSymbol = open.filter((o) => o.symbol === symbol);
    if (sameSymbol.length === 1)
      return { type: "kind_changed", item: sameSymbol[0] };
  }

  return { type: "new" };
}

/**
 * Which open items are no longer being raised — and therefore resolved.
 *
 * An item that was matched by ANY route is still live, including one whose
 * kind changed. Keying this off `kind:symbol` was the second half of the bug:
 * the row that had just been carried forward was then closed again in the
 * same request, because its old kind no longer appeared in the payload.
 */
export function unraisedItems<T extends OpenItem>(
  open: T[],
  matchedIds: Set<number>,
): T[] {
  return open.filter((o) => !matchedIds.has(o.id));
}
