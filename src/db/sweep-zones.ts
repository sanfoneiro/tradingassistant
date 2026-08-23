import { readFileSync } from "fs";
import { join } from "path";
import { fetchDailyBars, Throttle, RATE_LIMIT_PER_MIN } from "../lib/massive";
import {
  computeZones,
  toWeekly,
  classifyTrend,
  distancePct,
  type Zone,
} from "../lib/zones";

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

/**
 * `??` is the wrong operator for environment variables. An unset GitHub
 * Actions input arrives as an EMPTY STRING, not undefined, so `??` keeps it
 * and every request goes to a relative URL with no host — which surfaces as
 * "Failed to parse URL from /api/state" rather than anything about
 * configuration. `||` treats blank as absent, which is what was meant.
 */
const APP_URL =
  process.env.APP_URL?.trim() || "https://project-alr3f.vercel.app";

/**
 * Token resolution, in the order that actually works.
 *
 * `.agent-token` is the project's convention — the skills read it from
 * there — and it is gitignored. It wins locally because a stale
 * INGEST_TOKEN in a `vercel env pull`-generated .env will otherwise
 * shadow it and produce a 401 that looks like a server fault. In CI there
 * is no such file and the environment variable is the only source.
 */
function resolveToken(): { token: string; source: string } {
  try {
    const fromFile = readFileSync(
      join(process.cwd(), ".agent-token"),
      "utf8",
    ).trim();
    if (fromFile) return { token: fromFile, source: ".agent-token" };
  } catch {
    /* not present — expected in CI */
  }
  const fromEnv = process.env.INGEST_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "INGEST_TOKEN env var" };
  return { token: "", source: "nowhere" };
}

const { token: TOKEN, source: TOKEN_SOURCE } = resolveToken();

/** Inside this band a name is worth the grader's attention. */
const NEAR_ZONE_PCT = 6;

type State = {
  screenerCoverage: {
    symbol: string;
    analyzedAt: string | null;
    lastScreenedAt: string;
  }[];
  zones: { symbol: string; timeframe: string; direction: string }[];
};

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${APP_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const post = (body: unknown) =>
  api("/api/ingest", { method: "POST", body: JSON.stringify(body) });

/** One zone → one ingest payload. Levels go over verbatim; the server
 *  derives the box and re-checks the midpoint, so nothing is computed twice
 *  in two places and allowed to disagree. */
function zonePayload(
  symbol: string,
  timeframe: "1D" | "1W",
  z: Zone,
  price: number,
) {
  return {
    kind: "zone" as const,
    symbol,
    direction: z.direction,
    timeframe,
    entryLevel: round(z.entry),
    midLevel: round(z.mid),
    stopLevel: round(z.sl),
    distancePct: round(distancePct(z.entry, price)),
    indicatorState: z.mitigated ? "Mitigated" : "Fresh",
    status: "untested" as const,
    confluence: [`MTF S&D ${timeframe}`],
    note: `computed from API bars, ${new Date().toISOString().slice(0, 10)}`,
  };
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

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

  const limit = Number(process.argv[2]) || Infinity;

  console.log(`reading the queue from ${APP_URL}…`);
  const state: State = await api("/api/state");

  // /api/state already returns coverage oldest-analysed first, nulls ahead
  // of everything, so the queue order is the app's and not reinvented here.
  const queue = state.screenerCoverage.map((c) => c.symbol).slice(0, limit);
  const never = state.screenerCoverage.filter((c) => !c.analyzedAt).length;

  console.log(
    `${state.screenerCoverage.length} in the universe, ${never} never analysed. ` +
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
    note: string;
  }[] = [];

  let zonesWritten = 0;
  const failed: { symbol: string; error: string }[] = [];

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
          note: `only ${daily.length} bars — insufficient history`,
        });
        console.log(`${tag} ${daily.length} bars, skipped`);
        continue;
      }

      const price = daily.at(-1)!.c;
      const { trend, ma } = classifyTrend(daily);

      const perTf: { tf: "1D" | "1W"; zones: Zone[] }[] = [
        { tf: "1D", zones: computeZones(daily) },
        { tf: "1W", zones: computeZones(toWeekly(daily)) },
      ];

      let nearest: number | null = null;
      for (const { tf, zones } of perTf) {
        for (const z of zones) {
          const d = distancePct(z.entry, price);
          if (nearest === null || Math.abs(d) < Math.abs(nearest)) nearest = d;
          await post(zonePayload(symbol, tf, z, price));
          zonesWritten++;
        }
      }

      const near = nearest !== null && Math.abs(nearest) <= NEAR_ZONE_PCT;
      pass.push({
        symbol,
        distancePct: nearest === null ? null : round(nearest),
        nearZone: near,
        trend,
        note:
          `${perTf[0].zones.length}D+${perTf[1].zones.length}W zones, ` +
          `price ${price}${ma ? `, ema200 ${round(ma)}` : ""}`,
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

  const nearCount = pass.filter((p) => p.nearZone).length;
  const degraded = failed.length > queue.length / 4;

  await post({
    kind: "run",
    agent: "zone_sweep",
    status: degraded ? "degraded" : "ok",
    degraded,
    notes:
      `${pass.length}/${queue.length} swept, ${zonesWritten} zones written, ` +
      `${nearCount} within ${NEAR_ZONE_PCT}%` +
      (failed.length
        ? `. Failed: ${failed.map((f) => f.symbol).join(", ")}`
        : ""),
  });

  console.log(
    `\n${pass.length}/${queue.length} swept · ${zonesWritten} zones · ` +
      `${nearCount} within ${NEAR_ZONE_PCT}% of a level`,
  );
  if (failed.length) {
    console.log(`${failed.length} failed: ${failed.map((f) => f.symbol).join(", ")}`);
  }
  if (nearCount) {
    console.log(
      `\nWorth grading: ${pass
        .filter((p) => p.nearZone)
        .sort((a, b) => Math.abs(a.distancePct!) - Math.abs(b.distancePct!))
        .map((p) => `${p.symbol} ${p.distancePct}%`)
        .join(", ")}`,
    );
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
