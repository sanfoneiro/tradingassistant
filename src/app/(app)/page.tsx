import Link from "next/link";
import { desc, eq, and } from "drizzle-orm";
import { db } from "@/db";
import { accounts, positions, actionItems, runs, trades } from "@/db/schema";
import { Panel, Stat, Mark, Badge, Empty, RiskBar } from "@/components/ui";
import { usd, pct, ageLabel, freshness, SOURCE_LABEL } from "@/lib/format";
import { freeStopMove } from "@/lib/metrics";
import { safe, dbConfigured } from "@/lib/safe";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  if (!dbConfigured()) return <SetupNotice />;

  const account = await safe(async () =>
    (await db.select().from(accounts).orderBy(desc(accounts.updatedAt)).limit(1))[0],
  );
  const open = (await safe(() =>
    db.select().from(positions).where(eq(positions.isOpen, true)),
  )) ?? [];
  const items = (await safe(() =>
    db
      .select()
      .from(actionItems)
      .where(eq(actionItems.status, "open"))
      .orderBy(desc(actionItems.timesRepeated)),
  )) ?? [];
  const lastRun = await safe(async () =>
    (await db.select().from(runs).orderBy(desc(runs.startedAt)).limit(1))[0],
  );
  const toReview = (await safe(() =>
    db.select().from(trades).where(eq(trades.status, "pending_review")),
  )) ?? [];

  if (account === null && open.length === 0) return <SetupNotice noData />;

  const base = account?.sizingBase ?? account?.balance ?? null;
  const totalPl = open.reduce((a, p) => a + (p.pl ?? 0), 0);
  const delayTotal = items.reduce((a, i) => a + (i.costOfDelayUsd ?? 0), 0);

  // Risk from here — what equity drops by if every stop fills today. This
  // leads the page because it is the number a decision hangs on. Entry-based
  // risk stays available for R-multiple maths but it misranks an aged book:
  // a position deep underwater with a nearby stop looks enormous and has
  // almost nothing left to lose.
  const totalRisk = open.reduce((a, p) => a + (p.riskFromMark ?? 0), 0);
  const riskSegments = open
    .filter((p) => (p.riskFromMark ?? 0) > 0)
    .map((p) => ({ label: p.symbol, value: p.riskFromMark! }))
    .sort((a, b) => b.value - a.value);

  const noStop = open.filter((p) => p.stop == null);

  // Free stop moves: in profit, stop still on the losing side of entry.
  const freeMoves = open
    .map((p) => {
      const m = freeStopMove({
        side: p.side,
        entry: p.entry,
        stop: p.stop,
        mark: p.mark,
        qty: p.qty,
      });
      return m ? { p, ...m } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.removes - a.removes);
  const freeTotal = freeMoves.reduce((a, m) => a + m.removes, 0);

  return (
    <div className="space-y-5">
      {/* Journalling blocker — structural, not a discipline problem. */}
      {toReview.length > 0 && (
        <div className="rounded-xl border border-warn/40 bg-warn/5 px-4 py-3">
          <div className="text-sm">
            <b className="text-warn">
              {toReview.length} trade{toReview.length > 1 ? "s" : ""} closed and
              not yet reviewed.
            </b>{" "}
            <span className="text-dim">
              The book stays blocked until {toReview.length > 1 ? "they are" : "it is"}{" "}
              journalled — that is the point.
            </span>{" "}
            <Link href="/journal" className="text-acc underline">
              Review now →
            </Link>
          </div>
        </div>
      )}

      {lastRun?.degraded && (
        <div className="rounded-xl border border-down/40 bg-down/5 px-4 py-3 text-sm">
          <b className="text-down">Last sync ran degraded</b>{" "}
          <span className="text-dim">
            ({lastRun.agent}, {ageLabel(lastRun.startedAt)}) — the agent could not
            reach a trusted source, so nothing was overwritten.{" "}
            {lastRun.notes ?? ""}
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat
          label="Balance"
          value={usd(account?.balance)}
          sub={
            account?.updatedAt
              ? `${SOURCE_LABEL[account.source ?? ""] ?? "unknown"} · ${ageLabel(account.updatedAt)}`
              : "never synced"
          }
          tone={freshness(account?.updatedAt) === "fresh" ? "neutral" : "warn"}
        />
        <Stat
          label="Open P/L"
          value={usd(totalPl)}
          tone={totalPl >= 0 ? "up" : "down"}
          sub={`${open.length} position${open.length === 1 ? "" : "s"} · net of fees`}
        />
        <Stat
          label="Risk from here"
          value={usd(totalRisk)}
          tone={
            base && totalRisk / base > 0.05
              ? "down"
              : base && totalRisk / base > 0.03
                ? "warn"
                : "neutral"
          }
          sub={base ? `${((totalRisk / base) * 100).toFixed(2)}% of base` : undefined}
        />
        <Stat
          label="Free stop moves"
          value={usd(freeTotal)}
          tone={freeTotal > 0 ? "warn" : "neutral"}
          sub={
            freeMoves.length
              ? `${freeMoves.length} available, cost nothing`
              : "none available"
          }
        />
        <Stat
          label="Cost of delay"
          value={usd(delayTotal)}
          tone={delayTotal < 0 ? "down" : "neutral"}
          sub="on open action items"
        />
      </div>

      {noStop.length > 0 && (
        <div className="rounded-xl border border-down/40 bg-down/5 px-4 py-3 text-sm">
          <b className="text-down">
            {noStop.map((p) => p.symbol).join(", ")} ha
            {noStop.length === 1 ? "s" : "ve"} no stop.
          </b>{" "}
          <span className="text-dim">
            Not counted above — unstopped risk is unbounded, not zero.
          </span>
        </div>
      )}

      {freeMoves.length > 0 && (
        <Panel
          title="Free stop moves"
          right={
            <span className="tnum text-xs text-warn">
              {usd(freeTotal)} removable
            </span>
          }
        >
          <ul className="space-y-2">
            {freeMoves.map(({ p, to, removes }) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded-lg border border-line bg-panel2 px-3 py-2 text-sm"
              >
                <span>
                  <b>{p.symbol}</b>{" "}
                  <span className="text-dim">
                    {p.side === "long" ? "raise" : "lower"} stop{" "}
                    <span className="tnum">${p.stop?.toFixed(2)}</span> →{" "}
                    <span className="tnum text-ink">${to.toFixed(2)}</span>
                  </span>
                </span>
                <span className="tnum text-warn">−{usd(removes)} risk</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-faint">
            Each position is in profit with its stop still on the losing side of
            entry. Moving to breakeven removes the possible loss; the open
            profit above the new stop is still given back if it fills.
          </p>
        </Panel>
      )}

      {riskSegments.length > 0 && (
        <Panel
          title="Where the risk actually is"
          right={
            <span className="tnum text-xs text-faint">
              {usd(totalRisk)} from here
            </span>
          }
        >
          <RiskBar segments={riskSegments} total={totalRisk} />
          {riskSegments[0] && totalRisk > 0 && (
            <p className="mt-3 text-xs text-dim">
              {riskSegments[0].label} carries{" "}
              <b className="text-ink">
                {((riskSegments[0].value / totalRisk) * 100).toFixed(0)}%
              </b>{" "}
              of what can still be lost today — measured from the current mark,
              not from entry.
            </p>
          )}
        </Panel>
      )}

      <Panel title="Positions">
        {open.length === 0 ? (
          <Empty>No open positions synced yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] tracking-wider text-faint uppercase">
                  <th className="px-2 py-2 text-left">Symbol</th>
                  <th className="px-2 py-2 text-left">Side</th>
                  <th className="px-2 py-2 text-right">Qty</th>
                  <th className="px-2 py-2 text-right">Entry</th>
                  <th className="px-2 py-2 text-right">Mark</th>
                  <th className="px-2 py-2 text-right">Stop</th>
                  <th className="px-2 py-2 text-right">P/L</th>
                  <th className="px-2 py-2 text-right" title="What is lost if the stop fills today, from the current mark">
                    Risk now
                  </th>
                  <th className="px-2 py-2 text-right" title="Capital lost if the stop fills, from entry. Zero when the stop is past breakeven.">
                    At risk
                  </th>
                  <th className="px-2 py-2 text-right">% of risk</th>
                </tr>
              </thead>
              <tbody>
                {open.map((p) => (
                  <tr key={p.id} className="border-b border-line/60">
                    <td className="px-2 py-2 font-semibold">{p.symbol}</td>
                    <td className="px-2 py-2">
                      <Badge tone={p.side === "long" ? "up" : "down"}>
                        {p.side}
                      </Badge>
                    </td>
                    <td className="tnum px-2 py-2 text-right text-dim">{p.qty}</td>
                    <td className="tnum px-2 py-2 text-right text-dim">
                      ${p.entry.toFixed(2)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Mark value={p.mark} source={p.markSource} at={p.markAt} />
                    </td>
                    <td className="tnum px-2 py-2 text-right text-dim">
                      {p.stop != null ? `$${p.stop.toFixed(2)}` : "—"}
                    </td>
                    <td
                      className={`tnum px-2 py-2 text-right ${(p.pl ?? 0) >= 0 ? "text-up" : "text-down"}`}
                    >
                      {usd(p.pl)}
                      <span className="ml-1 text-[11px] text-faint">
                        {p.plPct != null ? pct(p.plPct) : ""}
                      </span>
                    </td>
                    <td className="tnum px-2 py-2 text-right text-dim">
                      {p.stop == null ? (
                        <span className="text-down">no stop</span>
                      ) : (
                        usd(p.riskFromMark)
                      )}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {(p.lockedGain ?? 0) > 0 ? (
                        <Badge
                          tone="up"
                          title="The stop is past breakeven — this position cannot lose money."
                        >
                          locked +{usd(p.lockedGain).replace("$", "$")}
                        </Badge>
                      ) : (
                        <span className="tnum text-dim">{usd(p.riskUsd)}</span>
                      )}
                    </td>
                    <td className="tnum px-2 py-2 text-right text-faint">
                      {totalRisk > 0 && p.riskFromMark
                        ? `${((p.riskFromMark / totalRisk) * 100).toFixed(0)}%`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Action items"
        right={
          delayTotal !== 0 ? (
            <span className="text-xs text-dim">
              cost of not acting:{" "}
              <b className={delayTotal < 0 ? "text-down" : "text-up"}>
                {usd(delayTotal)}
              </b>
            </span>
          ) : null
        }
      >
        {items.length === 0 ? (
          <Empty>Nothing outstanding.</Empty>
        ) : (
          <ul className="space-y-2">
            {items.map((i) => (
              <li
                key={i.id}
                className="flex items-start gap-3 rounded-lg border border-line bg-panel2 px-3 py-2.5"
              >
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {i.symbol && (
                      <span className="font-semibold">{i.symbol}</span>
                    )}
                    <Badge
                      tone={
                        i.timesRepeated >= 5
                          ? "down"
                          : i.timesRepeated >= 3
                            ? "warn"
                            : "neutral"
                      }
                      title="How many briefs have raised this"
                    >
                      ×{i.timesRepeated}
                    </Badge>
                    <span className="text-xs text-faint">
                      first raised {ageLabel(i.firstRaisedAt)}
                    </span>
                  </div>
                  <div className="mt-1 text-sm">{i.text}</div>
                  {i.rationale && (
                    <div className="mt-0.5 text-xs text-faint">{i.rationale}</div>
                  )}
                </div>
                {i.costOfDelayUsd != null && i.costOfDelayUsd !== 0 && (
                  <div className="text-right">
                    <div className="text-[10px] tracking-wider text-faint uppercase">
                      delay cost
                    </div>
                    <div
                      className={`tnum text-sm ${i.costOfDelayUsd < 0 ? "text-down" : "text-up"}`}
                    >
                      {usd(i.costOfDelayUsd)}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="text-center text-xs text-faint">
        This system reads and reasons. It never places, modifies, or closes an
        order.
      </p>
    </div>
  );
}

function SetupNotice({ noData }: { noData?: boolean } = {}) {
  return (
    <div className="mx-auto max-w-xl space-y-4 py-12 text-center">
      <h1 className="text-xl font-semibold">
        {noData ? "No data yet" : "Database not connected"}
      </h1>
      <p className="text-sm text-dim">
        {noData ? (
          <>
            Schema is live but nothing has been synced. Run the Morning Sync
            agent, or POST an <code className="text-acc">account_sync</code>{" "}
            payload to <code className="text-acc">/api/ingest</code>.
          </>
        ) : (
          <>
            Attach Neon from the Vercel dashboard (Storage → Neon), which sets{" "}
            <code className="text-acc">DATABASE_URL</code> automatically, then
            run <code className="text-acc">npm run db:push</code> and{" "}
            <code className="text-acc">npm run db:seed</code>.
          </>
        )}
      </p>
      <p className="text-xs text-faint">
        Deliberately blank rather than showing zeros — a confident wrong number
        is the thing this app exists to prevent.
      </p>
    </div>
  );
}
