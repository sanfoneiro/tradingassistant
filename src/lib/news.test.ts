import { describe, it, expect } from "vitest";
import { parseArticles } from "./news";

/**
 * Built from the REAL response observed on 2026-08-27, including the fields
 * the parser ignores. The first article is the actual one that exposed the
 * bug: a piece about lululemon that tags NKE fourth, whose `insights[0]` is
 * LULU's sentiment.
 */
const BODY = {
  count: 3,
  status: "OK",
  results: [
    {
      id: "46eebe88",
      publisher: { name: "Zacks Investment Research", homepage_url: "https://zacks.com" },
      title: "lululemon Q2 Earnings Upcoming: Is It Likely to Surprise Investors?",
      author: "Zacks",
      published_utc: "2026-08-27T14:12:00Z",
      article_url: "https://example.com/a",
      tickers: ["LULU", "VSXY", "M", "NKE"],
      image_url: "https://example.com/i.png",
      description: "…",
      keywords: ["earnings"],
      insights: [
        { ticker: "LULU", sentiment: "negative", sentiment_reasoning: "Expected EPS decline" },
        { ticker: "VSXY", sentiment: "positive", sentiment_reasoning: "Share gains" },
        { ticker: "M", sentiment: "positive", sentiment_reasoning: "Category strength" },
        { ticker: "NKE", sentiment: "negative", sentiment_reasoning: "Sportswear softness" },
      ],
    },
    {
      id: "aa11",
      publisher: { name: "The Motley Fool" },
      title: "Why Is Nike Stock Declining?",
      published_utc: "2026-08-23T04:23:01Z",
      article_url: "https://example.com/b",
      tickers: ["NKE", "KO"],
      insights: [
        { ticker: "NKE", sentiment: "negative", sentiment_reasoning: "China exposure" },
        { ticker: "KO", sentiment: "neutral", sentiment_reasoning: "Unaffected" },
      ],
    },
    {
      id: "bb22",
      publisher: { name: "Reuters" },
      title: "An article with no insights block at all",
      published_utc: "2026-08-22T10:00:00Z",
      article_url: "https://example.com/c",
      tickers: ["NKE"],
    },
  ],
};

describe("parseArticles", () => {
  /**
   * The regression. Reading insights[0] for NKE yields LULU's "negative"
   * — which happens to match here, so an equality check alone would pass for
   * the wrong reason. The reasoning text is what distinguishes them.
   */
  it("selects the insight by ticker, never by position", () => {
    const [a] = parseArticles(BODY, "NKE");
    expect(a.tickers[0]).toBe("LULU"); // precondition: NKE is NOT first
    expect(a.sentiment).toBe("negative");
    expect(a.reasoning).toBe("Sportswear softness"); // NKE's, not LULU's
    expect(a.reasoning).not.toBe("Expected EPS decline");
  });

  it("returns a different ticker's insight when asked for that ticker", () => {
    const [a] = parseArticles(BODY, "M");
    expect(a.sentiment).toBe("positive");
    expect(a.reasoning).toBe("Category strength");
  });

  it("marks an article primary only when the symbol is the lead tag", () => {
    const nke = parseArticles(BODY, "NKE");
    expect(nke[0].isPrimary).toBe(false); // a lululemon piece
    expect(nke[1].isPrimary).toBe(true); // actually about Nike
  });

  it("returns null sentiment rather than guessing when there is no insight", () => {
    const nke = parseArticles(BODY, "NKE");
    expect(nke[2].sentiment).toBeNull();
    expect(nke[2].reasoning).toBeNull();
  });

  it("returns null sentiment when the ticker is absent from the insights", () => {
    const a = parseArticles(BODY, "ZZZ");
    expect(a[0].sentiment).toBeNull();
    expect(a[0].reasoning).toBeNull();
  });

  it("keeps publisher and timestamp", () => {
    const [a] = parseArticles(BODY, "NKE");
    expect(a.publisher).toBe("Zacks Investment Research");
    expect(a.publishedAt.toISOString()).toBe("2026-08-27T14:12:00.000Z");
  });
});
