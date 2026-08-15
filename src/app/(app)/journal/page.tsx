import Link from "next/link";
import { desc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { trades, journal } from "@/db/schema";
import { Panel, Stat, Badge, Empty } from "@/components/ui";
import { usd, rr, QUADRANT_LABEL, GRADE_LABEL, ageLabel } from "@/lib/format";
import { stats } from "@/lib/metrics";
import { safe, dbConfigured } from "@/lib/safe";

export const dynamic = "force-dynamic";

export default async function JournalPage() {
  if (!dbConfigured())
    return <p className="py-12 text-center text-sm text-dim">Database not connected.</p>;

  const rows =
    (await safe(() => db.select().from(trades).orderBy(desc(trades.closedAt)))) ??
    [];
  const entries = (await safe(() => db.select().from(journal))) ?? [];
  const journalled = new Set(entries.map((e) => e.tradeId));

  const pending = rows.filter((t) => t.status === "pending_review");
  const closed = rows.filter((t) => t.status === "closed");
  const s = stats(closed);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Closed trades" value={String(s.n)} />
        <Stat
          label="Win rate"
          value={s.winRate != null ? `${s.winRate.toFixed(0)}%` : "—"}
          n={s.n}
        />
        <Stat
          label="Profit factor"
          value={s.profitFactor != null ? s.profitFactor.toFixed(2) : "—"}
          n={s.n}
          tone={s.profitFactor && s.profitFactor > 1.3 ? "up" : "neutral"}
        />
        <Stat
          label="Avg R"
          value={s.avgR != null ? `${s.avgR.toFixed(2)}R` : "—"}
          n={s.n}
          tone={s.avgR != null ? (s.avgR > 0 ? "up" : "down") : "neutral"}
        />
        <Stat
          label="Net P/L"
          value={usd(s.netPl)}
          n={s.n}
          tone={s.netPl >= 0 ? "up" : "down"}
        />
      </div>

      {pending.length > 0 && (
        <Panel title={`Awaiting review — ${pending.length}`}>
          <ul className="space-y-2">
            {pending.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/journal/${t.id}`}
                  className="flex items-center justify-between rounded-lg border border-warn/30 bg-warn/5 px-3 py-2.5 transition hover:border-warn/60"
                >
                  <span className="flex items-center gap-2">
                    <b>{t.symbol}</b>
                    <Badge tone={t.side === "long" ? "up" : "down"}>
                      {t.side}
                    </Badge>
                    <span className="text-xs text-faint">
                      closed {ageLabel(t.closedAt)}
                    </span>
                  </span>
                  <span className="text-sm text-warn">Six fields →</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Closed">
        {closed.length === 0 ? (
          <Empty>
            No reviewed trades yet. They appear here once the six fields are in.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] tracking-wider text-faint uppercase">
                  <th className="px-2 py-2 text-left">Symbol</th>
                  <th className="px-2 py-2 text-left">Grade</th>
                  <th className="px-2 py-2 text-left">Quadrant</th>
                  <th className="px-2 py-2 text-right">R</th>
                  <th className="px-2 py-2 text-right">P/L</th>
                  <th className="px-2 py-2 text-right">MFE</th>
                  <th className="px-2 py-2 text-left">Exit</th>
                  <th className="px-2 py-2 text-left">Closed</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((t) => (
                  <tr key={t.id} className="border-b border-line/60">
                    <td className="px-2 py-2">
                      <Link
                        href={`/journal/${t.id}`}
                        className="font-semibold hover:text-acc"
                      >
                        {t.symbol}
                      </Link>
                      {!journalled.has(t.id) && (
                        <span className="ml-2 text-[10px] text-warn">
                          no entry
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {t.grade ? (
                        <Badge
                          tone={
                            t.grade === "A_plus" || t.grade === "A_minus"
                              ? "up"
                              : t.grade === "B"
                                ? "warn"
                                : "down"
                          }
                        >
                          {GRADE_LABEL[t.grade]}
                        </Badge>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-xs text-dim">
                      {t.quadrant ? QUADRANT_LABEL[t.quadrant] : "—"}
                    </td>
                    <td
                      className={`tnum px-2 py-2 text-right ${(t.rMultiple ?? 0) >= 0 ? "text-up" : "text-down"}`}
                    >
                      {rr(t.rMultiple)}
                    </td>
                    <td
                      className={`tnum px-2 py-2 text-right ${(t.plUsd ?? 0) >= 0 ? "text-up" : "text-down"}`}
                    >
                      {usd(t.plUsd)}
                    </td>
                    <td
                      className="tnum px-2 py-2 text-right text-faint"
                      title="What the market actually offered, in R"
                    >
                      {rr(t.mfeR)}
                    </td>
                    <td className="px-2 py-2 text-xs text-dim">
                      {t.exitReason ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-xs text-faint">
                      {t.closedAt ? new Date(t.closedAt).toISOString().slice(0, 10) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
