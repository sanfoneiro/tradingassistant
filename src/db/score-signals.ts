/**
 * Score every signal against what price actually did — taken or not.
 *
 * The journal measures ideas Oron chose to act on, which is a biased sample
 * of the grader's own output, and says nothing whatsoever about the ideas a
 * veto BLOCKED. A blocked signal that would have won is the only evidence
 * that a rule is too strict, and nothing in this system could see it before.
 *
 * Idempotent: a suggestion already scored is skipped unless --rescore is
 * passed. Rows are written once and not overwritten, because a measurement
 * taken with one window must stay comparable to itself.
 *
 *   npm run signals:score            score anything new
 *   npm run signals:score --rescore  recompute everything
 *   npm run signals:score --dry      print, write nothing
 */
import { eq, isNull, sql } from "drizzle-orm";
import { db } from ".";
import { suggestions, signalOutcomes } from "./schema";
import { fetchDailyBars, Throttle } from "../lib/massive";
import {
  replaySignal,
  summariseReplays,
  DEFAULT_RESOLVE_WINDOW,
  type Bar,
  type ReplayResult,
} from "../lib/replay";

const FEES = 4;
const RISK_BUDGET_PCT = 0.01;
/** B grades carry a time stop of 8-10 sessions, so giving them twenty would
 *  measure a trade Oron's own rules say he would have closed. */
const RESOLVE_WINDOW_BY_GRADE: Record<string, number> = { B: 10 };
const BENCHMARK = "SPY";

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

async function main() {
  const argv = process.argv.slice(2);
  const rescore = argv.includes("--rescore");
  const dry = argv.includes("--dry");

  const rows = await db
    .select({ s: suggestions, o: signalOutcomes })
    .from(suggestions)
    .leftJoin(signalOutcomes, eq(signalOutcomes.suggestionId, suggestions.id));

  const todo = rows.filter((r) => rescore || r.o == null);
  console.log(
    `${rows.length} suggestions, ${rows.length - todo.length} already scored, ${todo.length} to do`,
  );
  if (!todo.length) return;

  const throttle = new Throttle();
  const barsBySymbol = new Map<string, Bar[]>();
  const need = [...new Set([...todo.map((r) => r.s.symbol), BENCHMARK])];
  for (const symbol of need) {
    try {
      await throttle.take();
      barsBySymbol.set(symbol, await fetchDailyBars(symbol, { years: 2 }));
    } catch (e) {
      console.error(`  ${symbol}: ${e instanceof Error ? e.message.slice(0, 70) : e}`);
    }
  }

  const results: ReplayResult[] = [];
  let written = 0;

  for (const { s } of todo) {
    const bars = barsBySymbol.get(s.symbol);
    if (!bars?.length) {
      console.log(`${s.symbol.padEnd(6)} no bars — skipped`);
      continue;
    }

    // A suggestion missing a level cannot be replayed. Skipped loudly rather
    // than defaulted — a zero here would score as a catastrophic loss.
    if (s.entry == null || s.stop == null || s.target == null) {
      console.log(
        `${s.symbol.padEnd(6)} missing entry/stop/target — cannot replay, skipped`,
      );
      continue;
    }
    const entry = s.entry;
    const stop = s.stop;
    const target = s.target;

    const createdDay = day(s.createdAt!.getTime());

    /**
     * A suggestion is written mid-session, so its own day's bar spans time
     * both before and after it existed. If that bar already traded through
     * the entry, whether it "filled" is an intraday fact a daily bar cannot
     * answer — the same ambiguity that made the brief backtest unusable, 17
     * cases out of 25. Flag it and start from the next session.
     */
    const ownBar = bars.find((b) => day(b.t) === createdDay);
    const sameDayTouch = ownBar
      ? ownBar.l <= entry && ownBar.h >= entry
      : false;

    const forward = bars.filter((b) => day(b.t) > createdDay);

    // The signal is live until it expires — that is the funnel's own answer
    // to how long an idea stands. Counting a fill after expiry would flatter
    // the grader with a trade Oron would never have had on.
    const expiry = s.expiresAt ?? null;
    const triggerWindow = expiry
      ? Math.max(
          1,
          forward.filter((b) => b.t <= expiry.getTime()).length,
        )
      : 5;
    const resolveWindow =
      RESOLVE_WINDOW_BY_GRADE[s.grade ?? ""] ?? DEFAULT_RESOLVE_WINDOW;

    const riskBudget =
      (s.sizeUsd && s.shares ? entry * s.shares : 7626.5) * RISK_BUDGET_PCT;

    const r = replaySignal(
      {
        symbol: s.symbol,
        side: s.side,
        entryLow: entry,
        entryHigh: entry,
        stop,
        target,
      },
      forward,
      { triggerWindow, resolveWindow, fees: FEES, riskBudget: 76.27 },
    );
    results.push(r);

    // Benchmark over the same holding period. Without it a book that is
    // mostly long in a rising tape reads as skill.
    let benchmarkPct: number | null = null;
    const spy = barsBySymbol.get(BENCHMARK);
    if (spy && r.triggerIdx != null && r.exitIdx != null) {
      const sf = spy.filter((b) => day(b.t) > createdDay);
      const a = sf[r.triggerIdx];
      const b = sf[r.exitIdx];
      if (a && b) benchmarkPct = ((b.c - a.o) / a.o) * 100;
    }

    /**
     * Only a FINAL answer gets written.
     *
     * A signal whose expiry is still in the future has not had its chance
     * yet: "never_triggered" today is just "not yet". Recording it would
     * freeze a verdict on a live idea and quietly stack the sample with
     * failures that never happened — the measurement would be wrong in the
     * one direction that makes the grader look worst.
     */
    const settled =
      r.resolution === "hit_target" ||
      r.resolution === "hit_stop" ||
      r.resolution === "ambiguous" ||
      r.resolution === "gapped_through" ||
      r.resolution === "bad_input";
    const windowClosed = expiry ? expiry.getTime() < Date.now() : false;
    const isFinal = settled || windowClosed;

    const flag = sameDayTouch ? " [same-day touch]" : "";
    console.log(
      `${s.symbol.padEnd(6)} ${String(s.grade ?? "-").padEnd(7)} ${r.resolution.padEnd(16)} ` +
        `R ${r.rNet == null ? "  —  " : (r.rNet >= 0 ? "+" : "") + r.rNet.toFixed(2)}` +
        `${benchmarkPct == null ? "" : `  spy ${benchmarkPct >= 0 ? "+" : ""}${benchmarkPct.toFixed(2)}%`}` +
        flag +
        (isFinal ? "" : "  STILL LIVE — not recorded"),
    );

    if (!isFinal) {
      results.pop(); // keep the run summary to settled signals only
      continue;
    }
    if (dry) continue;

    const values = {
      suggestionId: s.id,
      resolution: r.resolution,
      entryPrice: r.entryPrice,
      exitPrice: r.exitPrice,
      triggeredAt:
        r.triggerIdx != null && forward[r.triggerIdx]
          ? new Date(forward[r.triggerIdx].t)
          : null,
      resolvedAt:
        r.exitIdx != null && forward[r.exitIdx] ? new Date(forward[r.exitIdx].t) : null,
      barsToTrigger: r.barsToTrigger,
      barsHeld: r.barsHeld,
      rGross: r.rGross,
      rNet: r.rNet,
      benchmarkPct,
      sameDayTouch,
      triggerWindow,
      resolveWindow,
      note: r.note,
      computedAt: new Date(),
    };

    await db
      .insert(signalOutcomes)
      .values(values)
      .onConflictDoUpdate({ target: signalOutcomes.suggestionId, set: values });
    written++;
  }

  const s = summariseReplays(results);
  console.log("\n=== this run ===");
  console.log(JSON.stringify(s, null, 1));
  console.log(dry ? "\ndry run — nothing written" : `\nwrote ${written} outcome rows`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
