import type { Bar } from "./zones";

/**
 * Market data client (massive.com).
 *
 * This exists so prices stop depending on a browser being awake. Everything
 * here returns bars with a real source and timestamp, or throws — there is
 * no path that returns a plausible-looking empty result, because a silent
 * zero is the failure this project was built to eliminate.
 *
 * The free tier is 5 requests/minute, 15-minute delayed, two years of
 * history. Delay is irrelevant for zones: detection needs completed candles,
 * and the indicator confirms on bar[2].
 */

const HOST = "https://api.massive.com";

/** Free tier. Raise once the plan does. */
export const RATE_LIMIT_PER_MIN = 5;

export class MassiveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly symbol?: string,
  ) {
    super(message);
    this.name = "MassiveError";
  }
}

type AggResponse = {
  ticker?: string;
  status?: string;
  resultsCount?: number;
  results?: { o: number; h: number; l: number; c: number; v: number; t: number }[];
};

function apiKey(): string {
  const k = process.env.MASSIVE_API_KEY;
  if (!k) {
    throw new MassiveError(
      "MASSIVE_API_KEY is not set — refusing to run rather than reporting an empty universe",
    );
  }
  return k;
}

/**
 * Paced caller. The free tier counts requests per minute and answers 429
 * past that, so the throttle is part of correctness rather than politeness:
 * a burst turns into a page of errors that look exactly like "this symbol
 * has no data".
 */
export class Throttle {
  private times: number[] = [];
  constructor(private readonly perMinute = RATE_LIMIT_PER_MIN) {}

  async take(): Promise<void> {
    const now = Date.now();
    this.times = this.times.filter((t) => now - t < 60_000);
    if (this.times.length >= this.perMinute) {
      const waitMs = 60_000 - (now - this.times[0]) + 250;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.take();
    }
    this.times.push(Date.now());
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A rate limit is a "come back later", not a "this symbol has no data", and
 * conflating the two silently drops names from the universe. Two full sweeps
 * lost 26 and 39 of 115 symbols that way — clustered at the tail, because the
 * limit is cumulative — while every one of them fetched fine on its own.
 *
 * The throttle prevents most 429s; this catches the ones that slip past it,
 * usually because another sweep is running concurrently against the same key.
 * Backoff is generous: at five requests a minute the window is sixty seconds
 * wide, so waiting less than that just burns another attempt.
 */
const RETRY_DELAYS_MS = [20_000, 45_000, 90_000];

/** Key travels in the Authorization header, never the query string — URLs
 *  end up in logs and error reports. */
async function get(path: string, symbol?: string): Promise<AggResponse> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HOST}${path}`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
    });

    // 429 and 5xx are both transient. A 4xx that is not 429 means the request
    // itself is wrong, and retrying it just wastes the quota.
    const transient = res.status === 429 || res.status >= 500;

    if (transient && attempt < RETRY_DELAYS_MS.length) {
      // Honour the server's own instruction when it gives one.
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : RETRY_DELAYS_MS[attempt];
      await sleep(waitMs);
      continue;
    }

    if (res.status === 429) {
      throw new MassiveError(
        `rate limited after ${RETRY_DELAYS_MS.length + 1} attempts`,
        429,
        symbol,
      );
    }
    if (!res.ok) {
      throw new MassiveError(
        `${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`,
        res.status,
        symbol,
      );
    }
    return (await res.json()) as AggResponse;
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Daily bars, oldest first. Weekly is derived with `toWeekly` rather than
 * requested separately — one call per symbol covers both timeframes, which
 * matters a great deal at five requests a minute.
 *
 * Returns [] only when the API genuinely reports no rows for the range.
 * Anything else throws.
 */
export async function fetchDailyBars(
  symbol: string,
  opts: { years?: number; to?: Date } = {},
): Promise<Bar[]> {
  const to = opts.to ?? new Date();
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - (opts.years ?? 2));

  const body = await get(
    `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${iso(from)}/${iso(to)}` +
      `?adjusted=true&sort=asc&limit=50000`,
    symbol,
  );

  if (body.status && !["OK", "DELAYED"].includes(body.status)) {
    throw new MassiveError(`status ${body.status}`, undefined, symbol);
  }

  return (body.results ?? []).map((r) => ({
    t: r.t,
    o: r.o,
    h: r.h,
    l: r.l,
    c: r.c,
  }));
}

export type SymbolBars = {
  symbol: string;
  bars: Bar[];
  /** Close of the last completed bar. */
  lastClose: number | null;
  lastBarAt: Date | null;
};

/**
 * Fetch a batch, paced. Failures are collected rather than thrown, so one
 * dead ticker does not abort a universe sweep — but they come back named,
 * so a run can report "97 of 114" instead of quietly covering 97.
 */
export async function fetchUniverse(
  symbols: string[],
  opts: { years?: number; throttle?: Throttle; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ ok: SymbolBars[]; failed: { symbol: string; error: string }[] }> {
  const throttle = opts.throttle ?? new Throttle();
  const ok: SymbolBars[] = [];
  const failed: { symbol: string; error: string }[] = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    try {
      await throttle.take();
      const bars = await fetchDailyBars(symbol, { years: opts.years });
      const last = bars.at(-1);
      ok.push({
        symbol,
        bars,
        lastClose: last?.c ?? null,
        lastBarAt: last ? new Date(last.t) : null,
      });
    } catch (e) {
      failed.push({ symbol, error: e instanceof Error ? e.message : String(e) });
    }
    opts.onProgress?.(i + 1, symbols.length);
  }

  return { ok, failed };
}
