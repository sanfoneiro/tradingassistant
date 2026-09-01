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
import { inArray, sql } from "drizzle-orm";
import { db } from ".";
import { bars as barsTable } from "./schema";
import {
  computeZonesDetailed,
  toWeekly,
  type Bar,
  type Zone,
} from "../lib/zones";
import {
  replaySignal,
  summariseReplays,
  type ReplayResult,
} from "../lib/replay";
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
/** Sessions price has to come back to the level before the idea is abandoned.
 *  Longer than replay's default of 10, because a wishlist entry legitimately
 *  waits: `triggeredAt` exists precisely so "at its level since Tuesday" is
 *  answerable. `never_triggered` at 60 means price genuinely never returned. */
const TRIGGER_WINDOW = 60;
/** Sessions after filling to reach target or stop. A days-to-weeks hold, and
 *  a B-grade's time stop is 8-10, so twenty is generous rather than tight. */
const RESOLVE_WINDOW = 20;
const TARGET_R = 3;
const FEES = 4;
/** Below this the win rate is a coin flip with a decimal point on it. */
const MIN_DECIDED = 15;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * A rolling range floor, in dollars, at each bar.
 *
 * This has to be LOCAL. A single ADR taken at today's price and applied to a
 * zone that formed two years ago produced a 33.9% stop on MU and 23.4% on
 * INTC — the biggest movers in the list, which is the tell. The floor must be
 * the volatility that existed when the zone did.
 */
function rollingRange(bars: Bar[], lookback = 20): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += (bars[i].h - bars[i].l) / bars[i].c;
    if (i >= lookback) sum -= (bars[i - lookback].h - bars[i - lookback].l) / bars[i - lookback].c;
    const n = Math.min(i + 1, lookback);
    out.push((sum / n) * bars[i].c);
  }
  return out;
}

/** The trade a zone implies: proximal edge in, distal edge out, rule 8 floor. */
function signalFor(z: Zone, adr: number) {
  const long = z.direction === "demand";
  const entry = z.entry;
  const risk = Math.max(Math.abs(entry - z.sl), adr);
  if (!(risk > 0) || !(entry > 0)) return null;
  return {
    signal: {
      symbol: "",
      side: (long ? "long" : "short") as "long" | "short",
      entryLow: entry,
      entryHigh: entry,
      stop: long ? entry - risk : entry + risk,
      target: long ? entry + TARGET_R * risk : entry - TARGET_R * risk,
    },
    riskPct: (risk / entry) * 100,
  };
}

function backtest(bars: Bar[], riskBudget: number) {
  const rangeAt = rollingRange(bars);
  const { live, broken } = computeZonesDetailed(bars, {
    maxZones: Number.MAX_SAFE_INTEGER,
    // The ORIGINAL box. A shrunken proximal edge is hindsight: at the moment
    // the zone formed, nothing had penetrated it yet.
    updateZones: false,
  });
  const zones = [...live, ...broken.map((b) => b.zone)];
  const idxOf = new Map(bars.map((b, i) => [b.t, i]));

  const results: ReplayResult[] = [];
  const riskPcts: number[] = [];

  for (const z of zones) {
    const ci = idxOf.get(z.createdAt);
    if (ci == null) continue;
    // createdAt is the candidate bar; bars[ci + 2] confirms it. Nothing is
    // tradeable until the bar after confirmation.
    const from = ci + 3;
    if (from >= bars.length) continue;

    // The floor as it stood when the zone was confirmed, not as it stands now.
    const s = signalFor(z, rangeAt[ci + 2]);
    if (!s) continue;
    riskPcts.push(s.riskPct);

    results.push(
      replaySignal(s.signal, bars.slice(from), {
        triggerWindow: TRIGGER_WINDOW,
        resolveWindow: RESOLVE_WINDOW,
        fees: FEES,
        riskBudget,
      }),
    );
  }
  return { summary: summariseReplays(results), riskPct: median(riskPcts) };
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

async function loadBars(symbols: string[]) {
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
      t: Date.parse(row.d + "T00:00:00Z"),
      o: row.o,
      h: row.h,
      l: row.l,
      c: row.c,
    });
  }
  return by;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const symbols = args.length ? args.map((s) => s.toUpperCase()) : DEFAULT;

  const acct: any = await db.execute(sql`select sizing_base from accounts limit 1`);
  const base = Number((acct.rows ?? acct)[0]?.sizing_base ?? 7600);
  const policy = sizingPolicy(MAX_SLOTS);
  const riskBudget = base * 0.01;

  const bars = await loadBars([...symbols, BENCH]);
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
