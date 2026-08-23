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

/**
 * RL 1W as the indicator reported it on 2026-08-23 with **ADJ off**, price
 * 372.59. Unadjusted is the convention to compare against: this API adjusts
 * for splits only, and a zone is a record of where real orders rested, so
 * back-adjusting those levels for dividends moves them away from the prices
 * that actually mattered.
 *
 * The first four are inside a two-year pull and match exactly. The last four
 * predate it — 63% or more below price, so nothing that would ever be traded.
 */
const EXPECTED_RL_1W = [
  { entry: 355.0, mid: 340.29, sl: 325.59, dist: -4.72, state: "Mitigated" },
  { entry: 324.34, mid: 322.17, sl: 320.0, dist: -12.95, state: "Mitigated" },
  { entry: 196.57, mid: 195.64, sl: 194.72, dist: -47.24, state: "Mitigated" },
  { entry: 194.72, mid: 191.86, sl: 189.0, dist: -47.74, state: "Mitigated" },
  { entry: 134.25, mid: 130.97, sl: 127.68, dist: -63.97, state: "Fresh" },
  { entry: 108.6, mid: 105.88, sl: 103.17, dist: -70.85, state: "Mitigated" },
  { entry: 103.17, mid: 102.0, sl: 100.82, dist: -72.31, state: "Mitigated" },
  { entry: 82.23, mid: 79.86, sl: 77.49, dist: -77.93, state: "Mitigated" },
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
    // Pair each expected row with the nearest produced one rather than
    // demanding an exact hit: a price-convention difference shifts every
    // level slightly, and that must not read as "zone not found".
    const drift: { tv: number; ours: number; ratio: number }[] = [];
    let exactRows = 0;
    for (const e of EXPECTED_RL_1W) {
      let best: (typeof table)[number] | null = null;
      let bestGap = Infinity;
      for (const z of table) {
        const gap = Math.abs(z.entry - e.entry) / e.entry;
        if (gap < bestGap) [best, bestGap] = [z, gap];
      }
      if (!best || bestGap > 0.05) {
        console.log(`  ${n(e.entry)}  not produced — likely outside the 2y window`);
        continue;
      }
      drift.push({ tv: e.entry, ours: best.entry, ratio: e.entry / best.entry });

      // An exact row means every column agrees, not just the entry.
      const exact =
        Math.abs(best.entry - e.entry) < 0.005 &&
        Math.abs(best.mid - e.mid) < 0.005 &&
        Math.abs(best.sl - e.sl) < 0.005 &&
        Math.abs(distancePct(best.entry, price) - e.dist) < 0.005 &&
        (best.mitigated ? "Mitigated" : "Fresh") === e.state;

      console.log(
        exact
          ? `  ${n(e.entry)}  EXACT — 50%, SL, Dist % and state all agree`
          : `  ${n(e.entry)}  ≈ ${n(best.entry)}   ${(bestGap * 100).toFixed(2)}% apart` +
              `   50% ${n(best.mid)}   SL ${n(best.sl)}   ${best.mitigated ? "Mitigated" : "Fresh"}`,
      );
      if (exact) exactRows++;
    }

    console.log(
      `\n  ${exactRows} of ${drift.length} comparable rows match the indicator exactly` +
        ` (${EXPECTED_RL_1W.length - drift.length} outside the 2y window)`,
    );

    /**
     * A constant offset would mean a rounding or edge-selection bug. An
     * offset that GROWS with age is a price-convention difference: the
     * chart's ADJ toggle back-adjusts history for dividends, and this API
     * adjusts for splits only. RL yields roughly 1.2% a year, which is the
     * size of the gap seen here.
     */
    const worst = Math.max(...drift.map((d) => Math.abs(1 - d.ratio)), 0);

    if (exactRows === drift.length && drift.length > 0) {
      console.log(
        "\n  VERIFIED. The engine reproduces the indicator, so levels no longer\n" +
          "  depend on reading a chart. Re-run this whenever the Pine is edited.",
      );
    } else if (drift.length >= 2 && worst > 0.0005) {
      const oldest = drift[drift.length - 1];
      const newest = drift[0];
      const widening = Math.abs(1 - oldest.ratio) > Math.abs(1 - newest.ratio);
      console.log(
        `\n  newest row off by ${((1 - newest.ratio) * 100).toFixed(2)}%, ` +
          `oldest by ${((1 - oldest.ratio) * 100).toFixed(2)}%`,
      );
      console.log(
        widening
          ? "  Offset grows with age — a price convention, not a detection fault.\n" +
              "  The chart's ADJ toggle back-adjusts for dividends; this API does not.\n" +
              "  Turn ADJ off and the tables should agree."
          : "  Offset is flat across ages, so it is not dividend adjustment.\n" +
              "  Suspect edge selection or rounding in the port.",
      );
    }
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
