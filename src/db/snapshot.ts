/**
 * A JSON snapshot of the tables that cannot be regenerated.
 *
 * Bars, zones and screener_coverage are all rebuildable from the API and the
 * engine, so they are not here — the snapshot would be enormous and would age
 * badly. What IS here is everything a human or an agent WROTE: the rules, the
 * journal, the trades and their reviews, the suggestions and their outcomes.
 * Losing those loses the record; losing a bar loses nothing.
 *
 *   npm run db:snapshot            writes backups/snapshot-<date>.json
 */
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from ".";

const TABLES = [
  "accounts", "positions", "orders", "trades", "tags", "trade_tags",
  "journal", "action_items", "rules", "suggestions", "signal_outcomes",
  "wishlist", "price_marks", "catalysts", "runs",
];

async function main() {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    const r: any = await db.execute(sql.raw(`select * from "${t}"`));
    out[t] = r.rows ?? r;
    console.log(`${t.padEnd(16)} ${out[t].length}`);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const path = `backups/snapshot-${stamp}.json`;
  writeFileSync(path, JSON.stringify({ takenAt: new Date().toISOString(), tables: out }, null, 2));
  console.log(`\nwrote ${path}`);
}
main().then(() => process.exit(0));
