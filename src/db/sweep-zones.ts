import { fetchDailyBars, Throttle, RATE_LIMIT_PER_MIN } from "../lib/massive";
import {
  computeZonesDetailed,
  nearestZones,
  toWeekly,
  classifyTrend,
  distancePct,
  type Zone,
  type Bar,
  type BrokenZone,
} from "../lib/zones";
import {
  deriveQuadrant,
  readBreak,
  scoreCandidate,
  overlaps,
  WORTH_OPENING_A_CHART,
  type BreakSignal,
  type Quadrant,
} from "../lib/rank";
import { etParts, barState, OPEN } from "../lib/session";
import { APP_URL, resolveToken, makeClient } from "../lib/ingest-client";

/**
 * The universe sweep. Reads the rotation queue, computes zones for a batch
 * of symbols from API bars, and posts them.
 *
 * This is the job that replaces the screener agent — which failed 10 of its
 * 12 runs, and on the runs that worked produced levels transcribed out of a
 * screenshot. Nothing here reads a chart.
 *
 * It runs OUTSIDE Vercel deliberately. The free data tier allows five
 * requests a minute, so 114 symbols takes about 23 minutes; no serverless
 * function lives that long, and Hobby crons only fire once a day. A GitHub
 * Action has hours and costs nothing. See .github/workflows/zones.yml.
 *
 *   npm run zones:sweep            # whole queue
 *   npm run zones:sweep -- 20      # first 20, oldest-analysed first
 *
 * Deliberately does NOT post suggestions. A suggestion carries entry, stop,
 * target and R:R, and those numbers are hypothetical until price is at the
 * zone. Names close enough to matter are reported for the grader to judge;
 * everything else is recorded as coverage and left alone.
 */

const { token: TOKEN, source: TOKEN_SOURCE } = resolveToken();
const { api, post } = makeClient(TOKEN);

/** Inside this band a name is worth the grader's attention. */
const NEAR_ZONE_PCT = 6;

/** The settled part of the first hour: past the opening auction and the
 *  fifteen minutes of noise after it, still early enough to act on.
 *  Clock questions live in ../lib/session, where they are testable. */
const AFTER_OPEN_FROM = OPEN + 15;
const AFTER_OPEN_TO = OPEN + 90;

type State = {
  screenerCoverage: {
    symbol: string;
    analyzedAt: string | null;
    lastScreenedAt: string;
  }[];
  zones: { symbol: string; timeframe: string; direction: string }[];
};

/**
 * One symbol/timeframe, whole. Levels go over verbatim and the server derives
 * distance from the price we computed against, so nothing is calculated twice
 * in two places and allowed to disagree.
 *
 * Only breaks from the last few bars are sent. The engine is stateless and
 * replays the entire history every run, so without a window every sweep would
 * re-report every break the series ever contained — and each one would expire
 * suggestions all over again.
 */
const RECENT_BREAK_BARS = 5;

function zoneSetPayload(
  symbol: string,
  timeframe: "1D" | "1W",
  live: Zone[],
  broken: BrokenZone[],
  price: number,
  bars: Bar[],
) {
  const cutoff = bars.at(-RECENT_BREAK_BARS)?.t ?? 0;
  return {
    kind: "zone_set" as const,
    symbol,
    timeframe,
    price: round(price),
    live: live.map((z) => ({
      direction: z.direction,
      entryLevel: round(z.entry),
      midLevel: round(z.mid),
      stopLevel: round(z.sl),
      indicatorState: z.mitigated ? "Mitigated" : "Fresh",
    })),
    broken: broken
      .filter((b) => b.brokenAt >= cutoff)
      .map((b) => ({
        direction: b.zone.direction,
        entryLevel: round(b.zone.entry),
        stopLevel: round(b.zone.sl),
        brokenAt: new Date(b.brokenAt).toISOString(),
        closedAt: round(b.closedAt),
      })),
  };
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** Cap the live set to the nearest two each side, keeping the breaks whole —
 *  a break matters wherever it happened. */
function split(
  detailed: { live: Zone[]; broken: BrokenZone[] },
  price: number,
): { zones: Zone[]; broken: BrokenZone[] } {
  return { zones: nearestZones(detailed.live, price), broken: detailed.broken };
}

async function main() {
  if (!TOKEN) {
    console.error(
      "No ingest token found. Put it in .agent-token, or set INGEST_TOKEN.",
    );
    process.exit(1);
  }
  console.log(`auth: ${TOKEN_SOURCE} (${TOKEN.length} chars)`);

  // Fail on the configuration rather than on the first fetch, where a bad
  // base URL reads as a network fault.
  try {
    new URL(APP_URL);
  } catch {
    console.error(`APP_URL is not a valid absolute URL: "${APP_URL}"`);
    process.exit(1);
  }

  // Checked here rather than discovered inside the loop, where a missing key
  // produces one identical failure per symbol and buries the cause 114 lines
  // deep.
  if (!process.env.MASSIVE_API_KEY?.trim()) {
    console.error("MASSIVE_API_KEY is not set — nothing could be fetched.");
    process.exit(1);
  }

  // A numeric argument caps the batch; anything else is a list of symbols to
  // sweep directly. Naming symbols is how you re-check one name without
  // waiting for the rotation to reach it.
  const argv = process.argv.slice(2).filter(Boolean);
  const afterOpen = argv.includes("--after-open");
  const args = argv.filter((a) => !a.startsWith("--"));
  const explicit = args.filter((a) => !/^\d+$/.test(a)).map((a) => a.toUpperCase());
  const limit = Number(args.find((a) => /^\d+$/.test(a))) || Infinity;

  /**
   * Two UTC crons cover the intraday slot so that one of them lands in the
   * window whichever side of a DST change we are on. This is what stops the
   * other one from running: whichever fires at the wrong local time exits
   * quietly, and exactly one sweep happens.
   */
  if (afterOpen) {
    const et = etParts(new Date());
    const inWindow =
      et.weekday >= 1 &&
      et.weekday <= 5 &&
      et.minutes >= AFTER_OPEN_FROM &&
      et.minutes <= AFTER_OPEN_TO;
    if (!inWindow) {
      console.log(
        `${et.label} — outside the ${Math.floor(AFTER_OPEN_FROM / 60)}:` +
          `${String(AFTER_OPEN_FROM % 60).padStart(2, "0")}–` +
          `${Math.floor(AFTER_OPEN_TO / 60)}:${String(AFTER_OPEN_TO % 60).padStart(2, "0")} ET ` +
          `window. This is the duplicate cron for the other DST offset; skipping.`,
      );
      return;
    }
    console.log(`${et.label} — inside the post-open window.`);
  }

  console.log(`reading the queue from ${APP_URL}…`);
  const state: State = await api("/api/state");

  // /api/state already returns coverage oldest-analysed first, nulls ahead
  // of everything, so the queue order is the app's and not reinvented here.
  const queue = explicit.length
    ? explicit
    : state.screenerCoverage.map((c) => c.symbol).slice(0, limit);
  const never = state.screenerCoverage.filter((c) => !c.analyzedAt).length;

  console.log(
    explicit.length
      ? `Sweeping ${queue.length} named symbol(s): ${queue.join(", ")}`
      : `${state.screenerCoverage.length} in the universe, ${never} never analysed. ` +
          `Sweeping ${queue.length}.`,
  );
  console.log(
    `≈${Math.ceil(queue.length / RATE_LIMIT_PER_MIN)} min at ${RATE_LIMIT_PER_MIN} req/min.\n`,
  );

  const throttle = new Throttle();
  const pass: {
    symbol: string;
    distancePct: number | null;
    nearZone: boolean;
    trend: "uptrend" | "downtrend" | "contested" | null;
    adr: number | null;
    note: string;
  }[] = [];

  const watch: {
    symbol: string;
    side: "long" | "short";
    zoneId: number;
    triggerLevel: number;
    distancePct: number;
    triggerNote: string;
    quadrant: Quadrant;
    score: number;
    scoreReasons: string[];
    priority: number;
    active: boolean;
  }[] = [];

  let zonesWritten = 0;
  let brokenReported = 0;
  let ideasExpired = 0;
  const failed: { symbol: string; error: string }[] = [];
  /** Symbols an intraday pass could not price because today's bar was not
   *  available. Counted, named, and reported — never silently substituted. */
  const stale: string[] = [];

  for (let i = 0; i < queue.length; i++) {
    const symbol = queue[i];
    const tag = `[${String(i + 1).padStart(3)}/${queue.length}] ${symbol.padEnd(6)}`;

    try {
      await throttle.take();
      const daily = await fetchDailyBars(symbol, { years: 2 });

      if (daily.length < 60) {
        // Too little history to mean anything. Recorded as looked-at so the
        // rotation moves on, rather than retried forever.
        pass.push({
          symbol,
          distancePct: null,
          nearZone: false,
          trend: null,
          adr: null,
          note: `only ${daily.length} bars — insufficient history`,
        });
        console.log(`${tag} ${daily.length} bars, skipped`);
        continue;
      }

      /**
       * Mid-session, the last daily bar is still forming. Levels must come
       * from completed candles only — an intraday dip through a zone's
       * distal edge would otherwise delete a zone that closes back inside it,
       * and the deletion is not reversible on the next run because the zone
       * simply stops being produced.
       *
       * So the intraday sweep recomputes DISTANCES against a live price, not
       * the levels themselves. That is the honest division: the zone is a
       * fact about closed candles, where price sits relative to it is a fact
       * about now.
       *
       * All of which assumed today's bar exists. On the free data plan it
       * does not — a range request through today returns 200 with the series
       * truncated at the prior close, so `--after-open` was reading yesterday
       * as "now" AND dropping a completed bar it mistook for a forming one,
       * putting trend classification two sessions behind. Ask the bar what
       * session it covers instead of assuming.
       */
      const lastBar = daily.at(-1)!;
      const { session, lastIsToday, forming } = barState(lastBar.t, new Date());

      if (afterOpen && !lastIsToday) {
        // The intraday pass exists to price zones against a live mark. Without
        // today's bar there is no live mark, and rewriting yesterday's numbers
        // would just restate what the evening sweep already stored.
        stale.push(symbol);
        console.log(`${tag} last bar ${session}, not today — no live mark, skipped`);
        continue;
      }

      const price = lastBar.c;
      const settled = forming ? daily.slice(0, -1) : daily;
      const { trend, ma } = classifyTrend(settled);

      /**
       * Only the nearest two each side are stored. The engine finds every
       * level in the history — RL had eight daily demand zones running from
       * 11% to 53% below price — but a level a third of the way down the
       * chart is archaeology, not a decision. Two a side answers the only two
       * questions a level has to: where do I act, and where next if this
       * fails.
       */
      const perTf: { tf: "1D" | "1W"; zones: Zone[]; broken: BrokenZone[]; bars: Bar[] }[] =
        [
          { tf: "1D", ...split(computeZonesDetailed(settled), price), bars: settled },
          {
            tf: "1W",
            ...split(computeZonesDetailed(toWeekly(settled)), price),
            bars: toWeekly(settled),
          },
        ];

      let nearest: number | null = null;
      let closest: { zoneId: number; zone: Zone; tf: "1D" | "1W" } | null = null;

      for (const { tf, zones, broken, bars } of perTf) {
        // One call per timeframe rather than one per zone. It also lets the
        // server retire what the engine no longer produces, which posting
        // zones individually can never do.
        const res = await post(
          zoneSetPayload(symbol, tf, zones, broken, price, bars),
        );
        zonesWritten += zones.length;
        brokenReported += res?.broken ?? 0;
        ideasExpired += res?.suggestionsExpired ?? 0;

        const ids: { stopLevel: number; direction: string; id: number }[] =
          res?.ids ?? [];

        for (const z of zones) {
          const d = distancePct(z.entry, price);
          if (nearest !== null && Math.abs(d) >= Math.abs(nearest)) continue;
          const match = ids.find(
            (i) =>
              i.direction === z.direction &&
              Math.abs(i.stopLevel - round(z.sl)) < 0.0001,
          );
          nearest = d;
          if (match) closest = { zoneId: match.id, zone: z, tf };
        }
      }

      const near = nearest !== null && Math.abs(nearest) <= NEAR_ZONE_PCT;

      /**
       * The wishlist is the stage between "there is a level here" and "this
       * is a trade". It carries a trigger and no R:R, because the R:R is not
       * knowable until price arrives — which is exactly why the ingest route
       * refuses a suggestion this far out.
       *
       * Every swept symbol produces a row, active or not: a name that has
       * drifted away needs retiring as much as a new one needs adding, and
       * only a sweep that saw the symbol can say which.
       */
      if (closest) {
        /**
         * Rank the candidate on structure. With ~11 zones a name, being near
         * SOME level is close to inevitable — what separates a setup from an
         * accident is whether the zone runs with the trend, whether both
         * timeframes agree at the price, and whether it is fresh.
         *
         * Confluence is checked against the OTHER timeframe: a daily zone
         * sitting on a weekly one at the same price is the stack the Method
         * report is meant to test.
         */
        const other = perTf.find((t) => t.tf !== closest!.tf);
        const confluence = (other?.zones ?? []).some((z) =>
          overlaps(z.entry, closest!.zone.entry),
        );
        const quadrant = deriveQuadrant(trend, closest.zone.direction);

        // The most recent break on either timeframe, read against the trend.
        // A supply zone giving way in an uptrend is the trend working; a
        // demand zone giving way in the same uptrend is it failing, and the
        // next demand below deserves suspicion rather than a queue.
        const lastBreak = perTf
          .flatMap((t) => t.broken)
          .sort((a, b) => b.brokenAt - a.brokenAt)[0];
        const recentBreak: BreakSignal = lastBreak
          ? readBreak(trend, lastBreak.zone.direction)
          : null;

        const { score, reasons } = scoreCandidate({
          quadrant,
          timeframe: closest.tf,
          fresh: !closest.zone.mitigated,
          confluence,
          distancePct: nearest!,
          recentBreak,
        });

        watch.push({
          symbol,
          side: closest.zone.direction === "demand" ? "long" : "short",
          zoneId: closest.zoneId,
          triggerLevel: round(closest.zone.entry),
          distancePct: round(nearest!),
          triggerNote:
            `price reaches the ${closest.tf} ${closest.zone.direction} edge at ` +
            `${round(closest.zone.entry)} (${closest.zone.mitigated ? "mitigated" : "fresh"}, ` +
            `stop ${round(closest.zone.sl)})`,
          quadrant,
          score,
          scoreReasons: reasons,
          // Structure first, distance only as a tiebreak — a countertrend
          // name at the level deserves less attention than a with-trend one
          // a percent away.
          priority: score >= 70 ? 1 : score >= 50 ? 2 : score >= 30 ? 3 : 4,
          active: near,
        });
      }

      // 14-day average daily range. The app needs it to tell a free stop move
      // from one that puts the stop inside a normal day's movement, and the
      // bars are already here — computing it anywhere else means fetching
      // them twice.
      const adrWindow = settled.slice(-14);
      const adr = adrWindow.length
        ? adrWindow.reduce((a, b) => a + (b.h - b.l), 0) / adrWindow.length
        : null;

      pass.push({
        symbol,
        distancePct: nearest === null ? null : round(nearest),
        nearZone: near,
        trend,
        adr: adr === null ? null : round(adr),
        note:
          `${perTf[0].zones.length}D+${perTf[1].zones.length}W zones, ` +
          `price ${price}${ma ? `, ema200 ${round(ma)}` : ""}` +
          `${adr === null ? "" : `, adr ${round(adr)}`}`,
      });

      console.log(
        `${tag} ${String(perTf[0].zones.length).padStart(2)}D ${String(perTf[1].zones.length).padStart(2)}W  ` +
          `${trend.padEnd(10)} nearest ${nearest === null ? "  none" : `${nearest.toFixed(2)}%`}` +
          `${near ? "  << near" : ""}`,
      );
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failed.push({ symbol, error });
      console.log(`${tag} FAILED — ${error.slice(0, 80)}`);
    }
  }

  if (pass.length) await post({ kind: "screener_pass", symbols: pass });
  if (watch.length) await post({ kind: "wishlist", items: watch });

  const nearCount = pass.filter((p) => p.nearZone).length;
  /**
   * An intraday pass that priced nothing did not do its job, whatever the
   * exit code says. That is a degraded run — the same standard as a sweep
   * that wrote no zones, and for the same reason: reporting green while
   * refreshing nothing is the silence this project keeps removing.
   */
  const allStale = afterOpen && stale.length === queue.length;
  const degraded = failed.length > queue.length / 4 || allStale;

  await post({
    kind: "run",
    agent: "zone_sweep",
    status: degraded ? "degraded" : "ok",
    degraded,
    notes:
      `${pass.length}/${queue.length} swept, ${zonesWritten} zones kept, ` +
      `${brokenReported} broken, ${ideasExpired} ideas expired, ` +
      `${nearCount} within ${NEAR_ZONE_PCT}%` +
      (stale.length
        ? `. ${stale.length} had no bar for today, so carry no live mark` +
          (allStale ? " — the data plan does not include the current session" : "")
        : "") +
      (failed.length
        ? `. Failed: ${failed.map((f) => f.symbol).join(", ")}`
        : ""),
  });

  console.log(
    `\n${pass.length}/${queue.length} swept · ${zonesWritten} zones · ` +
      `${nearCount} within ${NEAR_ZONE_PCT}% · ` +
      `${brokenReported} broken${ideasExpired ? `, ${ideasExpired} ideas expired` : ""} · ` +
      `${watch.filter((w) => w.active).length} watching, ` +
      `${watch.filter((w) => !w.active).length} retired`,
  );
  if (failed.length) {
    console.log(`${failed.length} failed: ${failed.map((f) => f.symbol).join(", ")}`);
  }
  if (stale.length) {
    console.log(
      `${stale.length} skipped — no bar for today, so no live mark to price against` +
        (allStale
          ? `.\nEvery symbol was stale: the data plan does not include the current ` +
            `session, so --after-open cannot do what it exists to do. The evening ` +
            `sweep's distances stand.`
          : `: ${stale.slice(0, 12).join(", ")}${stale.length > 12 ? "…" : ""}`),
    );
  }
  /**
   * Report the few worth a look, not everything that happens to be near a
   * level. With ~11 zones a name the second list is most of the universe,
   * and a list nobody can work through is as useless as an empty one.
   */
  const ranked = watch.filter((w) => w.active).sort((a, b) => b.score - a.score);
  const worth = ranked.filter((w) => w.score >= WORTH_OPENING_A_CHART);

  if (ranked.length) {
    console.log(
      `\nWorth opening a chart for (score ${WORTH_OPENING_A_CHART}+): ` +
        (worth.length
          ? worth.map((w) => `${w.symbol} ${w.score} ${w.quadrant}`).join(", ")
          : "none — everything near a level is countertrend or contested"),
    );
    if (ranked.length > worth.length) {
      console.log(
        `${ranked.length - worth.length} more sit near a level but do not earn the look.`,
      );
    }
  }

  // A sweep that wrote nothing is a failed sweep, and CI must show it as
  // one. Reporting a degraded run into the database and then exiting green
  // is the same silence this project keeps trying to remove — the run record
  // is for the app, the exit code is for the human watching Actions.
  if (degraded || zonesWritten === 0) {
    console.error(
      `\nFAILED: ${failed.length}/${queue.length} symbols errored, ` +
        `${zonesWritten} zones written.`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
