/**
 * Ticker-scoped news.
 *
 * This replaces per-name web search for the ONE question the app can answer
 * without judgement: has anything been published about a name we hold, and
 * when. What the news MEANS is the grader's call — fundamentals are a veto
 * owned by the skill, and a vendor's sentiment label is a judgement, not a
 * fact. So this retrieves and attributes; it does not conclude.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID. `?ticker=NKE` returns every article
 * where NKE is one of the tagged names, and `insights` is a per-ticker array
 * in no particular order:
 *
 *   "lululemon Q2 Earnings Upcoming…"
 *     tickers:  ["LULU","VSXY","M","NKE"]
 *     insights: LULU=negative, VSXY=positive, M=positive, NKE=negative
 *
 * Reading `insights[0]` for NKE returns LULU's sentiment. That is a plausible
 * wrong value rather than a missing one, which is the exact failure this
 * project was built around — so the insight is selected BY TICKER or it is
 * null, never by position.
 */

export type Article = {
  title: string;
  publisher: string;
  publishedAt: Date;
  url: string;
  /** All tickers the publisher tagged — so "is this actually about us?" is
   *  answerable rather than assumed. */
  tickers: string[];
  /** The insight for THIS ticker, or null. Never another ticker's. */
  sentiment: "positive" | "negative" | "neutral" | null;
  reasoning: string | null;
  /** False when the article merely mentions the symbol alongside others. */
  isPrimary: boolean;
};

type RawInsight = { ticker?: string; sentiment?: string; sentiment_reasoning?: string };

type Sentiment = Article["sentiment"];

/** Anything the vendor sends that is not one of the three known labels
 *  becomes null. An unrecognised label is not a fourth kind of opinion. */
function asSentiment(s: unknown): Sentiment {
  return s === "positive" || s === "negative" || s === "neutral" ? s : null;
}

const HOST = "https://api.massive.com";

export function parseArticles(body: unknown, ticker: string): Article[] {
  const results = (body as { results?: unknown[] })?.results ?? [];
  return results
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => {
      const tickers = Array.isArray(r.tickers) ? r.tickers.map(String) : [];
      const insights = Array.isArray(r.insights) ? (r.insights as RawInsight[]) : [];
      // Selected by ticker, not by position. See the module comment.
      const mine = insights.find((i) => i?.ticker === ticker) ?? null;
      return {
        title: String(r.title ?? ""),
        publisher: String(
          (r.publisher as { name?: string } | undefined)?.name ?? "unknown",
        ),
        publishedAt: new Date(String(r.published_utc ?? "")),
        url: String(r.article_url ?? ""),
        tickers,
        sentiment: asSentiment(mine?.sentiment),
        reasoning: mine?.sentiment_reasoning ? String(mine.sentiment_reasoning) : null,
        // First tag is the publisher's own idea of the subject. A name buried
        // at position four in a piece about a competitor is context, not news
        // about us, and presenting the two the same way is how a list stops
        // being read.
        isPrimary: tickers[0] === ticker,
      };
    })
    .filter((a) => a.title && !Number.isNaN(a.publishedAt.getTime()));
}

async function get(url: string, apiKey: string, ticker: string): Promise<Article[]> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`news ${ticker} → ${res.status} ${res.statusText}`);
  return parseArticles(await res.json(), ticker);
}

export async function fetchNews(
  ticker: string,
  sinceHours: number,
  apiKey: string,
  limit = 20,
): Promise<Article[]> {
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
  return get(
    `${HOST}/v2/reference/news?ticker=${encodeURIComponent(ticker)}` +
      `&published_utc.gte=${since}&order=desc&sort=published_utc&limit=${limit}`,
    apiKey,
    ticker,
  );
}

/**
 * The newest article this feed has for a name, at any age.
 *
 * Coverage is wildly uneven and that matters more than it looks: on
 * 2026-08-27 the newest CBRE article was 73 days old while NKE had one from
 * that morning. "Nothing published in 96h" is therefore true of CBRE and
 * still misleading — it reads as a quiet tape when it means the feed barely
 * covers the name. Asked this way, an empty window can be reported as thin
 * coverage rather than as silence.
 */
export async function newestArticleAt(
  ticker: string,
  apiKey: string,
): Promise<Date | null> {
  const [newest] = await get(
    `${HOST}/v2/reference/news?ticker=${encodeURIComponent(ticker)}` +
      `&order=desc&sort=published_utc&limit=1`,
    apiKey,
    ticker,
  );
  return newest?.publishedAt ?? null;
}
