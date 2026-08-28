import type { Sql } from "postgres";
import type { Bar } from "./zones";
import { etWallClockToUtc } from "./session";

/**
 * Reading stored bars back out, so the sweep can work from disk instead of
 * the wire.
 *
 * THE TIMESTAMP IS RECONSTRUCTED, NOT STORED. `bars.d` is a session DATE,
 * because grouped daily and the per-ticker endpoint stamp the same session
 * sixteen hours apart. zones.ts wants `t` in milliseconds, so the date is
 * turned back into midnight ET — which is exactly what the per-ticker
 * endpoint returns. That makes the two paths comparable field for field
 * rather than merely equivalent in spirit.
 */

/**
 * classifyTrend() runs a 200-period EMA and looks back another 20, and
 * `ema()` yields null until it has `period` bars. Below this a symbol does
 * not get a wrong trend — it gets `contested`, which rank.ts guarantees can
 * never clear the bar. So a short history does not look like a bad candidate,
 * it looks like NO candidate, and a sweep run against a half-filled bars
 * table would report a clean run and an empty funnel.
 *
 * That is why this is a hard floor with a loud message rather than a filter.
 */
export const MIN_BARS_FOR_TREND = 220;

type Row = { d: string; o: number; h: number; l: number; c: number };

/** Midnight ET for a session date — the per-ticker endpoint's own convention. */
export function barTime(sessionDate: string): number {
  return etWallClockToUtc(`${sessionDate}T00:00:00`).getTime();
}

export async function loadBars(
  sql: Sql,
  symbol: string,
  years = 2,
): Promise<Bar[]> {
  const from = new Date();
  from.setUTCFullYear(from.getUTCFullYear() - years);
  const rows = await sql<Row[]>`
    SELECT d::text AS d, o, h, l, c
    FROM bars
    WHERE symbol = ${symbol} AND d >= ${from.toISOString().slice(0, 10)}
    ORDER BY d ASC
  `;
  return rows.map((r) => ({
    t: barTime(r.d),
    o: Number(r.o),
    h: Number(r.h),
    l: Number(r.l),
    c: Number(r.c),
  }));
}

/**
 * The sweep queue, widest first: every symbol with enough stored history to
 * be classifiable, ordered so the names the book already tracks come first.
 *
 * Ordering matters because a run can be capped. Sweeping 1,875 names and
 * stopping at 200 must not mean an open position never gets looked at.
 */
export async function universeFromBars(
  sql: Sql,
  minBars = MIN_BARS_FOR_TREND,
): Promise<{ symbol: string; bars: number; tracked: boolean }[]> {
  return sql<{ symbol: string; bars: number; tracked: boolean }[]>`
    WITH tracked AS (
      SELECT symbol FROM screener_coverage
      UNION SELECT symbol FROM positions
      UNION SELECT symbol FROM wishlist
      UNION SELECT symbol FROM zones
    )
    SELECT b.symbol,
           count(*)::int AS bars,
           (t.symbol IS NOT NULL) AS tracked
    FROM bars b
    LEFT JOIN tracked t ON t.symbol = b.symbol
    GROUP BY b.symbol, (t.symbol IS NOT NULL)
    HAVING count(*) >= ${minBars}
    ORDER BY (t.symbol IS NOT NULL) DESC, b.symbol ASC
  `;
}

/** How much history the store actually holds — so a run can refuse to sweep
 *  against a half-filled table instead of reporting an empty funnel. */
export async function storeDepth(
  sql: Sql,
): Promise<{ sessions: number; symbols: number; from: string | null; to: string | null }> {
  const [r] = await sql<
    { sessions: number; symbols: number; from: string | null; to: string | null }[]
  >`
    SELECT count(DISTINCT d)::int AS sessions,
           count(DISTINCT symbol)::int AS symbols,
           min(d)::text AS from,
           max(d)::text AS to
    FROM bars
  `;
  return r;
}
