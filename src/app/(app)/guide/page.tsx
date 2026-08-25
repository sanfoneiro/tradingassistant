import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { rules } from "@/db/schema";
import { Panel, Badge } from "@/components/ui";
import { TRIGGER_BAND_PCT, WATCH_BAND_PCT } from "@/lib/funnel";
import { WORTH_OPENING_A_CHART } from "@/lib/rank";
import { DIVIDEND_FLAG_PCT } from "@/lib/metrics";
import { safe, dbConfigured } from "@/lib/safe";

export const dynamic = "force-dynamic";

/**
 * How the system works, for the person using it.
 *
 * CLAUDE.md explains this repo to whoever is building it. This page explains
 * the same machine to whoever is trading with it, which is a different
 * question — it answers "what do I do when an alert fires", not "where does
 * the zone engine live".
 *
 * The thresholds are imported rather than typed out. A number written twice
 * is a number that will disagree with itself, and a guide that quietly
 * contradicts the code is worse than no guide.
 */

function Step({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-panel2 font-mono text-[11px] text-acc">
        {n}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{title}</div>
        <div className="mt-1 text-sm leading-relaxed text-dim">{children}</div>
      </div>
    </li>
  );
}

function Row({ k, v }: { k: React.ReactNode; v: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line/60 py-2 last:border-0">
      <div className="w-40 shrink-0 font-mono text-xs text-faint">{k}</div>
      <div className="min-w-0 flex-1 text-sm text-dim">{v}</div>
    </div>
  );
}

export default async function GuidePage() {
  const active = dbConfigured()
    ? ((await safe(() =>
        db.select().from(rules).where(eq(rules.active, true)),
      )) ?? [])
    : [];

  const gates = active.filter((r) => r.type === "gate");
  const vetoes = active.filter((r) => r.type === "veto");

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-line bg-panel2 px-4 py-3 text-xs leading-relaxed text-dim">
        <b className="text-ink">This system reads and reasons. It never places,
        modifies or closes an order.</b>{" "}
        The most it produces is a ticket you copy. Every number it stores has a
        source, a timestamp, and a way to check it — anything that cannot reach
        a trusted mark is stored as <code className="text-acc">NULL</code> and
        says so, because a missing number gets greyed out while a plausible
        wrong one gets traded.
      </div>

      {/* ---------------- the funnel ---------------- */}
      <Panel title="The four stages — they are not interchangeable">
        <div className="mb-4 grid gap-2 sm:grid-cols-4">
          {[
            { k: "Zone", d: "a fact about the chart", t: "neutral" as const },
            { k: "Wishlist", d: "a level worth waiting for", t: "acc" as const },
            { k: "Idea", d: "price has arrived", t: "purple" as const },
            { k: "Trade", d: "taken", t: "up" as const },
          ].map((s, i) => (
            <div
              key={s.k}
              className="rounded-lg border border-line bg-panel2 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-faint">{i + 1}</span>
                <Badge tone={s.t}>{s.k}</Badge>
              </div>
              <div className="mt-1.5 text-xs text-dim">{s.d}</div>
            </div>
          ))}
        </div>

        <div className="space-y-1">
          <Row
            k="zone → wishlist"
            v={
              <>
                A name enters the <Link href="/watchlist" className="text-acc hover:underline">Watchlist</Link>{" "}
                when price is within{" "}
                <b className="text-ink">{WATCH_BAND_PCT}%</b> of a level. Wide
                enough to be worth watching, not close enough to grade.
              </>
            }
          />
          <Row
            k="wishlist → idea"
            v={
              <>
                Inside{" "}
                <b className="text-ink">{TRIGGER_BAND_PCT}%</b> the numbers mean
                something, so entry, stop, target and R:R become real and it
                appears in <Link href="/ideas" className="text-acc hover:underline">Ideas</Link>.
                Further out they are a hypothesis, and the server{" "}
                <b className="text-ink">rejects</b> them rather than filing a
                guess under &ldquo;actionable&rdquo;.
              </>
            }
          />
          <Row
            k="what gets graded"
            v={
              <>
                Roughly fifty names sit inside the band on a normal day, so a
                structural score decides which charts are worth opening. Only{" "}
                <b className="text-ink">{WORTH_OPENING_A_CHART}+</b> is looked
                at. That score orders the queue — it does{" "}
                <b className="text-ink">not</b> grade the trade.
              </>
            }
          />
        </div>
      </Panel>

      {/* ---------------- daily workflow ---------------- */}
      <Panel title="What you actually do">
        <ol className="space-y-4">
          <Step n="1" title="Set an alert slightly before the entry, not at it">
            If it fires exactly at your entry you are already at the decision
            with no time to look. A little early means you arrive before price
            does.
          </Step>
          <Step n="2" title="When it fires, open Ideas — do not open the broker">
            The alert means <b className="text-ink">go look</b>, never{" "}
            <b className="text-ink">go buy</b>. It cannot tell you whether price
            drifted in quietly or was dumped there on news, and that difference
            decides the trade.
          </Step>
          <Step n="3" title="Check the idea is still alive">
            Every idea carries an expiry. If it has lapsed, it needs re-grading
            rather than acting on — the levels were computed against a price
            that has moved.
          </Step>
          <Step n="4" title="Check you are not paying too much">
            R:R is measured from the planned entry. Chasing a few percent past
            it can drop the trade under 2:1 before it starts. If price has run,
            let it go — waiting for a level that never comes back costs nothing.
          </Step>
          <Step n="5" title="Place it yourself, then journal it">
            The system produces the ticket. You execute. When it closes, the six
            review fields are yours to write — nothing else can, and the{" "}
            <Link href="/reports" className="text-acc hover:underline">Reports</Link>{" "}
            page stays blocked until they are in. That is deliberate.
          </Step>
        </ol>
      </Panel>

      {/* ---------------- reading an idea ---------------- */}
      <Panel title="Reading an idea">
        <div className="space-y-1">
          <Row
            k="grade"
            v={
              <>
                <Badge tone="up">A+</Badge> zone and catalyst agree ·{" "}
                <Badge tone="acc">A−</Badge> strong, with a caveat ·{" "}
                <Badge tone="neutral">B</Badge> clean zone, no catalyst either
                way — half size, and a time stop ·{" "}
                <Badge tone="down">C</Badge> the catalyst opposes the zone.
              </>
            }
          />
          <Row
            k="catalyst"
            v={
              <>
                The decisive question is what drove price{" "}
                <b className="text-ink">into</b> the zone.{" "}
                <code className="text-acc">drifted_in</code> is unopposed and is
                the high-probability case.{" "}
                <code className="text-acc">opposes</code> means motivated new
                money is working through the level — do not fade it.{" "}
                <code className="text-acc">stale</code> means the news has
                stopped driving the tape.
              </>
            }
          />
          <Row
            k="blocked"
            v={
              <>
                A red gate name means a rule failed. It is stored rather than
                hidden so the same name is not re-graded tomorrow — and so the
                reason survives.{" "}
                <b className="text-ink">
                  A blocked idea is never actionable, however good the R:R
                  looks.
                </b>
              </>
            }
          />
          <Row
            k="R:R"
            v={
              <>
                Reward divided by risk at the first target. It is{" "}
                <b className="text-ink">not</b> a probability: a 6:1 setup that
                works one time in six loses money. Commission is $2 an order, so
                a round trip is $4 — on small size that is a real slice of a 1%
                risk budget, and the ratio is worse than the headline.
              </>
            }
          />
          <Row
            k="size"
            v={
              <>
                Risk is 1% of the sizing base. When the stop is tight that
                demands a large position for a small risk — exposure and risk
                are different things, and the concentration is the part to
                sanity-check.
              </>
            }
          />
        </div>
      </Panel>

      {/* ---------------- what runs ---------------- */}
      <Panel title="What runs on its own, and what needs you">
        <div className="space-y-1">
          <Row
            k="Zone sweep"
            v={
              <>
                <Badge tone="up">automatic</Badge> Twice each weekday in the
                cloud. Recomputes every level from price history, retires broken
                zones, refreshes distances. Needs nothing from you — not even
                this computer.
              </>
            }
          />
          <Row
            k="Grader"
            v={
              <>
                <Badge tone="up">automatic</Badge> Weekdays after the sweep, on
                this computer. Grades the top of the ranked queue and writes the
                verdicts to Ideas.
              </>
            }
          />
          <Row
            k="Universe refresh"
            v={
              <>
                <Badge tone="up">automatic</Badge> Sundays. Reads the saved
                TradingView screen so the sweep knows which names exist.
              </>
            }
          />
          <Row
            k="Morning sync"
            v={
              <>
                <Badge tone="warn">manual</Badge> Colmex has no API, so you
                paste screenshots and it reads them. Deliberately unscheduled —
                a timer cannot produce a screenshot, and a flat book needs no
                sync. This is why marks may be old.
              </>
            }
          />
          <Row
            k="Journalling"
            v={
              <>
                <Badge tone="warn">manual</Badge> What worked, what failed, and
                the lesson. Nothing can write these but you, and every
                measurement of whether the method works is built on them.
              </>
            }
          />
        </div>
      </Panel>

      {/* ---------------- rules, live from the table ---------------- */}
      <Panel
        title="The rules being enforced"
        right={
          <Link href="/rules" className="text-xs text-acc hover:underline">
            full text →
          </Link>
        }
      >
        {active.length === 0 ? (
          <p className="text-sm text-faint">
            No rules loaded — the database is not reachable.
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm text-dim">
              <b className="text-ink">Gates</b> must pass before entry.{" "}
              <b className="text-ink">Vetoes</b> kill a trade regardless of how
              good it looks. Both are checked by the grader on every candidate,
              not remembered.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {gates.map((r) => (
                <Badge key={r.id} tone="acc" title={r.text}>
                  {r.key}
                </Badge>
              ))}
              {vetoes.map((r) => (
                <Badge key={r.id} tone="down" title={r.text}>
                  {r.key}
                </Badge>
              ))}
            </div>
            <p className="mt-3 text-xs text-faint">
              Hover any name for the rule in full. A dividend crossing more than{" "}
              {Math.round(DIVIDEND_FLAG_PCT * 100)}% of the stop distance is
              flagged: a short pays it, and a long is walked toward its stop by
              it.
            </p>
          </>
        )}
      </Panel>

      {/* ---------------- honest limits ---------------- */}
      <Panel title="What this system cannot do">
        <ul className="space-y-2.5 text-sm text-dim">
          <li>
            <b className="text-ink">It cannot tell you a trade will work.</b>{" "}
            Every weight in the ranking is a hypothesis. The Reports page exists
            to prove them wrong, and it needs closed, journalled trades to do it.
          </li>
          <li>
            <b className="text-ink">It does not know your book unless you sync.</b>{" "}
            With stale marks it will size a new position against a portfolio it
            cannot see. Check the timestamp on{" "}
            <Link href="/" className="text-acc hover:underline">Account</Link>{" "}
            before acting on anything.
          </li>
          <li>
            <b className="text-ink">
              It cannot see how far a trade went in your favour.
            </b>{" "}
            The broker screen does not show the day&rsquo;s high and low, so
            MAE/MFE is not captured while a position is open, and it cannot be
            recovered afterwards.
          </li>
          <li>
            <b className="text-ink">It has no opinion on fundamentals.</b>{" "}
            Fundamentals are a veto, never a confirmation — the grader hunts for
            the reason a trade fails, not for news that justifies one you
            already want.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
