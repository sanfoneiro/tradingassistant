import { Throttle } from "../lib/massive";
import { resolveToken, makeClient } from "../lib/ingest-client";
import { etDate } from "../lib/session";
import { repriceRows, type RepriceRow } from "../lib/reprice";

/**
 * Re-measure every active wishlist distance against the newest session the
 * plan serves — one grouped-daily call for the whole list.
 *
 *   npm run wishlist:reprice          locally
 *   npx tsx src/db/reprice-wishlist.ts   in the cloud, where there is no .env
 *
 * WHY. On 2026-10-03 the grader banded on distances that tied exactly to
 * Thursday's close, a session behind, and had to rebuild the shortlist by
 * hand. The sweep now runs after New York midnight so it prices the session
 * that just closed — but it runs from GitHub's scheduler, which delays and
 * drops runs, and nothing downstream could tell a fresh number from a stale
 * one. This is the check, run by the grader before it shortlists. On a
 * healthy day every row is already current and it posts nothing.
 *
 * API-only on purpose: no DATABASE_URL, so it runs wherever the grader does.
 * It moves distances, never levels — see src/lib/reprice.ts.
 */

const { token: TOKEN, source: TOKEN_SOURCE } = resolveToken();
const { api, post } = makeClient(TOKEN);
const HOST = "https://api.massive.com";
const throttle = new Throttle();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Below this a grouped file is not a full session — a half-written file
 *  would turn real names into "missing". A normal session carries ~12,000. */
const MIN_TICKERS = 5_000;

type Grouped = { T: string; c: number };

/**
 * The newest session the plan will serve. Today is refused with a 403 on a
 * previous-day-only plan and a market holiday comes back empty, so walk
 * backwards until a full file appears. A 429 is "come back later", never
 * "no data" — the distinction backfill-bars.ts once got wrong.
 */
async function latestSession(): Promise<{ session: string; closes: Map<string, number> }> {
  const d = new Date(`${etDate(new Date())}T12:00:00Z`);
  for (let back = 0; back < 8; back++, d.setUTCDate(d.getUTCDate() - 1)) {
    const day = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;

    for (let attempt = 0; attempt < 4; attempt++) {
      await throttle.take();
      const res = await fetch(
        `${HOST}/v2/aggs/grouped/locale/us/market/stocks/${day}?adjusted=true&include_otc=true`,
        { headers: { Authorization: `Bearer ${process.env.MASSIVE_API_KEY}` } },
      );
      if (res.status === 429 || res.status >= 500) {
        console.log(`  ${day}: ${res.status}, waiting`);
        await sleep([20_000, 45_000, 90_000, 90_000][attempt]);
        continue;
      }
      if (res.status === 403) {
        console.log(`  ${day}: not served yet on this plan`);
        break;
      }
      if (!res.ok) throw new Error(`grouped ${day} → ${res.status} ${res.statusText}`);
      const rows = ((await res.json()).results ?? []) as Grouped[];
      if (rows.length < MIN_TICKERS) {
        console.log(`  ${day}: ${rows.length} tickers — holiday or incomplete, going back`);
        break;
      }
      return { session: day, closes: new Map(rows.map((r) => [r.T, r.c])) };
    }
  }
  throw new Error("no full grouped-daily session in the last 8 days");
}

async function main() {
  if (!TOKEN) throw new Error("No ingest token: .agent-token locally, INGEST_TOKEN in the cloud.");
  if (!process.env.MASSIVE_API_KEY?.trim()) throw new Error("MASSIVE_API_KEY is not set.");
  console.log(`auth: ${TOKEN_SOURCE} (${TOKEN.length} chars)`);

  const state = await api("/api/state");
  const rows = (state.wishlist ?? []) as RepriceRow[];
  const { session, closes } = await latestSession();
  const r = repriceRows(rows, closes, session);

  console.log(
    `\nsession ${session}: ${rows.length} active rows — ${r.items.length} repriced, ` +
      `${r.current.length} already current, ${r.missing.length} with no close, ` +
      `${r.untriggered.length} with no trigger`,
  );

  let skipped: string[] = [];
  if (r.items.length) {
    const res = await post({ kind: "wishlist_reprice", items: r.items });
    skipped = res.skipped ?? [];
    for (const it of r.items) {
      const before = rows.find((x) => x.symbol === it.symbol);
      console.log(
        `  ${it.symbol.padEnd(6)} ${String(before?.distancePct ?? "—").padStart(9)} ` +
          `(${before?.pricedSession ?? "unknown"}) → ${it.distancePct.toFixed(4)}`,
      );
    }
    if (skipped.length) console.log(`  refused by the server (trigger moved): ${skipped.join(" ")}`);
  }
  if (r.missing.length) {
    console.log(`  no close in the grouped file — verify per ticker: ${r.missing.join(" ")}`);
  }

  await post({
    kind: "run",
    agent: "wishlist_reprice",
    status: "ok",
    degraded: false,
    notes:
      `session ${session}: ${r.items.length - skipped.length} repriced, ` +
      `${r.current.length} already current, ${skipped.length} refused, ` +
      `${r.missing.length} with no grouped close` +
      (r.missing.length ? ` (${r.missing.join(" ").slice(0, 300)})` : ""),
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
