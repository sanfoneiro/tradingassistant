import { fetchDailyBars } from "../lib/massive";
import { computeZones, toWeekly, zoneTable, distancePct } from "../lib/zones";

/**
 * Does the ported engine reproduce the indicator?
 *
 * This is the question that decides whether TradingView stays a dependency
 * for levels. The on-chart table is ground truth; if this output matches it
 * on a handful of symbols across both timeframes, screenshots stop being
 * load-bearing and the whole universe can be swept in one cron job.
 *
 *   npm run db:verify-zones RL 1W
 *   npm run db:verify-zones GOOGL 1D
 *
 * Compare the printed table against the indicator's own, side by side. Rows
 * are ordered the same way (nearest to price first, eight of them), so the
 * two should line up column for column.
 */

const EXPECTED_RL_1W = [
  { entry: 354.13, mid: 339.47, sl: 324.8, dist: -4.95, state: "Mitigated" },
  { entry: 323.34, mid: 320.84, sl: 318.35, dist: -13.22, state: "Mitigated" },
  { entry: 193.82, mid: 192.22, sl: 190.62, dist: -47.98, state: "Mitigated" },
  { entry: 190.62, mid: 187.82, sl: 185.02, dist: -48.84, state: "Mitigated" },
  { entry: 129.06, mid: 125.9, sl: 122.74, dist: -65.36, state: "Fresh" },
  { entry: 104.4, mid: 101.16, sl: 97.93, dist: -71.98, state: "Mitigated" },
  { entry: 97.93, mid: 96.16, sl: 94.39, dist: -73.72, state: "Mitigated" },
  { entry: 76.53, mid: 73.1, sl: 69.66, dist: -79.46, state: "Fresh" },
];

const n = (x: number, w = 9, d = 2) => x.toFixed(d).padStart(w);

async function main() {
  const symbol = (process.argv[2] ?? "RL").toUpperCase();
  const tf = (process.argv[3] ?? "1W").toUpperCase();

  console.log(`fetching ${symbol} daily bars…`);
  const daily = await fetchDailyBars(symbol, { years: 2 });
  if (!daily.length) {
    console.error(`no bars returned for ${symbol}`);
    process.exit(1);
  }

  const bars = tf === "1W" ? toWeekly(daily) : daily;
  const price = daily.at(-1)!.c;
  const lastBar = new Date(daily.at(-1)!.t).toISOString().slice(0, 10);

  console.log(
    `${daily.length} daily bars → ${bars.length} ${tf} bars, last ${lastBar}, close ${price}\n`,
  );

  const zones = computeZones(bars);
  const table = zoneTable(zones, price, 8);

  console.log(`TF  Zone     ${"Entry".padStart(9)} ${"50%".padStart(9)} ${"SL".padStart(9)} ${"Dist %".padStart(9)}  State`);
  for (const z of table) {
    console.log(
      `${tf}  ${z.direction === "demand" ? "Demand" : "Supply"}  ` +
        `${n(z.entry)} ${n(z.mid)} ${n(z.sl)} ${n(distancePct(z.entry, price))}  ` +
        `${z.mitigated ? "Mitigated" : "Fresh"}`,
    );
  }

  // Invariants hold regardless of whether the levels themselves match — they
  // are properties of any well-formed row, and worth checking separately so
  // a formatting bug is not mistaken for a detection bug.
  console.log("\ninvariants:");
  let bad = 0;
  for (const z of table) {
    const midOk = Math.abs((z.entry + z.sl) / 2 - z.mid) < 0.005;
    if (!midOk) {
      console.log(`  MID MISMATCH entry=${z.entry} sl=${z.sl} mid=${z.mid}`);
      bad++;
    }
  }
  console.log(bad ? `  ${bad} bad row(s)` : "  all rows internally consistent");

  if (symbol === "RL" && tf === "1W") {
    console.log(
      "\nagainst the indicator's table of 2026-08-23 (price 372.59) —\n" +
        "note the chart shows more history than a 2-year pull, so the deepest\n" +
        "rows may legitimately be absent rather than wrong:",
    );
    for (const e of EXPECTED_RL_1W) {
      const hit = table.find((z) => Math.abs(z.entry - e.entry) < 0.02);
      if (!hit) {
        console.log(`  ${n(e.entry)}  not produced`);
        continue;
      }
      const dMid = Math.abs(hit.mid - e.mid);
      const dSl = Math.abs(hit.sl - e.sl);
      const state = (hit.mitigated ? "Mitigated" : "Fresh") === e.state;
      console.log(
        `  ${n(e.entry)}  matched   50% Δ${dMid.toFixed(2)}  SL Δ${dSl.toFixed(2)}  state ${state ? "ok" : "DIFFERS"}`,
      );
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
