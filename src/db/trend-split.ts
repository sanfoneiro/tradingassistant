/**
 * Does the trend filter actually earn its 50 points?
 *
 * `rank.ts` states the quadrant model as the one thing in it that is not a
 * guess, and weights with-trend at 50 against countertrend at 5 — a gap large
 * enough that the worst with-trend setup outranks the best countertrend one
 * BY CONSTRUCTION. Its own header says the Method report exists to falsify
 * that. This is the falsification attempt, run against the stored bars rather
 * than against the nine closed trades that cannot answer it.
 *
 * Every zone in the store is replayed as the trade it implies, then split by
 * the quadrant it sat in AT THE TIME — classified on bars up to the confirming
 * bar, never on the full series. Two claims are tested:
 *
 *   1. with-trend out-earns countertrend
 *   2. contested is worth vetoing outright
 *
 * The second matters as much as the first and is never asked. `rank.ts`
 * guarantees no contested name can clear the bar, so if contested resolves at
 * the same rate as everything else, that veto is spending opportunity for
 * nothing — and no live data could ever show it, because the veto stops those
 * trades from being taken.
 *
 * A caveat that has to travel with the number: classifying a trend needs 220
 * bars for the 200-EMA, so zones from the first ~220 sessions of the store
 * cannot be classified at all. They are reported as unclassifiable rather
 * than pooled into `contested`, which is a different claim.
 *
 *   npm run trend:split                 the default candidates
 *   npm run trend:split -- AAPL MSFT    an explicit list
 *   npm run trend:split -- --wide       every symbol with enough history
 */
import { sql } from "drizzle-orm";
import { db } from ".";
import { readBars } from "./read-bars";
import { replayZones, compareRates, TARGET_R, FEES, type ZoneTrade } from "../lib/zone-backtest";
import { summariseReplays } from "../lib/replay";
import { isWithTrend, type Quadrant } from "../lib/rank";
import { MIN_BARS_FOR_TREND } from "../lib/bars-store";

const DEFAULT = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "AVGO", "TSLA",
  "AMD", "NFLX", "CRM", "ORCL", "ADBE", "INTC", "QCOM", "MU",
  "TXN", "CSCO", "NOW", "PLTR", "SMCI", "ARM", "PANW",
];
const WIDE_CAP = 300;
const BENCH = "QQQ";

const tally = (ts: ZoneTrade[]) => {
  const s = summariseReplays(ts.map((t) => t.result));
  return {
    zones: ts.length,
    trig: s.triggered,
    W: s.wins,
    L: s.losses,
    "win%": s.winRate == null ? null : +(s.winRate * 100).toFixed(1),
    avgR: s.avgR == null ? null : +s.avgR.toFixed(3),
    totR: s.totalR == null ? null : +s.totalR.toFixed(1),
    amb: s.ambiguous,
    gap: s.gappedThrough,
  };
};

async function main() {
  const argv = process.argv.slice(2);
  const wide = argv.includes("--wide");
  const named = argv.filter((a) => !a.startsWith("-")).map((s) => s.toUpperCase());

  let symbols = named.length ? named : DEFAULT;
  if (wide) {
    const r: any = await db.execute(sql`
      select symbol from bars group by symbol
      having count(*) >= ${MIN_BARS_FOR_TREND}
      order by count(*) desc limit ${WIDE_CAP}
    `);
    symbols = (r.rows ?? r).map((x: any) => x.symbol);
  }

  const acct: any = await db.execute(sql`select sizing_base from accounts limit 1`);
  const base = Number((acct.rows ?? acct)[0]?.sizing_base ?? 7600);
  const riskBudget = base * 0.01;

  const bars = await readBars([...symbols, BENCH]);
  const trades: ZoneTrade[] = [];
  let skipped = 0;
  for (const symbol of symbols) {
    const b = bars.get(symbol);
    if (!b || b.length < MIN_BARS_FOR_TREND) {
      skipped++;
      continue;
    }
    trades.push(...replayZones(symbol, b, { riskBudget, classifyTrends: true }));
  }

  const classified = trades.filter((t) => t.quadrant != null);
  const unclassifiable = trades.length - classified.length;

  console.log(
    `${symbols.length - skipped} symbols, ${trades.length} zones replayed, ` +
      `target ${TARGET_R}R gross, net of $${FEES} at a $${riskBudget.toFixed(0)} ` +
      `risk budget.\n${unclassifiable} zones formed inside the first ` +
      `${MIN_BARS_FOR_TREND} stored sessions and CANNOT be classified — they ` +
      `are excluded, not counted as contested.`,
  );

  const withT = classified.filter((t) => isWithTrend(t.quadrant!));
  const contested = classified.filter((t) => t.quadrant === "contested");
  const counter = classified.filter(
    (t) => !isWithTrend(t.quadrant!) && t.quadrant !== "contested",
  );

  console.log("\n=== The claim rank.ts makes ===");
  console.table([
    { bucket: "with-trend", ...tally(withT) },
    { bucket: "countertrend", ...tally(counter) },
    { bucket: "contested", ...tally(contested) },
    { bucket: "ALL classified", ...tally(classified) },
  ]);

  const vsCounter = compareRates(
    { wins: tally(withT).W, losses: tally(withT).L },
    { wins: tally(counter).W, losses: tally(counter).L },
  );
  const vsContested = compareRates(
    { wins: tally(withT).W, losses: tally(withT).L },
    { wins: tally(contested).W, losses: tally(contested).L },
  );

  const verdict = (
    label: string,
    c: ReturnType<typeof compareRates>,
    claim: string,
  ) => {
    if (!c) {
      console.log(`  ${label}: not enough decided outcomes on one side`);
      return;
    }
    const sig = Math.abs(c.z) >= 2;
    console.log(
      `  ${label}: ${(c.pa * 100).toFixed(1)}% (n=${c.na}) vs ` +
        `${(c.pb * 100).toFixed(1)}% (n=${c.nb}), diff ` +
        `${(c.diff * 100).toFixed(1)}pp, z=${c.z.toFixed(2)} — ` +
        (sig
          ? `${c.z > 0 ? "SUPPORTS" : "CONTRADICTS"} the claim that ${claim}`
          : `NOT distinguishable from chance; the claim that ${claim} is unsupported here, in either direction`),
    );
  };

  console.log("\n=== Verdicts (|z| >= 2 to say anything at all) ===");
  verdict("with-trend vs countertrend", vsCounter, "with-trend wins more often");
  verdict("with-trend vs contested", vsContested, "contested is worth vetoing");

  console.log("\n=== By quadrant, because the two halves of each may differ ===");
  const quads: Quadrant[] = ["up_demand", "down_supply", "up_supply", "down_demand", "contested"];
  console.table(
    quads.map((q) => ({
      quadrant: q,
      kind: q === "contested" ? "-" : isWithTrend(q) ? "with" : "counter",
      ...tally(classified.filter((t) => t.quadrant === q)),
    })),
  );

  /**
   * The split that actually appeared, which is not the one this script set
   * out to test. up_demand and down_demand both resolve at 27.3% while both
   * supply buckets sit far below — so the line is LONG vs SHORT, not
   * with-trend vs countertrend.
   *
   * A direction result cannot be read without the tape it was measured on. If
   * the benchmark rose over the sample, "longs beat shorts" may be nothing
   * more than "the market went up", and printing the z-score without the
   * benchmark return beside it would be a confident, plausible, wrong number
   * of exactly the kind this project exists to avoid.
   */
  const longs = classified.filter((t) => t.side === "long");
  const shorts = classified.filter((t) => t.side === "short");
  console.log("\n=== The split that actually appeared: direction ===");
  console.table([
    { bucket: "demand (long)", ...tally(longs) },
    { bucket: "supply (short)", ...tally(shorts) },
  ]);
  const lt = tally(longs);
  const st = tally(shorts);
  verdict(
    "long vs short",
    compareRates({ wins: lt.W, losses: lt.L }, { wins: st.W, losses: st.L }),
    "demand zones resolve better than supply zones",
  );

  const bench = bars.get(BENCH);
  if (bench && bench.length > 1) {
    const first = bench[0];
    const last = bench.at(-1)!;
    const ret = ((last.c - first.c) / first.c) * 100;
    console.log(
      `  CONFOUND: ${BENCH} returned ${ret.toFixed(1)}% over the sample ` +
        `(${new Date(first.t).toISOString().slice(0, 10)} to ` +
        `${new Date(last.t).toISOString().slice(0, 10)}). A long-side edge ` +
        `measured across a rising tape is not separable from the tape. ` +
        `Whether zones make longs work, or the window did, needs a sample ` +
        `that contains a real downtrend — which two years of THIS store does ` +
        `not have.`,
    );
  }

  const all = tally(classified);
  console.log(
    `\nBreakeven at ${TARGET_R}R is ${(100 / (TARGET_R + 1)).toFixed(0)}% gross. ` +
      `Everything above is the zone plus a trend read and nothing else — no ` +
      `rejection requirement, no fundamental veto, no grade, and a touch of ` +
      `the level treated as a fill. Optimistic, and consistently so.`,
  );
  if (all.totR != null && all.W + all.L > 0)
    console.log(
      `All classified: ${all.W}W / ${all.L}L = ${all["win%"]}%, ` +
        `${all.totR}R across ${all.W + all.L} decided trades.`,
    );
}

main().then(() => process.exit(0));
