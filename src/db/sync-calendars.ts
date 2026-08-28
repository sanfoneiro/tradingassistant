import { fetchCalendar, parseEarnings, parseEconomic, FinvizError } from "../lib/finviz";
import { resolveToken, makeClient } from "../lib/ingest-client";
import { etDate } from "../lib/session";

/**
 * The catalyst calendar — earnings, macro releases, and ex-dividend dates.
 *
 * This closes the two event vetoes that have never had a source. `catalysts`
 * has been empty since the table was created, so "no new position within 48h
 * of earnings" and "no resting limit order through a binary event" were being
 * resolved by per-name web search on every grader run, or not at all.
 *
 *   npm run calendars:sync
 *   npm run calendars:sync -- 14      # a shorter horizon
 *
 * EACH CALENDAR COMES FROM THE SOURCE THAT IS ACTUALLY BEST AT IT:
 *
 *   earnings   Finviz. Massive prices this as a $99/mo partner dataset.
 *   economic   Finviz. Massive does not sell a forward macro calendar at all
 *              — `/fed/v1/inflation` returns the CPI series, not the date of
 *              the next print.
 *   dividends  MASSIVE, not Finviz. Finviz caps a day at 50 rows and its
 *              server-side pagination does not work (`&page=2` returns page 1
 *              again), so 2026-08-31 reported 77 and delivered 50. Massive
 *              returned 177 for the same day with a working `next_url`.
 *              Silently losing a third of a calendar is the sweep's old
 *              rate-limit bug in new clothes.
 *
 * THE WINDOWS ARE NOT THE SAME SHAPE, which is not documented anywhere and
 * was measured: `dateFrom` selects a SINGLE DAY for earnings, but a WEEK for
 * the economic calendar. Stepping both daily would work and waste six
 * requests in seven.
 *
 * AN EMPTY DAY IS NOT NEWS THAT NOTHING IS SCHEDULED. Finviz returns zero
 * rows for weeks that certainly have earnings — 2026-10-05 gave 0 while
 * 2026-10-19 gave 12 and 2026-11-16 gave 109 — and a real market holiday
 * (2026-09-07, Labor Day) returns zero too. The two are indistinguishable
 * from here, so the run reports coverage rather than implying completeness,
 * and a day that failed outright is named.
 */

const { token: TOKEN, source: TOKEN_SOURCE } = resolveToken();
const { post } = makeClient(TOKEN);

/** How far forward to build the calendar. Beyond about two weeks every
 *  earnings date is an estimate anyway. */
const DEFAULT_HORIZON_DAYS = 28;

/** Below this, the economic calendar is bill auctions and mortgage-rate
 *  prints. The veto is about events that move a tape. */
const MIN_IMPORTANCE = 2;

/** Polite pacing. Finviz publishes no rate limit and imposes none that we
 *  hit; this is restraint, not a workaround. */
const PACE_MS = 1100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Item = {
  symbol: string | null;
  kind: string;
  eventAt: string;
  note: string | null;
};

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  if (!TOKEN) {
    console.error("No ingest token found. Put it in .agent-token, or set INGEST_TOKEN.");
    process.exit(1);
  }
  if (!process.env.MASSIVE_API_KEY?.trim()) {
    console.error("MASSIVE_API_KEY is not set — dividends could not be fetched.");
    process.exit(1);
  }
  console.log(`auth: ${TOKEN_SOURCE} (${TOKEN.length} chars)`);

  const horizon =
    Number(process.argv.slice(2).find((a) => /^\d+$/.test(a))) || DEFAULT_HORIZON_DAYS;
  // "Today" is the exchange's today, not the machine's. Running this from
  // Israel after midnight would otherwise skip a US session.
  const start = etDate(new Date());
  const end = addDays(start, horizon);
  console.log(`building the calendar for ${start} → ${end} (${horizon} days)\n`);

  /**
   * Kept per sub-calendar rather than in one bucket, because a payload
   * REPLACES the kinds it carries. Mixing them meant a failed dividends fetch
   * still shipped earnings and macro, and the handler's blanket delete then
   * wiped every stored ex-dividend row.
   *
   * A sub-calendar that failed anywhere is dropped whole: its rows are not
   * sent and its kinds are not listed, so what is already stored survives.
   * Stale ex-dates are still true facts; a partial replacement would silently
   * delete real events for the days that failed.
   */
  const groups: Record<string, { kinds: string[]; items: Item[]; failed: boolean }> = {
    earnings: { kinds: ["earnings", "earnings_estimated"], items: [], failed: false },
    macro: { kinds: ["macro"], items: [], failed: false },
    dividends: { kinds: ["ex_dividend"], items: [], failed: false },
  };
  const failures: string[] = [];
  let emptyDays = 0;

  /* ---------------- earnings: one request per day ---------------- */
  let earningsDays = 0;
  let tradingDays = 0;
  for (let i = 0; i < horizon; i++) {
    const day = addDays(start, i);
    // Companies do not report on a Saturday. Fetching weekends spends a
    // request to learn nothing and, worse, inflates the "returned nothing"
    // count with days that are legitimately empty — which is the one number
    // here that has to stay meaningful.
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    tradingDays++;
    try {
      const rows = parseEarnings(await fetchCalendar("earnings", day));
      if (!rows.length) emptyDays++;
      else earningsDays++;
      for (const e of rows) {
        groups.earnings.items.push({
          symbol: e.ticker,
          // The estimate flag lives in `kind` rather than only in prose, so a
          // consumer can filter on it without parsing a sentence. An
          // estimated date must not carry the same veto weight as a
          // confirmed one.
          kind: e.estimated ? "earnings_estimated" : "earnings",
          eventAt: e.at.toISOString(),
          note: `${e.company} — ${e.estimated ? "estimated" : "confirmed"} date (finviz)`,
        });
      }
      if (!rows.meta.complete) {
        failures.push(`earnings ${day} truncated (${rows.length}/${rows.meta.total})`);
        groups.earnings.failed = true;
      }
      process.stdout.write(`  earnings ${day}: ${String(rows.length).padStart(3)}\r`);
    } catch (e) {
      failures.push(`earnings ${day}: ${e instanceof Error ? e.message : String(e)}`);
      groups.earnings.failed = true;
    }
    await sleep(PACE_MS);
  }
  console.log(
    `earnings: ${groups.earnings.items.length} events across ${earningsDays}/${tradingDays} ` +
      `weekdays (${emptyDays} returned nothing — unknown, not necessarily clear)`,
  );

  /* ------------- economic: one request per WEEK ------------- */
  const seenEvents = new Set<string>();
  for (let i = 0; i < horizon; i += 7) {
    const day = addDays(start, i);
    try {
      const rows = parseEconomic(await fetchCalendar("economic", day));
      for (const ev of rows) {
        if (ev.importance < MIN_IMPORTANCE) continue;
        // Weeks overlap at the edges, so the same release arrives twice.
        const key = `${ev.event}|${ev.at.toISOString()}`;
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);
        groups.macro.items.push({
          symbol: null, // null symbol = macro, per the schema
          kind: "macro",
          eventAt: ev.at.toISOString(),
          note: `${ev.event}${ev.reference ? ` (${ev.reference})` : ""} — impact ${ev.importance}/3 (finviz)`,
        });
      }
    } catch (e) {
      failures.push(`economic ${day}: ${e instanceof Error ? e.message : String(e)}`);
      groups.macro.failed = true;
    }
    await sleep(PACE_MS);
  }
  console.log(
    `economic: ${groups.macro.items.length} releases at impact ${MIN_IMPORTANCE}+`,
  );

  /* ---------- dividends: Massive, paginated to exhaustion ---------- */
  try {
    let url =
      `https://api.massive.com/stocks/v1/dividends` +
      `?ex_dividend_date.gte=${start}&ex_dividend_date.lte=${end}&limit=1000`;
    let pages = 0;
    while (url && pages < 20) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.MASSIVE_API_KEY}` },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = await res.json();
      for (const d of body.results ?? []) {
        if (!d.ticker || !d.ex_dividend_date) continue;
        groups.dividends.items.push({
          symbol: d.ticker,
          kind: "ex_dividend",
          // Ex-dividend is a date, not a moment; anchor it at the open so it
          // sorts sensibly beside timed events.
          eventAt: new Date(`${d.ex_dividend_date}T13:30:00Z`).toISOString(),
          // The amount comes from Massive, not from a web page, so it is a
          // number we are allowed to keep — dividendImpact() needs it, and
          // the table has no column for it.
          note:
            `ex-dividend ${d.cash_amount ?? "?"}` +
            (d.pay_date ? `, pays ${d.pay_date}` : "") +
            " (massive)",
        });
      }
      url = body.next_url
        ? `${body.next_url}${body.next_url.includes("?") ? "&" : "?"}limit=1000`
        : "";
      pages++;
      if (url) await sleep(300);
    }
    console.log(
      `dividends: ${groups.dividends.items.length} ex-dates across ${pages} page(s)`,
    );
  } catch (e) {
    failures.push(`dividends: ${e instanceof Error ? e.message : String(e)}`);
    groups.dividends.failed = true;
    console.log(`dividends: FAILED — ${e instanceof Error ? e.message : e}`);
  }

  /* ----------------------- write ----------------------- */
  /**
   * One POST, carrying only the sub-calendars that fetched cleanly.
   *
   * The payload REPLACES the kinds it names, so a sub-calendar that failed
   * anywhere is left out entirely rather than sent half-built — its stored
   * rows then survive untouched. Sending a partial earnings set would delete
   * the days that failed and put nothing back, which turns a transient 429
   * into a silently missing veto input.
   */
  const shipped = Object.entries(groups).filter(([, g]) => !g.failed && g.items.length);
  const skipped = Object.entries(groups).filter(([, g]) => g.failed);
  const items = shipped.flatMap(([, g]) => g.items);
  const kinds = shipped.flatMap(([, g]) => g.kinds);

  for (const [name, g] of skipped) {
    console.log(
      `${name}: NOT posted — ${g.items.length} row(s) fetched but the set is ` +
        `incomplete. Whatever is already stored is kept rather than replaced ` +
        `with a partial calendar.`,
    );
  }

  if (!items.length) {
    console.error(
      "\nNothing was collected. Refusing to post — an empty payload is a no-op, " +
        "but a run that collected nothing is a failure and must say so.",
    );
    await post({
      kind: "run",
      agent: "calendar_sync",
      status: "failed",
      degraded: true,
      notes: `collected nothing for ${start}→${end}. ${failures.join("; ").slice(0, 400)}`,
    });
    process.exit(1);
  }

  items.sort((a, b) => a.eventAt.localeCompare(b.eventAt));
  const res = await post({ kind: "catalysts", kinds, items });

  const counts = items.reduce<Record<string, number>>((acc, i) => {
    acc[i.kind] = (acc[i.kind] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");

  const degraded = failures.length > 0 || skipped.length > 0;
  await post({
    kind: "run",
    agent: "calendar_sync",
    status: degraded ? "degraded" : "ok",
    degraded,
    notes:
      `${start}→${end}: ${summary}. ` +
      `${emptyDays}/${tradingDays} weekdays returned no earnings (unknown, not confirmed clear)` +
      (skipped.length
        ? `. NOT refreshed, prior rows kept: ${skipped.map(([n]) => n).join(", ")}`
        : "") +
      (failures.length ? `. Problems: ${failures.join("; ").slice(0, 500)}` : ""),
  });

  console.log(
    `\nposted ${items.length} catalysts, replacing ${kinds.join(", ")} → ` +
      JSON.stringify(res),
  );
  console.log(`  ${summary}`);
  if (failures.length) {
    console.log(`\n${failures.length} problem(s):`);
    for (const f of failures.slice(0, 15)) console.log(`  - ${f}`);
  }
  console.log(
    `\n${emptyDays} of ${horizon} days returned no earnings. That is UNKNOWN, not ` +
      `"nothing scheduled" — Finviz returns zero for thin weeks and for market ` +
      `holidays alike, and the two are indistinguishable from here.`,
  );
}

main().catch((e) => {
  console.error(e instanceof FinvizError ? `finviz: ${e.message}` : e);
  process.exit(1);
});
