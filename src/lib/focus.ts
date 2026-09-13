/**
 * The focus list, for the screen.
 *
 * The sweep already treats these eight differently — they are swept every run
 * whatever the EMA 200 filter returned. The screen did not, which made the
 * distinction real in the database and invisible in the place decisions are
 * actually made. A focus list you cannot see is a focus list you will not use.
 *
 * Degrades rather than throws: a database that will not answer returns an
 * empty list, and every caller then renders exactly what it rendered before
 * this existed. A page that 500s because the focus list is unavailable would
 * be worse than one that shows an unsorted watchlist.
 */
import { db } from "@/db";
import { coreSymbols } from "@/db/schema";
import { safe } from "@/lib/safe";

export type Focus = {
  /** In list order, for display. */
  list: string[];
  /** For the hot path — every row in a table asks this question. */
  has: (symbol: string) => boolean;
  count: number;
};

export async function loadFocus(): Promise<Focus> {
  const rows =
    (await safe(() => db.select().from(coreSymbols).orderBy(coreSymbols.symbol))) ?? [];
  const set = new Set(rows.map((r) => r.symbol));
  return {
    list: rows.map((r) => r.symbol),
    has: (s: string) => set.has(s),
    count: rows.length,
  };
}

/**
 * Focus names first, then everything else, each side keeping the order the
 * caller already chose.
 *
 * Deliberately NOT a filter. The wide sample is the thing that tells you
 * whether the method works at all, so it stays on the page — it just stops
 * competing for the top of it.
 */
export function focusFirst<T>(rows: T[], focus: Focus, symbolOf: (row: T) => string): T[] {
  const core: T[] = [];
  const rest: T[] = [];
  for (const r of rows) (focus.has(symbolOf(r)) ? core : rest).push(r);
  return [...core, ...rest];
}

/** Split rather than sort, for places that render two separate panels. */
export function splitByFocus<T>(
  rows: T[],
  focus: Focus,
  symbolOf: (row: T) => string,
): { core: T[]; rest: T[] } {
  const core: T[] = [];
  const rest: T[] = [];
  for (const r of rows) (focus.has(symbolOf(r)) ? core : rest).push(r);
  return { core, rest };
}
