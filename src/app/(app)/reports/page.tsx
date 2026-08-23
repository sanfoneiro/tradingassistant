import { eq, inArray, asc } from "drizzle-orm";
import { db } from "@/db";
import { trades, tags, tradeTags } from "@/db/schema";
import { Panel, Empty, Badge } from "@/components/ui";
import { usd, QUADRANT_LABEL, GRADE_LABEL } from "@/lib/format";
import { stats, MIN_SAMPLE } from "@/lib/metrics";
import { safe, dbConfigured } from "@/lib/safe";

export const dynamic = "force-dynamic";

type Row = { plUsd: number | null; rMultiple: number | null };

export default async function ReportsPage() {
  if (!dbConfigured())
    return <p className="py-12 text-center text-sm text-dim">Database not connected.</p>;

  // Chronological, because max drawdown walks the cumulative curve in the
  // order given — an unordered read makes that number arbitrary.
  const closed =
    (await safe(() =>
      db
        .select()
        .from(trades)
        .where(eq(trades.status, "closed"))
        .orderBy(asc(trades.closedAt)),
    )) ?? [];
  const mistakeTags = (await safe(() => db.select().from(tags))) ?? [];
  const links = (await safe(() => db.select().from(tradeTags))) ?? [];

  const overall = stats(closed);

  const byQuadrant = groupBy(closed, (t) =>
    t.quadrant ? QUADRANT_LABEL[t.quadrant] : "untagged",
  );
  const byGrade = groupBy(closed, (t) =>
    t.grade ? GRADE_LABEL[t.grade] : "untagged",
  );
  const byCatalyst = groupBy(closed, (t) => t.catalystState ?? "untagged");
  const byMechanic = groupBy(closed, (t) => t.entryMechanic ?? "untagged");

  // Mistake ledger — cost per tag. The report that changes behaviour.
  const tagById = new Map(mistakeTags.map((t) => [t.id, t]));
  const tradeById = new Map(closed.map((t) => [t.id, t]));
  const mistakeBuckets = new Map<string, Row[]>();
  for (const l of links) {
    const t = tradeById.get(l.tradeId);
    const tag = tagById.get(l.tagId);
    if (!t || !tag) continue;
    const arr = mistakeBuckets.get(tag.label) ?? [];
    arr.push(t);
    mistakeBuckets.set(tag.label, arr);
  }
  const mistakeRows = [...mistakeBuckets.entries()]
    .map(([label, rows]) => ({ label, ...stats(rows) }))
    .sort((a, b) => a.netPl - b.netPl);

  if (closed.length === 0) {
    return (
      <Panel title="Reports">
        <Empty>
          No closed and reviewed trades yet. Every report on this page needs
          history — it accumulates from the first review onward.
        </Empty>
      </Panel>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-line bg-panel2 px-4 py-3 text-xs text-dim">
        <b className="text-ink">{overall.n} closed trades.</b> Anything under{" "}
        {MIN_SAMPLE} in a bucket is greyed out — a 100% win rate on two trades
        is noise, and reading it as signal is expensive.
      </div>

      <Panel title="Method report — does the framework hold up">
        <p className="mb-4 text-xs text-faint">
          This is the page nothing off-the-shelf can produce, because nothing
          else knows the quadrant model. It is also where the skill gets
          rewritten: if the strong quadrants are not out-earning the weak ones,
          that claim was a hypothesis, not a fact.
        </p>
        <Breakdown title="By quadrant" rows={byQuadrant} />
        <Breakdown title="By grade" rows={byGrade} />
        <Breakdown title="By catalyst state" rows={byCatalyst} />
        <Breakdown title="By entry mechanic" rows={byMechanic} />
      </Panel>

      <Panel title="Mistake ledger — what each habit has cost">
        {mistakeRows.length === 0 ? (
          <Empty>No mistakes tagged yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] tracking-wider text-faint uppercase">
                <th className="px-2 py-2 text-left">Mistake</th>
                <th className="px-2 py-2 text-right">Trades</th>
                <th className="px-2 py-2 text-right">Net P/L</th>
                <th className="px-2 py-2 text-right">Avg R</th>
                <th className="px-2 py-2 text-right">Win %</th>
              </tr>
            </thead>
            <tbody>
              {mistakeRows.map((r) => (
                <tr key={r.label} className="border-b border-line/60">
                  <td className="px-2 py-2">{r.label}</td>
                  <td className="tnum px-2 py-2 text-right text-dim">{r.n}</td>
                  <td
                    className={`tnum px-2 py-2 text-right ${r.n < MIN_SAMPLE ? "text-faint" : r.netPl < 0 ? "text-down" : "text-up"}`}
                  >
                    {usd(r.netPl)}
                  </td>
                  <td
                    className={`tnum px-2 py-2 text-right ${r.n < MIN_SAMPLE ? "text-faint" : "text-dim"}`}
                  >
                    {r.avgR != null ? `${r.avgR.toFixed(2)}R` : "—"}
                  </td>
                  <td
                    className={`tnum px-2 py-2 text-right ${r.n < MIN_SAMPLE ? "text-faint" : "text-dim"}`}
                  >
                    {r.winRate != null ? `${r.winRate.toFixed(0)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function groupBy<T extends Row>(
  rows: T[],
  key: (t: T) => string,
): { label: string; s: ReturnType<typeof stats> }[] {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.entries()]
    .map(([label, rs]) => ({ label, s: stats(rs) }))
    .sort((a, b) => b.s.netPl - a.s.netPl);
}

function Breakdown({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; s: ReturnType<typeof stats> }[];
}) {
  return (
    <div className="mb-6 last:mb-0">
      <h3 className="mb-2 text-xs font-semibold tracking-wider text-dim uppercase">
        {title}
      </h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] tracking-wider text-faint uppercase">
            <th className="px-2 py-1.5 text-left">Bucket</th>
            <th className="px-2 py-1.5 text-right">n</th>
            <th className="px-2 py-1.5 text-right">Net P/L</th>
            <th className="px-2 py-1.5 text-right">Avg R</th>
            <th className="px-2 py-1.5 text-right">Win %</th>
            <th className="px-2 py-1.5 text-right">PF</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const thin = r.s.n < MIN_SAMPLE;
            return (
              <tr key={r.label} className="border-b border-line/60">
                <td className="px-2 py-1.5">
                  {r.label}
                  {thin && (
                    <span className="ml-2">
                      <Badge>thin</Badge>
                    </span>
                  )}
                </td>
                <td className="tnum px-2 py-1.5 text-right text-dim">{r.s.n}</td>
                <td
                  className={`tnum px-2 py-1.5 text-right ${thin ? "text-faint" : r.s.netPl >= 0 ? "text-up" : "text-down"}`}
                >
                  {usd(r.s.netPl)}
                </td>
                <td
                  className={`tnum px-2 py-1.5 text-right ${thin ? "text-faint" : "text-dim"}`}
                >
                  {r.s.avgR != null ? `${r.s.avgR.toFixed(2)}R` : "—"}
                </td>
                <td
                  className={`tnum px-2 py-1.5 text-right ${thin ? "text-faint" : "text-dim"}`}
                >
                  {r.s.winRate != null ? `${r.s.winRate.toFixed(0)}%` : "—"}
                </td>
                <td
                  className={`tnum px-2 py-1.5 text-right ${thin ? "text-faint" : "text-dim"}`}
                >
                  {r.s.profitFactor != null ? r.s.profitFactor.toFixed(2) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
