/**
 * Batched reads from the `bars` table, for the analysis scripts.
 *
 * `bars-store.loadBars` takes one symbol per call and a raw postgres.js
 * handle, which suits the sweep. A screen over two dozen names wants one
 * round trip, so this is the batched sibling — but it deliberately reuses
 * `barTime` rather than parsing the date itself, so a timestamp produced here
 * is the same number the sweep would produce for the same session. Midnight
 * ET, not midnight UTC: the stored DATE has no time in it, and picking a
 * different convention per tool is how two parts of a system come to disagree
 * about which session a zone was created in.
 */
import { inArray } from "drizzle-orm";
import { db } from ".";
import { bars as barsTable } from "./schema";
import { barTime } from "../lib/bars-store";
import type { Bar } from "../lib/zones";

export async function readBars(symbols: string[]): Promise<Map<string, Bar[]>> {
  // inArray, not sql`= any(...)`: drizzle expands a JS array into a tuple,
  // which Postgres rejects as the right side of ANY.
  const rows = await db
    .select()
    .from(barsTable)
    .where(inArray(barsTable.symbol, symbols))
    .orderBy(barsTable.symbol, barsTable.d);

  const by = new Map<string, Bar[]>();
  for (const row of rows) {
    if (!by.has(row.symbol)) by.set(row.symbol, []);
    by.get(row.symbol)!.push({
      t: barTime(row.d),
      o: row.o,
      h: row.h,
      l: row.l,
      c: row.c,
    });
  }
  return by;
}
