/**
 * Which names does this METHOD actually work on?
 *
 * Picking a focus list by sector is picking by taste. Everything below is
 * computed from the bars already in the store.
 *
 * The central number is NOT a "respect rate". The first version of this file
 * measured whether a zone ever closed through across the whole history, and
 * that measures the wrong thing twice over: it is dominated by how long a zone
 * has existed, and it cannot tell a level that failed on first touch from one
 * that worked three times and broke on the fourth. Both matter enormously and
 * it scored them the same.
 *
 * So every zone is replayed as a SIGNAL instead, through the same replay.ts
 * the signal scorer uses — entry at the proximal edge, stop beyond the distal
 * edge and never tighter than one ADR (rule 8), target 3R gross because a
 * gross-exactly-2R target can never be net 2:1. What comes back is a win rate
 * and an average R per name: the method's own results on that name, measured
 * the same way a live suggestion is measured.
 *
 * Three things it refuses to hide:
 *
 *   - **Look-ahead.** A zone's createdAt is the CANDIDATE bar, two bars before
 *     the imbalance is confirmed. Replaying from there would let a zone fill
 *     on the very bars that formed it. Replay starts at confirmation + 1.
 *   - **Ambiguity.** When one daily bar covers both stop and target, replay.ts
 *     reports `ambiguous` rather than guessing. A name with many of those has
 *     a weak measurement and the count is printed, not folded away.
 *   - **The weekly timeframe is underpowered.** Two years is ~104 weekly bars,
 *     which yields single-digit zone counts. Oron's method is a weekly method,
 *     so this is a real limit of the measurement and not of the method: it
 *     needs deeper history before the weekly column means anything.
 *
 * There is no composite score. Weights would be invented, and every weight in
 * rank.ts had to be defensible as a hypothesis first. This prints evidence and
 * flags hard disqualifiers; choosing among what survives stays a judgement.
 *
 *   npm run shortlist                 the default mega-cap tech candidates
 *   npm run shortlist -- AAPL MSFT    an explicit list
 */
import { sql } from "drizzle-orm";
import { db } from ".";
import { readBars } from "./read-bars";
import { toWeekly, type Bar } from "../lib/zones";
import { summariseReplays } from "../lib/replay";
import {
  replayZones,
  TARGET_R,
  FEES,
  TRIGGER_WINDOW,
  RESOLVE_WINDOW,
} from "../lib/zone-backtest";
import { positionSize, sizingPolicy } from "../lib/metrics";

const DEFAULT = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "AVGO", "TSLA",
  "AMD", "NFLX", "CRM", "ORCL", "ADBE", "INTC", "QCOM", "MU",
  "TXN", "CSCO", "NOW", "PLTR", "SMCI", "ARM", "PANW",
];
const BENCH = "QQQ";
const ADR_LOOKBACK = 60;
const CORR_LOOKBACK = 250;
const GAP_THRESHOLD = 2;
const MAX_SLOTS = 2;
/** Below this the win rate is a coin flip with a decimal point on it. */
const MIN_DECIDED = 15;

/** The per-name view of the shared replay: the summary plus the median stop. */
function backtest(bars: Bar[], riskBudget: number) {
  const trades = replayZones("", bars, { riskBudget });
  const risks = trades.map((t) => t.riskPct).sort((a, b) => a - b);
  const m = Math.floor(risks.length / 2);
  return {
    summary: summariseReplays(trades.map((t) => t.result)),
    riskPct: risks.length
      ? risks.length % 2 ? risks[m] : (risks[m - 1] + risks[m]) / 2
      : null,
  };
}

function corr(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  if (n < 30) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

/**
 * Correlation on returns aligned by DATE, never by array position.
 *
 * CRM has 500 stored bars where QQQ has 501, so positional alignment shifted
 * its whole series by one session and returned -0.03. Daily returns are close
 * enough to white noise that a one-session shift erases a correlation rather
 * than visibly degrading it, and a wrong -0.03 looks exactly like a real one.
 * Aligned by date it is 0.07 over the same window.
 *
 * The low numbers that survive the fix are REAL, which is why both windows are
 * reported: NFLX is 0.06 over the last 250 sessions and 0.34 over the full two
 * years. SPY/QQQ over the full sample is 0.948, computed independently, and is
 * what anchors this as arithmetic rather than a hopeful number.
 */
function alignedReturns(a: Bar[], b: Bar[], lookback: number) {
  const closesB = new Map(b.map((x) => [x.t, x.c]));
  const common = a.filter((x) => closesB.has(x.t));
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 1; i < common.length; i++) {
    x.push(Math.log(common[i].c / common[i - 1].c));
    y.push(Math.log(closesB.get(common[i].t)! / closesB.get(common[i - 1].t)!));
  }
  return { x: x.slice(-lookback), y: y.slice(-lookback), overlap: common.length };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const symbols = args.length ? args.map((s) => s.toUpperCase()) : DEFAULT;

  const acct: any = await db.execute(sql`select sizing_base from accounts limit 1`);
  const base = Number((acct.rows ?? acct)[0]?.sizing_base ?? 7600);
  const policy = sizingPolicy(MAX_SLOTS);
  const riskBudget = base * 0.01;

  const bars = await readBars([...symbols, BENCH]);
  const bench = bars.get(BENCH);
  if (!bench) throw new Error(`no stored bars for ${BENCH} — run bars:backfill`);
  const asOf = new Date(bench.at(-1)!.t).toISOString().slice(0, 10);

  console.log(
    `base $${base.toFixed(2)} | ${MAX_SLOTS} slots -> cap ` +
      `${(policy.concentrationPct * 100).toFixed(0)}%, risk 1% ($${riskBudget.toFixed(2)}) | ` +
      `${symbols.length} candidates | newest stored bar ${asOf}`,
  );

  const rows: Record<string, unknown>[] = [];
  const notes: string[] = [];
  let weeklyDecided = 0;

  for (const symbol of symbols) {
    const b = bars.get(symbol);
    if (!b || b.length < 250) {
      notes.push(`${symbol}: only ${b?.length ?? 0} stored bars — skipped, not judged`);
      continue;
    }
    const price = b.at(-1)!.c;

    const window = b.slice(-ADR_LOOKBACK);
    const adrPct =
      (window.reduce((s, x) => s + (x.h - x.l) / x.c, 0) / window.length) * 100;

    const gaps = b.slice(1).map((x, i) => (Math.abs(x.o - b[i].c) / b[i].c) * 100);
    const gapFreq = (gaps.filter((g) => g >= GAP_THRESHOLD).length / gaps.length) * 100;

    const d = backtest(b, riskBudget);
    // The weekly floor is a weekly range, which is wider than rule 8's daily
    // one. Conservative, and the weekly sample is too thin to lean on anyway.
    const w = backtest(toWeekly(b), riskBudget);
    weeklyDecided += w.summary.wins + w.summary.losses;

    const stopPct = d.riskPct ?? adrPct;
    const stop = price * (1 - stopPct / 100);
    const size = positionSize({
      entry: price,
      stop,
      target: price + TARGET_R * (price - stop),
      base,
      riskPct: 0.01,
      concentrationPct: policy.concentrationPct,
    });

    const s = d.summary;
    const ar = alignedReturns(b, bench, CORR_LOOKBACK);
    const c = corr(ar.x, ar.y);
    // Both windows, because they disagree by a lot on some names: NFLX is
    // 0.34 over two years and 0.06 over the last 250 sessions. Quoting one
    // number would hide that the relationship changed.
    const arAll = alignedReturns(b, bench, Number.MAX_SAFE_INTEGER);
    const cAll = corr(arAll.x, arAll.y);
    if (ar.overlap < b.length)
      notes.push(
        `${symbol}: ${b.length - ar.overlap} stored session(s) have no ${BENCH} ` +
          `bar — correlation uses the ${ar.overlap} that align`,
      );

    rows.push({
      symbol,
      price: +price.toFixed(2),
      "ADR%": +adrPct.toFixed(2),
      "stop%": +stopPct.toFixed(2),
      zones: s.n,
      trig: s.triggered,
      W: s.wins,
      L: s.losses,
      "win%": s.winRate == null ? null : +(s.winRate * 100).toFixed(0),
      avgR: s.avgR == null ? null : +s.avgR.toFixed(2),
      totR: s.totalR == null ? null : +s.totalR.toFixed(1),
      amb: s.ambiguous,
      gap: s.gappedThrough,
      "gapFreq%": +gapFreq.toFixed(1),
      corr250: c == null ? null : +c.toFixed(2),
      corrAll: cAll == null ? null : +cAll.toFixed(2),
      sh: size.shares,
      "fee%": size.riskUsd ? +((FEES / size.riskUsd) * 100).toFixed(1) : null,
    });
  }

  /**
   * Is any of this spread real?
   *
   * With a 3R target the breakeven win rate is 25%, so per trade the outcome
   * is +3 or -1 and its standard deviation is about 1.7R. Over forty trades
   * that is an 11R standard deviation from CHANCE ALONE — and across
   * twenty-three names the best and worst draws are expected to be far apart
   * for no reason whatsoever. Reading the ranking without this is precisely
   * the n=2 conclusion that has already had to be retracted here once.
   *
   * z is the name's win COUNT against the pooled rate, in standard
   * deviations. Beyond +/-2 is worth a second look. Everything inside is the
   * same name repeated twenty-three times.
   */
  const totalW = rows.reduce((s, r) => s + (r.W as number), 0);
  const totalL = rows.reduce((s, r) => s + (r.L as number), 0);
  const pooled = totalW + totalL ? totalW / (totalW + totalL) : 0;
  for (const r of rows) {
    const n = (r.W as number) + (r.L as number);
    const sd = Math.sqrt(n * pooled * (1 - pooled));
    r.z = sd ? +(((r.W as number) - n * pooled) / sd).toFixed(1) : null;
  }

  rows.sort((a, b) => ((b.totR as number) ?? -99) - ((a.totR as number) ?? -99));
  console.table(rows);

  console.log(
    `zones = replayed signals; trig = price came back within ${TRIGGER_WINDOW} ` +
      `sessions. W/L/win%/avgR/totR are NET of the $${FEES} round trip at a ` +
      `$${riskBudget.toFixed(0)} risk budget, target ${TARGET_R}R gross, ` +
      `resolved within ${RESOLVE_WINDOW} sessions.\n` +
      `amb = one bar covered both stop and target, so the outcome is ` +
      `genuinely unknowable and is NOT counted as either. gap = price ran ` +
      `through the entry and the stop in one move.\n` +
      `Stop is the distal edge or one ADR, whichever is wider (rule 8). ` +
      `Entry is a touch of the proximal edge, treated as a fill — so these ` +
      `results are optimistic, consistently so, and ignore slippage.\n` +
      `z = win count vs the pooled rate, in SDs. Inside +/-2 the name is ` +
      `indistinguishable from every other name here.`,
  );

  const netR = rows.reduce((s, r) => s + ((r.totR as number) ?? 0), 0);
  console.log(
    `\nPOOLED, all ${rows.length} names: ${totalW}W / ${totalL}L = ` +
      `${(pooled * 100).toFixed(1)}% at a 3R target, ${netR.toFixed(1)}R net ` +
      `across ${totalW + totalL} decided trades. Breakeven at 3R is 25% gross. ` +
      `This is the ZONE ALONE — no trend filter, no rejection requirement, no ` +
      `fundamental veto, no grade. It is the floor the method has to beat, not ` +
      `the method.`,
  );

  console.log("\nHard flags — disqualifiers, not opinions:");
  let flagged = 0;
  for (const r of rows) {
    const f: string[] = [];
    const decided = (r.W as number) + (r.L as number);
    if (decided < MIN_DECIDED)
      f.push(`only ${decided} decided outcomes — the win rate is noise`);
    if ((r.amb as number) > decided && decided > 0)
      f.push(`${r.amb} ambiguous vs ${decided} decided — the measurement is weak`);
    if ((r.sh as number) < 5)
      f.push(`${r.sh} shares on this base — no room to scale out`);
    if ((r["fee%"] as number) > 6)
      f.push(`the $${FEES} round trip is ${r["fee%"]}% of the dollar risk`);
    if (r.z != null && Math.abs(r.z as number) < 2)
      f.push(
        `z=${r.z}: its ${r["win%"]}% is indistinguishable from the pooled ` +
          `${(pooled * 100).toFixed(0)}% — the ${r.totR}R is noise, either sign`,
      );
    if (f.length) {
      flagged++;
      console.log(`  ${String(r.symbol).padEnd(6)} ${f.join("; ")}`);
    }
  }
  if (!flagged) console.log("  none");
  for (const n of notes) console.log(`  ${n}`);

  console.log(
    `\nWeekly timeframe: ${weeklyDecided} decided outcomes across all ` +
      `${rows.length} names combined. Oron's method is a WEEKLY method, and ` +
      `two years of stored bars cannot measure it — this whole table is the ` +
      `daily proxy. Deeper history is what would fix that, not a different ` +
      `statistic.`,
  );
}

main().then(() => process.exit(0));
