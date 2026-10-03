import { distancePct } from "./zones";

/**
 * Re-measuring wishlist distances against one session's closes.
 *
 * The sweep prices a row when it recomputes the zones, which takes ~23
 * minutes at five requests a minute and runs once a day from GitHub's
 * scheduler — a scheduler that delays and occasionally drops runs. Grouped
 * daily returns every ticker's close for a session in ONE call, so the grader
 * can re-measure every active row in seconds before it decides what is in
 * the band, rather than trusting a number of unknown age.
 *
 * This moves DISTANCES only. Levels, scores and breaks are facts about the
 * zones and stay the sweep's job: a zone breaks on a close through its distal
 * edge, which is a structural question one close cannot answer for history
 * the sweep has not replayed.
 */

export type RepriceRow = {
  symbol: string;
  triggerLevel: number | null;
  distancePct: number | null;
  pricedSession: string | null;
};

export type RepriceItem = {
  symbol: string;
  /** Sent back so the server can refuse the write if the sweep moved the
   *  trigger between this read and that post. */
  triggerLevel: number;
  distancePct: number;
  pricedSession: string;
};

export type RepriceResult = {
  items: RepriceItem[];
  /** In the wishlist but absent from that session's grouped file. Left
   *  untouched, never zeroed — a missing close is not a close of zero. */
  missing: string[];
  /** Already priced at this session or a later one. */
  current: string[];
  /** No trigger level, so there is nothing to measure against. */
  untriggered: string[];
};

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function repriceRows(
  rows: RepriceRow[],
  closes: Map<string, number>,
  session: string,
): RepriceResult {
  const out: RepriceResult = { items: [], missing: [], current: [], untriggered: [] };
  for (const r of rows) {
    if (r.triggerLevel == null) {
      out.untriggered.push(r.symbol);
      continue;
    }
    // ISO dates compare correctly as strings. Never move a row backwards.
    if (r.pricedSession != null && r.pricedSession >= session) {
      out.current.push(r.symbol);
      continue;
    }
    const close = closes.get(r.symbol);
    if (close == null || !(close > 0)) {
      out.missing.push(r.symbol);
      continue;
    }
    out.items.push({
      symbol: r.symbol,
      triggerLevel: r.triggerLevel,
      distancePct: round4(distancePct(r.triggerLevel, close)),
      pricedSession: session,
    });
  }
  return out;
}
