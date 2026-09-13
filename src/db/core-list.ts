/**
 * The focus list: names swept every day whatever the saved screen returns.
 *
 * Why this is a table and not an edit to the screener — the saved "EMA 200"
 * screen is a FILTER. Symbols enter and leave it as they pass or fail, so a
 * name cannot be pinned there by hand, and bending the filter to include one
 * would also corrupt the wide sample that exists to test whether the method
 * works at all. Narrow for trading, wide for measurement, and the two must
 * not be the same list.
 *
 * The first eight were chosen on 2026-09-14 from `npm run shortlist`, and
 * NOT on backtested performance: every name in that screen was statistically
 * indistinguishable from every other (z inside +/-2 on 1,043 decided
 * outcomes). What separated them was tradeability on a $7,523 account —
 * whether a position can be sized with room to scale out, and whether price
 * gaps through resting limit orders.
 *
 * Two things about that list are worth knowing before trusting it:
 *
 *   - The thresholds (>= 8 shares, < 15% gap frequency) are Oron's accepted
 *     defaults but were round numbers I proposed, not numbers anything
 *     derived. They are recorded here so a later review argues with them
 *     rather than rediscovering them.
 *   - It is a function of ACCOUNT SIZE. MSFT, META, NVDA, AVGO and AMD were
 *     cut mostly because $7,523 cannot size them with room to scale, not
 *     because of anything about the companies. Re-run the shortlist when the
 *     base changes materially.
 *
 *   npm run core:list                       show the list
 *   npm run core:list -- --seed             write the agreed eight
 *   npm run core:list -- --add NVDA "why"   add one
 *   npm run core:list -- --remove NVDA      drop one
 */
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from ".";
import { coreSymbols } from "./schema";

/** The eight, with the numbers that put them there — from the 2026-09-14
 *  shortlist run against bars through 2026-09-03. `sh` is shares at the 45%
 *  cap and 1% risk; `gap` is the share of sessions opening more than 2% from
 *  the prior close; `corr` is 250-session correlation to QQQ. */
const SEED: { symbol: string; note: string }[] = [
  { symbol: "AMZN", note: "sh 12, gap 10.1%, corr 0.48 — also the only core name already on the screen alongside GOOGL" },
  { symbol: "GOOGL", note: "sh 8, gap 9.5%, corr 0.49 — at the share-count threshold, not above it" },
  { symbol: "AAPL", note: "sh 10, gap 4.6%, corr 0.24 — second-lowest gap frequency in the candidate set" },
  { symbol: "NFLX", note: "sh 34, gap 5.5%, corr 0.05 — the most decorrelated name here, and the easiest to size" },
  { symbol: "CSCO", note: "sh 31, gap 3.4%, corr 0.41 — lowest gap frequency of all 23 candidates" },
  { symbol: "ADBE", note: "sh 10, gap 9.7%, corr 0.00 — decorrelated from QQQ over the last 250 sessions" },
  { symbol: "QCOM", note: "sh 16, gap 14.9%, corr 0.56 — passes the gap test by 0.1pp; the marginal name on the list" },
  { symbol: "TXN", note: "sh 10, gap 13.9%, corr 0.51 — the other borderline gap case" },
];

async function show() {
  const rows = await db.select().from(coreSymbols).orderBy(coreSymbols.symbol);
  if (!rows.length) {
    console.log("The core list is empty. Seed it:  npm run core:list -- --seed");
    return;
  }
  console.log(`${rows.length} name(s) on the focus list:\n`);
  for (const r of rows)
    console.log(`  ${r.symbol.padEnd(6)} ${r.note ?? "(no note)"}`);

  /* Which of them the filter happens to return this week. This is reported
   * rather than enforced: a core name falling off the screen is the normal
   * case and the whole reason the list exists. */
  const onScreen: any = await db.execute(
    sql`select c.symbol from core_symbols c
        join screener_coverage s on s.symbol = c.symbol order by 1`,
  );
  const names = (onScreen.rows ?? onScreen).map((r: any) => r.symbol);
  console.log(
    `\n${names.length} of ${rows.length} are also on the saved screen this week` +
      (names.length ? `: ${names.join(", ")}` : "") +
      `.\nThe rest are swept because they are on this list, which is the point.`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv.slice(i + 1).filter((a) => !a.startsWith("--")) : null;
  };

  const add = flag("--add");
  const remove = flag("--remove");

  if (argv.includes("--seed")) {
    for (const s of SEED)
      await db
        .insert(coreSymbols)
        .values(s)
        .onConflictDoUpdate({ target: coreSymbols.symbol, set: { note: s.note } });
    console.log(`seeded ${SEED.length} names`);
  } else if (add?.length) {
    const [symbol, ...rest] = add;
    await db
      .insert(coreSymbols)
      .values({ symbol: symbol.toUpperCase(), note: rest.join(" ") || null })
      .onConflictDoUpdate({
        target: coreSymbols.symbol,
        set: { note: rest.join(" ") || null },
      });
    console.log(`added ${symbol.toUpperCase()}`);
  } else if (remove?.length) {
    const symbol = remove[0].toUpperCase();
    await db.delete(coreSymbols).where(eq(coreSymbols.symbol, symbol));
    console.log(`removed ${symbol}`);
  }

  console.log();
  await show();
}

main().then(() => process.exit(0));
