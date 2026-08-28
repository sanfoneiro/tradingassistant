import { etWallClockToUtc } from "./session";

/**
 * Finviz calendars — earnings, economic releases, and ex-dividend dates.
 *
 * This exists because the two event vetoes had no source. Massive prices its
 * earnings calendar as a $99/mo partner dataset and does not sell a forward
 * macro calendar at all; `/fed/v1/*` returns the CPI *series*, not the date
 * of the next print. Finviz publishes all three, server-rendered, free.
 *
 * Three rules govern everything here, and they are not style preferences:
 *
 *  1. DATES AND EVENTS ONLY. `epsEstimate`, `yield` and `marketCap` are in
 *     the payload and are deliberately dropped. Nothing from a web page may
 *     become a number that sizes or grades a trade — that rule is the reason
 *     this project exists. A wrong date costs a mistimed trade; a wrong price
 *     gets traded.
 *
 *  2. EMPTY MEANS UNKNOWN, NEVER "NOTHING SCHEDULED". Finviz returns zero
 *     rows for weeks that certainly have earnings — dateFrom=2026-10-05 gave
 *     0 while 2026-10-19 gave 12 and 2026-11-16 gave 109. A veto reading
 *     "no earnings found" as "safe to open" would be wrong precisely on the
 *     weeks the data is thin.
 *
 *  3. ESTIMATED IS NOT CONFIRMED. Beyond roughly two weeks every row carries
 *     `isEarningDateEstimate: true`. Finviz is honest about it; so is this.
 *
 * The pages ship their data inside a single <script id="route-init-data">
 * JSON blob, so none of this is HTML scraping — it is one JSON.parse against
 * a documented-shape payload. `/calendar` carries no robots.txt restriction;
 * `/export` does, and is Elite-gated besides, so it is not used.
 */

export type Completeness = {
  /** What Finviz says exists for the window. */
  total: number;
  /**
   * False when the page returned fewer rows than it claims to have.
   * Server-side pagination does not work — `&page=2` is ignored and returns
   * page 1 again — so a window holding more than `pageSize` rows silently
   * yields the first 50. Losing 27 of 77 dividends without noticing is the
   * sweep's old rate-limit bug in new clothes.
   */
  complete: boolean;
};

export type EarningsEvent = {
  ticker: string;
  company: string;
  at: Date;
  /** Finviz's own flag. Carried through so the veto can weigh it. */
  estimated: boolean;
};

export type DividendEvent = {
  ticker: string;
  company: string;
  /** Ex-dividend date, YYYY-MM-DD. The date is the point; the amount is not. */
  exDate: string;
};

export type EconomicEvent = {
  event: string;
  at: Date;
  /** Finviz's impact rating, 1–3. 3 is the red bar. */
  importance: number;
  /** The period being reported, e.g. "Aug" — not a number we compute with. */
  reference: string | null;
};

export class FinvizError extends Error {
  constructor(message: string, readonly kind?: string) {
    super(message);
    this.name = "FinvizError";
  }
}

const BLOB =
  /<script id="route-init-data" type="application\/json">([\s\S]*?)<\/script>/;

/**
 * Pull the server-rendered payload out of a calendar page.
 *
 * Throws rather than returning null on a miss. A missing blob means the page
 * changed shape or we were served something else entirely, and the one thing
 * that must not happen is for that to read downstream as "no events".
 */
export function parseRouteInitData(html: string): Record<string, unknown> {
  const m = html.match(BLOB);
  if (!m) throw new FinvizError("no route-init-data blob — page shape changed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch (e) {
    throw new FinvizError(
      `route-init-data is not valid JSON: ${e instanceof Error ? e.message : e}`,
    );
  }
  const data = (parsed as { data?: unknown })?.data;
  if (!data || typeof data !== "object") {
    throw new FinvizError("route-init-data has no data object");
  }
  return data as Record<string, unknown>;
}

type Entries = {
  items?: unknown[];
  totalItemsCount?: number;
};

function entriesOf(data: Record<string, unknown>): {
  items: Record<string, unknown>[];
  meta: Completeness;
} {
  const e = data.entries as Entries | Record<string, unknown> | undefined;
  if (!e) throw new FinvizError("no entries in route-init-data");

  // Earnings and dividends nest under entries.items with pagination metadata.
  // The economic calendar uses a plain 0..n keyed object and has none.
  const raw = Array.isArray((e as Entries).items)
    ? ((e as Entries).items as unknown[])
    : Object.values(e as Record<string, unknown>);

  const items = raw.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === "object",
  );
  const total = (e as Entries).totalItemsCount ?? items.length;
  return { items, meta: { total, complete: items.length >= total } };
}

export function parseEarnings(html: string): EarningsEvent[] & { meta: Completeness } {
  const { items, meta } = entriesOf(parseRouteInitData(html));
  const out = items
    .filter((r) => typeof r.ticker === "string" && typeof r.earningsDate === "string")
    .map((r) => ({
      ticker: String(r.ticker),
      company: String(r.company ?? ""),
      at: etWallClockToUtc(String(r.earningsDate)),
      // Absent is treated as estimated. Assuming "confirmed" from a missing
      // field is the direction that gets a position opened into a print.
      estimated: r.isEarningDateEstimate !== false,
    }))
    .filter((e) => !Number.isNaN(e.at.getTime()));
  return Object.assign(out, { meta });
}

export function parseDividends(html: string): DividendEvent[] & { meta: Completeness } {
  const { items, meta } = entriesOf(parseRouteInitData(html));
  const out = items
    .filter((r) => typeof r.ticker === "string" && typeof r.exdate === "string")
    .map((r) => ({
      ticker: String(r.ticker),
      company: String(r.company ?? ""),
      exDate: String(r.exdate),
    }));
  return Object.assign(out, { meta });
}

export function parseEconomic(html: string): EconomicEvent[] & { meta: Completeness } {
  const { items, meta } = entriesOf(parseRouteInitData(html));
  const out = items
    .filter((r) => typeof r.event === "string" && typeof r.date === "string")
    .map((r) => ({
      event: String(r.event),
      at: etWallClockToUtc(String(r.date)),
      importance: Number(r.importance ?? 0),
      reference: r.reference == null ? null : String(r.reference),
    }))
    .filter((e) => !Number.isNaN(e.at.getTime()));
  return Object.assign(out, { meta });
}

const BASE = "https://finviz.com/calendar";
/** A real browser UA. Finviz serves the calendar to anyone; this only avoids
 *  being treated as an unknown client. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export async function fetchCalendar(
  kind: "earnings" | "economic" | "dividends",
  dateFrom: string,
): Promise<string> {
  const res = await fetch(`${BASE}/${kind}?dateFrom=${dateFrom}`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) {
    throw new FinvizError(`${kind} ${dateFrom} → ${res.status} ${res.statusText}`, kind);
  }
  return res.text();
}
