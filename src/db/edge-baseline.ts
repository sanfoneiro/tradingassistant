/**
 * Does a zone beat NO zone? The control the trend split never had.
 *
 * Every zone in the store is replayed as the trade it implies AND as the same
 * order placed where there is no zone — see src/lib/edge-baseline.ts for what
 * each variant isolates. A method earns money only if it beats its own
 * control; beating other zones proves nothing about any of them.
 *
 * The universe is split into two fixed halves by a hash of the symbol. Design
 * a change on half A, then confirm it on half B, which it has never seen. A
 * result that only holds on the half it was tuned on is the backtest lying.
 *
 *   npm run edge:baseline                  half A, first 600 symbols
 *   npm run edge:baseline -- --half b      the confirmation half
 *   npm run edge:baseline -- --all         both halves
 *   npm run edge:baseline -- --limit 300   fewer symbols, faster
 *   npm run edge:baseline -- AAPL MSFT     an explicit list
 *
 * First run 2026-10-07 (CLAUDE.md, "Does a zone beat no zone?"): the zone's
 * price matched a random nearby level, its timing lost to a random date, and
 * the rejection rule matched the same rule at a random level.
 */
import { sql } from "drizzle-orm";
import { db } from ".";
import { readBars } from "./read-bars";
import { MIN_BARS_FOR_TREND } from "../lib/bars-store";
import { FEES, TARGET_R } from "../lib/zone-backtest";
import { isWithTrend } from "../lib/rank";
import {
  VARIANTS,
  edgeTrades,
  summariseEdge,
  bootstrapDiff,
  mulberry32,
  symbolHalf,
  type EdgeTrade,
  type Variant,
} from "../lib/edge-baseline";

const SEED = 20261007;
const DEFAULT_LIMIT = 600;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes("--all");
  const half = (arg(argv, "--half") ?? "a").toLowerCase();
  const limit = Number(arg(argv, "--limit") ?? DEFAULT_LIMIT);
  const flagValues = new Set([arg(argv, "--half"), arg(argv, "--limit")]);
  const named = argv
    .filter((a) => !a.startsWith("-") && !flagValues.has(a))
    .map((s) => s.toUpperCase());

  let symbols = named;
  if (!named.length) {
    const r: any = await db.execute(sql`
      select symbol from bars group by symbol
      having count(*) >= ${MIN_BARS_FOR_TREND} order by symbol
    `);
    symbols = (r.rows ?? r)
      .map((x: any) => x.symbol as string)
      .filter((s: string) => all || symbolHalf(s) === half)
      .slice(0, all ? Infinity : limit);
  }

  const acct: any = await db.execute(sql`select sizing_base from accounts limit 1`);
  const base = Number((acct.rows ?? acct)[0]?.sizing_base ?? 7600);
  const riskBudget = base * 0.01;

  const bars = await readBars(symbols);
  const rnd = mulberry32(SEED);
  const trades: EdgeTrade[] = [];
  let used = 0;
  for (const s of symbols) {
    const b = bars.get(s);
    if (!b || b.length < MIN_BARS_FOR_TREND) continue;
    used++;
    trades.push(...edgeTrades(s, b, { riskBudget, fees: FEES, rnd }));
  }
  const zones = trades.filter((t) => t.variant === "zone");
  if (!zones.length) {
    console.log("No zone trades — nothing to compare.");
    return;
  }

  console.log(
    `${used} symbols (${named.length ? "named" : all ? "both halves" : `half ${half.toUpperCase()}`}), ` +
      `${zones.length} zones. Stop beyond the distal edge and >= 1 ADR, target ${TARGET_R}R, ` +
      `$${FEES} a round trip at a $${riskBudget.toFixed(0)} risk budget. R is measured on the ` +
      `PLANNED stop; "all-in" adds unresolved trades marked at the end of the window.`,
  );

  const row = (v: Variant, ts: EdgeTrade[]) => {
    const s = summariseEdge(ts.filter((t) => t.variant === v));
    return {
      variant: v,
      decided: s.decided,
      "win%": s.winRate == null ? null : +(100 * s.winRate).toFixed(1),
      avgR: s.avgR == null ? null : +s.avgR.toFixed(3),
      "all-in R": s.avgRAllIn == null ? null : +s.avgRAllIn.toFixed(3),
    };
  };
  const table = (label: string, ts: EdgeTrade[]) => {
    console.log(`\n=== ${label} ===`);
    console.table(VARIANTS.map((v) => row(v, ts)));
  };

  table("All", trades);
  table("Longs", trades.filter((t) => t.side === "long"));
  table("Shorts", trades.filter((t) => t.side === "short"));
  table("With-trend quadrants only", trades.filter((t) => t.quadrant != null && isWithTrend(t.quadrant)));
  const ts = zones.map((t) => t.t);
  const mid = (Math.min(...ts) + Math.max(...ts)) / 2;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  table(`Before ${day(mid)}`, trades.filter((t) => t.t < mid));
  table(`From ${day(mid)}`, trades.filter((t) => t.t >= mid));

  console.log("\n=== Verdicts — 95% intervals from resampling SYMBOLS ===");
  const verdict = (a: Variant, b: Variant, what: string) => {
    const d = bootstrapDiff(trades, a, b, mulberry32(SEED + 1));
    if (!d) {
      console.log(`  ${what}: not enough symbols to say`);
      return;
    }
    const [lo, hi] = d.winPp;
    const word = lo > 0 ? "ADDS to" : hi < 0 ? "SUBTRACTS from" : "is indistinguishable from";
    console.log(
      `  ${what}: ${a} ${word} ${b} — win rate ${lo.toFixed(1)} to ${hi.toFixed(1)}pp, ` +
        `all-in ${d.rAllIn[0].toFixed(3)} to ${d.rAllIn[1].toFixed(3)}R`,
    );
  };
  verdict("zone", "shifted", "The zone's PRICE");
  verdict("zone", "random_day", "The zone's TIMING");
  verdict("reject", "reject_shifted", "The rejection rule, at a zone vs anywhere");
  console.log(
    `\nBreak-even at ${TARGET_R}R is about ${(100 * (1 + FEES / riskBudget) / (TARGET_R + 1)).toFixed(1)}% ` +
      `once the round trip is paid. A touch is treated as a fill, so every limit variant is ` +
      `optimistic — equally, which is what makes them comparable.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
