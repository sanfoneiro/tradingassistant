import { fetchNews, newestArticleAt, type Article } from "../lib/news";
import { resolveToken, makeClient, APP_URL } from "../lib/ingest-client";
import { Throttle } from "../lib/massive";

/**
 * What is happening to the names we already hold.
 *
 *   npm run positions:watch
 *   npm run positions:watch -- 72     # look back further than 24h
 *
 * WHY. Every gate in this system is checked at ENTRY and none afterwards. The
 * old twice-daily brief did check open positions for news each run, and that
 * was the one genuinely good idea in it — dropped when the brief was replaced.
 * This restores it against a sourced feed instead of web search.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not post action items and it does
 * not tell you what the news means. An action item is something to DO, and a
 * headline is an observation — a list that fills with observations is a list
 * nobody reads, and then the cost-of-delay counter measures attention nobody
 * is paying. Whether a story changes the thesis is the grader's judgement and
 * belongs in the skill, not in a script.
 *
 * The one thing it will say plainly is when a HELD name has a confirmed
 * earnings date or an ex-dividend inside the window, because that is a fact
 * with a date attached and it is what the two event vetoes are about.
 */

const { token: TOKEN } = resolveToken();
const { api } = makeClient(TOKEN);

const DEFAULT_LOOKBACK_HOURS = 24;
/** How far ahead a scheduled event is worth mentioning. The earnings veto is
 *  48h; a week of warning is useful without becoming a calendar dump. */
const EVENT_HORIZON_DAYS = 7;

type State = {
  asOf: string;
  markSource: string;
  positions: {
    symbol: string;
    side: string;
    qty: number;
    entry: number;
    stop: number | null;
    mark: number | null;
    pl: number;
    riskFromMark: number;
  }[];
  catalysts: { symbol: string | null; kind: string; eventAt: string; note: string | null }[];
};

const fmtAge = (d: Date) => {
  const h = (Date.now() - d.getTime()) / 3_600_000;
  return h < 1 ? `${Math.round(h * 60)}m ago` : `${h.toFixed(0)}h ago`;
};

async function main() {
  if (!TOKEN) {
    console.error("No ingest token found. Put it in .agent-token, or set INGEST_TOKEN.");
    process.exit(1);
  }
  const key = process.env.MASSIVE_API_KEY?.trim();
  if (!key) {
    console.error("MASSIVE_API_KEY is not set — refusing to run rather than guessing.");
    process.exit(1);
  }

  const hours =
    Number(process.argv.slice(2).find((a) => /^\d+$/.test(a))) || DEFAULT_LOOKBACK_HOURS;

  const state: State = await api("/api/state");
  const positions = state.positions ?? [];

  if (!positions.length) {
    console.log("No open positions. Nothing to watch.");
    return;
  }

  // Morning Sync is manual and deliberately unscheduled, so a stale asOf is
  // normal rather than a fault — but sizing and P/L come off that mark, so
  // say how old it is instead of quietly presenting it as current.
  const markAge = (Date.now() - new Date(state.asOf).getTime()) / 3_600_000;
  console.log(
    `${positions.length} open position(s) · marks ${markAge.toFixed(0)}h old ` +
      `(${state.markSource})\n`,
  );

  const horizon = Date.now() + EVENT_HORIZON_DAYS * 86_400_000;
  const throttle = new Throttle();
  let anythingToSay = false;

  for (const p of positions) {
    let articles: Article[] = [];
    let newsError: string | null = null;
    try {
      await throttle.take();
      articles = await fetchNews(p.symbol, hours, key);
    } catch (e) {
      newsError = e instanceof Error ? e.message : String(e);
    }

    // An article that merely mentions the symbol beside others is context;
    // one the publisher tagged first is news about us. Both are shown, but
    // not as though they were the same thing.
    const primary = articles.filter((a) => a.isPrimary);
    const mentions = articles.filter((a) => !a.isPrimary);

    const events = (state.catalysts ?? [])
      .filter((c) => c.symbol === p.symbol)
      .filter((c) => {
        const t = new Date(c.eventAt).getTime();
        return t > Date.now() && t < horizon;
      })
      .sort((a, b) => a.eventAt.localeCompare(b.eventAt));

    const quiet = !primary.length && !mentions.length && !events.length && !newsError;

    const pl = p.pl >= 0 ? `+$${p.pl.toFixed(2)}` : `-$${Math.abs(p.pl).toFixed(2)}`;
    console.log(
      `${p.symbol.padEnd(6)} ${p.side.padEnd(5)} ${String(p.qty).padStart(4)} @ ${p.entry.toFixed(2)}` +
        `  mark ${p.mark?.toFixed(2) ?? "none"}  ${pl}` +
        `  risk-from-here $${p.riskFromMark.toFixed(2)}`,
    );

    if (newsError) {
      // A failed lookup is not "no news". Conflating the two is how a name
      // gets a clean bill of health it was never given.
      console.log(`   ! news lookup failed: ${newsError} — this is UNKNOWN, not quiet`);
      anythingToSay = true;
    }

    for (const e of events) {
      const days = (new Date(e.eventAt).getTime() - Date.now()) / 86_400_000;
      const flag = e.kind === "earnings" && days <= 2 ? "  <-- inside the 48h veto" : "";
      console.log(
        `   [${e.kind}] ${e.eventAt.slice(0, 16).replace("T", " ")}Z ` +
          `(${days.toFixed(1)}d) ${e.note ?? ""}${flag}`,
      );
      anythingToSay = true;
    }

    for (const a of primary) {
      console.log(
        `   * ${fmtAge(a.publishedAt).padStart(7)}  ${a.publisher} — ${a.title}` +
          (a.sentiment ? `  [${a.sentiment}]` : ""),
      );
      if (a.reasoning) console.log(`       ${a.reasoning.slice(0, 150)}`);
      anythingToSay = true;
    }

    if (mentions.length) {
      console.log(
        `   ${mentions.length} article(s) mention ${p.symbol} alongside ` +
          `${[...new Set(mentions.flatMap((m) => m.tickers).filter((t) => t !== p.symbol))]
            .slice(0, 5)
            .join(", ")}`,
      );
      anythingToSay = true;
    }

    if (quiet) {
      /**
       * "Nothing in the window" and "this feed barely covers the name" look
       * identical from here, and only one of them means the tape is quiet.
       * Ask how old the newest article is at any age, and say which it was.
       */
      let coverage = "";
      try {
        await throttle.take();
        const newest = await newestArticleAt(p.symbol, key);
        if (!newest) coverage = " — this feed carries no articles for it at all";
        else {
          const days = (Date.now() - newest.getTime()) / 86_400_000;
          coverage =
            days > 14
              ? ` — but the newest article this feed has is ${days.toFixed(0)}d old, ` +
                `so that is thin coverage, not a quiet tape`
              : ` (feed is current for this name: newest article ${days.toFixed(0)}d old)`;
        }
      } catch {
        coverage = " — coverage check failed, so treat this as unknown";
      }
      console.log(
        `   nothing published in ${hours}h, nothing scheduled in ${EVENT_HORIZON_DAYS}d${coverage}`,
      );
    }
    console.log("");
  }

  if (!anythingToSay) {
    console.log(
      `Quiet across the book. That is a valid and common answer — it is not a\n` +
        `reason to find something to say.`,
    );
  }
  console.log(`state: ${APP_URL}/api/state`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
