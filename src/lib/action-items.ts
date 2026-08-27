/**
 * Which open action item is an incoming one talking about?
 *
 * Pulled out of the ingest route so it can be tested. The route needs a
 * database; this decision does not, and it is the part that keeps being wrong.
 *
 * Two bugs, in order, because the second was caused by the fix for the first.
 *
 * **2026-08-26.** Matching on `(symbol, kind)` alone lost an item's history
 * whenever two agents labelled one recommendation differently. The grader
 * raised "hold the SSB stop" as `review`; the sync raised the same sentence as
 * `move_stop`. No match, so the first row closed and a second opened with
 * `firstRaisedAt` reset. SSB crossed three rows in twenty-six hours and each
 * read "raised once", which defeats the only thing the counter is for.
 *
 * **2026-08-27.** The fix for that — fall back to symbol alone when exactly
 * one item is open — merged two recommendations that had nothing to do with
 * each other. CBRE was open as `adjust_tp` ("decide on the 158.77 target");
 * the next sync raised `review` ("CBRE is over the 15% concentration cap").
 * One open row for that symbol, so the matcher called it the same item: it
 * overwrote the text, kept the old `firstRaisedAt`, and reported two raises of
 * a thing that had been raised once. Cost of delay was then measured from an
 * unrelated event.
 *
 * One open item per symbol is the COMMON case, so that was not a rare edge —
 * it was the default path.
 *
 * The lesson is that identity is not something to infer. It is something the
 * agent should assert, with the heuristic kept only for payloads that do not.
 */

export type OpenItem = {
  id: number;
  kind: string;
  symbol: string | null;
  /** Agent-supplied stable identity, when it gave one. */
  key?: string | null;
  text?: string | null;
};

export type IncomingItem = {
  kind: string;
  symbol?: string | null;
  /** A short slug the agent controls, stable across runs for the same
   *  recommendation — `ssb-hold-stop`, `cbre-concentration`. Supplying it
   *  turns identity from a guess into an assertion. */
  key?: string | null;
  text?: string | null;
};

export type Match<T extends OpenItem = OpenItem> =
  | { type: "key"; item: T }
  | { type: "exact"; item: T }
  /** Same symbol, different label, and the body still says the same thing. */
  | { type: "kind_changed"; item: T }
  | { type: "new" };

/** Words shared, as a fraction of words used. Cheap, order-insensitive, and
 *  enough to tell a re-wording from a different subject. */
export function textSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const words = (t: string) =>
    new Set(
      t
        .toLowerCase()
        .replace(/[^a-z0-9.\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
  if (!a || !b) return 0;
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * Above this, a relabelled item is the same recommendation. Below it, the
 * body has changed subject and deserves its own row and its own clock.
 *
 * The two live cases sit far apart: the SSB pair differ only in a dash and
 * score ~1.0; the CBRE pair — a target concern versus a concentration
 * breach — share almost nothing.
 */
export const SAME_RECOMMENDATION = 0.5;

export function matchActionItem<T extends OpenItem>(
  open: T[],
  incoming: IncomingItem,
): Match<T> {
  const symbol = incoming.symbol ?? null;

  // 1. The agent said which item this is. Believe it.
  if (incoming.key) {
    const byKey = open.find((o) => o.key && o.key === incoming.key);
    if (byKey) return { type: "key", item: byKey };
  }

  // 2. Same symbol and same label.
  const exact = open.find((o) => o.symbol === symbol && o.kind === incoming.kind);
  if (exact) {
    /**
     * A key that does not match is a statement, not a gap. If the agent says
     * this is `cbre-concentration` and the open row says `cbre-target`, they
     * are different items however alike their labels look — and the whole
     * point of the key is that it outranks the guess.
     *
     * A candidate with NO key is the migration case: the agent has only just
     * started supplying them, so adopt it onto the existing row rather than
     * splitting history the first time a key appears.
     */
    if (incoming.key && exact.key && exact.key !== incoming.key)
      return { type: "new" };
    return { type: "exact", item: exact };
  }

  /**
   * 3. Same symbol, one open item, and the text still says the same thing.
   *
   * The similarity check is what stops this becoming the CBRE bug again. A
   * relabelled item keeps its history; a different recommendation about the
   * same symbol gets its own row, because merging them would date the cost of
   * delay from something that never happened.
   *
   * An incoming item that carries a key never lands here: if the key did not
   * match, the agent is telling us this is a different item.
   */
  if (symbol != null && !incoming.key) {
    const sameSymbol = open.filter((o) => o.symbol === symbol);
    if (sameSymbol.length === 1) {
      const candidate = sameSymbol[0];
      if (textSimilarity(candidate.text, incoming.text) >= SAME_RECOMMENDATION)
        return { type: "kind_changed", item: candidate };
    }
  }

  return { type: "new" };
}

/**
 * Which open items are no longer being raised — and therefore resolved.
 *
 * Keyed on the ids actually matched, not on a `kind:symbol` string rebuilt
 * from the payload. The old version closed the very row it had just carried
 * forward, because its new kind no longer matched its old key.
 */
export function unraisedItems<T extends OpenItem>(
  open: T[],
  matchedIds: Set<number>,
): T[] {
  return open.filter((o) => !matchedIds.has(o.id));
}
