import postgres from "postgres";
import { Throttle, RATE_LIMIT_PER_MIN } from "../lib/massive";
import { etDate } from "../lib/session";

/**
 * Fills the `bars` table from grouped daily.
 *
 *   npm run bars:backfill              # two years
 *   npm run bars:backfill -- 60        # the last 60 sessions
 *   npm run bars:backfill -- --daily   # just extend to the newest session
 *
 * WHY THIS EXISTS. The universe has been ~115 names because one call per
 * symbol at five requests a minute takes 23 minutes. `/v2/aggs/grouped` returns
 * EVERY US ticker for a session in a single call — 12,485 of them — so the
 * same 23 minutes buys about 100 sessions of the whole market instead of one
 * day of 115 names. The screen was never the right universe; it was the
 * affordable one.
 *
 * WHY IT IS SAFE TO SUBSTITUTE. Grouped daily was tied out field by field
 * against the exact call `fetchDailyBars()` makes. For NKE on 2026-08-26,
 * `o h l c v vw n` are identical and only `t` differs — by sixteen hours,
 * because grouped stamps the close (20:00 UTC) and per-ticker stamps the
 * session start (midnight ET). We store a DATE, so that difference cannot
 * reach anything downstream.
 *
 * THE LIQUIDITY FILTER PICKS A DISCOVERY UNIVERSE, NOT THE WHOLE BOOK.
 * Held and tracked names are kept whatever their volume: SSB is an open
 * position and trades 0.50M shares a day, so a 1M floor would have dropped a
 * position we own out of the sweep. A filter that can silently delete
 * something you hold is not a filter, it is a bug.
 */

const KEY = () => process.env.MASSIVE_API_KEY!;
const HOST = "https://api.massive.com";

/**
 * Chosen for chart quality, not for Oron's size — at a ~$1,100 maximum
 * position even 100k shares a day is ample. What these exclude is names whose
 * bars are too sparse for a three-bar imbalance to mean anything. The OTC
 * foreign secondaries that used to eat analysis slots (DTEGF, SNEJF, ZIJMF)
 * do not appear in grouped daily at all, so they fall out for free.
 */
const MIN_PRICE = 5;
const MIN_VOLUME = 1_000_000;

/** Sessions used to judge liquidity. One day could be an earnings spike or a
 *  half-session; five is enough for a median to mean something. */
const SAMPLE_SESSIONS = 5;

const DEFAULT_SESSIONS = 504; // ~2 years, the plan's history limit

type Grouped = { T: string; o: number; h: number; l: number; c: number; v: number };

const throttle = new Throttle();

/**
 * A rate limit is a "come back later", not a "this session has no data" —
 * the same distinction `massive.ts` exists to protect, and this function
 * originally got it wrong. The throttle keeps one process under the limit,
 * but ANOTHER job against the same key (a sweep, the calendar sync) pushes
 * the shared budget over, and a single 429 then ended a two-hour backfill
 * after 23 sessions while exiting 0.
 *
 * Backoff is generous because at five requests a minute the window is sixty
 * seconds wide, so waiting less than that just burns another attempt.
 */
const RETRY_DELAYS_MS = [20_000, 45_000, 90_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function grouped(date: string): Promise<Grouped[] | null> {
  for (let attempt = 0; ; attempt++) {
    await throttle.take();
    const res = await fetch(
      `${HOST}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true`,
      { headers: { Authorization: `Bearer ${KEY()}` } },
    );
    if (res.status === 403) return null; // outside the plan's window — not an error

    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < RETRY_DELAYS_MS.length) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : RETRY_DELAYS_MS[attempt];
      console.log(`  ${date}: ${res.status}, waiting ${waitMs / 1000}s`);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) throw new Error(`grouped ${date} → ${res.status} ${res.statusText}`);
    const body = await res.json();
    return (body.results ?? []) as Grouped[];
  }
}

/**
 * Neon is serverless and a two-hour walk WILL lose its connection — the first
 * full run died on `write ECONNABORTED` at session 118 of 504, mid-insert.
 * A dropped socket is a "try again", not a reason to abandon 400 sessions of
 * work, and postgres.js reconnects on the next query.
 */
async function withRetry<T>(fn: () => Promise<T>, what: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const droppedSocket =
        /ECONNABORTED|ECONNRESET|EPIPE|ETIMEDOUT|CONNECTION_(CLOSED|ENDED)|terminating/i.test(
          msg,
        );
      if (!droppedSocket || attempt >= 3) throw e;
      const waitMs = [1_000, 5_000, 15_000][attempt];
      console.log(`  ${what}: ${msg} — reconnecting in ${waitMs / 1000}s`);
      await sleep(waitMs);
    }
  }
}

function prevDay(iso: string, n = 1): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const isWeekend = (iso: string) => {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
};

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function main() {
  if (!process.env.MASSIVE_API_KEY?.trim()) {
    console.error("MASSIVE_API_KEY is not set.");
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const dailyOnly = argv.includes("--daily");
  const sessions = dailyOnly
    ? SAMPLE_SESSIONS
    : Number(argv.find((a) => /^\d+$/.test(a))) || DEFAULT_SESSIONS;

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

  /* ---- which names does the book already care about? ---- */
  // These are kept regardless of liquidity. Dropping a name we hold, track,
  // or have zones for would remove it from the sweep silently.
  const tracked = new Set<string>(
    (
      await sql<{ symbol: string }[]>`
        SELECT symbol FROM screener_coverage
        UNION SELECT symbol FROM positions
        UNION SELECT symbol FROM wishlist
        UNION SELECT symbol FROM zones
      `
    ).map((r) => r.symbol),
  );
  console.log(`${tracked.size} names already tracked — kept whatever their volume.`);

  /* ---- pick the discovery universe from recent sessions ---- */
  const stats = new Map<string, { c: number[]; v: number[] }>();
  let cursor = prevDay(etDate(new Date())); // today is outside the plan
  let sampled = 0;
  while (sampled < SAMPLE_SESSIONS) {
    if (isWeekend(cursor)) {
      cursor = prevDay(cursor);
      continue;
    }
    const rows = await grouped(cursor);
    if (rows === null) {
      console.log(`  ${cursor}: outside the plan's window, stepping back`);
      cursor = prevDay(cursor);
      continue;
    }
    if (rows.length) {
      for (const b of rows) {
        if (!stats.has(b.T)) stats.set(b.T, { c: [], v: [] });
        const e = stats.get(b.T)!;
        e.c.push(b.c);
        e.v.push(b.v);
      }
      sampled++;
      console.log(`  ${cursor}: ${rows.length} tickers`);
    }
    cursor = prevDay(cursor);
  }

  const universe = new Set(tracked);
  let liquid = 0;
  for (const [t, e] of stats) {
    // Present on every sampled session — a ticker that shows up twice in five
    // days is not something to hold a swing position in.
    if (e.c.length < SAMPLE_SESSIONS) continue;
    if (median(e.c) >= MIN_PRICE && median(e.v) >= MIN_VOLUME) {
      universe.add(t);
      liquid++;
    }
  }
  console.log(
    `\nuniverse: ${universe.size} names ` +
      `(${liquid} clear $${MIN_PRICE}/${MIN_VOLUME / 1e6}M, ` +
      `${universe.size - liquid} kept because the book tracks them)\n`,
  );

  /* ---- what do we already have? ---- */
  const have = new Set(
    (
      await sql<{ d: string }[]>`SELECT DISTINCT d::text AS d FROM bars`
    ).map((r) => r.d),
  );
  if (have.size) console.log(`${have.size} session(s) already stored — skipping those.`);

  /* ---- walk back, session by session ---- */
  let day = prevDay(etDate(new Date()));
  let written = 0;
  let done = 0;
  let holidays = 0;
  let stoppedEarly: string | null = null;

  while (done < sessions) {
    if (isWeekend(day)) {
      day = prevDay(day);
      continue;
    }
    if (have.has(day)) {
      done++;
      day = prevDay(day);
      continue;
    }

    let rows: Grouped[] | null;
    try {
      rows = await grouped(day);
    } catch (e) {
      stoppedEarly = e instanceof Error ? e.message : String(e);
      console.log(`  ${day}: ${stoppedEarly} — stopping`);
      break;
    }
    if (rows === null) {
      // Either newer than the plan allows or older than its two-year window.
      console.log(`  ${day}: not in plan window`);
      day = prevDay(day);
      continue;
    }
    if (!rows.length) {
      holidays++;
      day = prevDay(day);
      continue; // market holiday — a real zero, and not counted as a session
    }

    const keep = rows.filter((b) => universe.has(b.T));
    // Insert in chunks: one statement per session would exceed the parameter
    // limit at ~1,800 rows x 7 columns.
    let inserted = 0;
    for (let i = 0; i < keep.length; i += 500) {
      const chunk = keep.slice(i, i + 500).map((b) => ({
        symbol: b.T,
        d: day,
        o: b.o,
        h: b.h,
        l: b.l,
        c: b.c,
        v: b.v ?? null,
      }));
      const res = await withRetry(
        () => sql`
          INSERT INTO bars ${sql(chunk, "symbol", "d", "o", "h", "l", "c", "v")}
          ON CONFLICT (symbol, d) DO NOTHING
        `,
        `insert ${day}`,
      );
      // Count what actually landed, not what was offered. ON CONFLICT DO
      // NOTHING means a re-run inserts zero, and a counter that reports the
      // attempt would show a full backfill on a run that wrote nothing.
      inserted += res.count ?? 0;
    }
    written += inserted;
    done++;
    console.log(
      `  ${day}: ${String(inserted).padStart(5)} of ${rows.length} kept ` +
        `(${done}/${sessions}, ${written} rows total)`,
    );
    day = prevDay(day);
    if (dailyOnly) break;
  }

  const [{ count, size }] = await sql<{ count: string; size: string }[]>`
    SELECT (SELECT count(*)::text FROM bars) AS count,
           pg_size_pretty(pg_total_relation_size('bars')) AS size
  `;
  console.log(
    `\n${written} rows written this run. bars now holds ${count} rows (${size}).` +
      (holidays ? ` ${holidays} market holiday(s) skipped.` : ""),
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
