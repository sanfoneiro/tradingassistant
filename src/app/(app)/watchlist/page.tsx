import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { wishlist, zones, screenerCoverage } from "@/db/schema";
import { Panel, Badge, Empty, Stat } from "@/components/ui";
import { num, ageLabel } from "@/lib/format";
import { safe, dbConfigured } from "@/lib/safe";

export const dynamic = "force-dynamic";

const ZONE_TONE = {
  untested: "acc",
  tested_held: "up",
  tested_broken: "down",
  expired: "neutral",
} as const;

export default async function WatchlistPage() {
  if (!dbConfigured())
    return <p className="py-12 text-center text-sm text-dim">Database not connected.</p>;

  const watch =
    (await safe(() =>
      db.select().from(wishlist).where(eq(wishlist.active, true)),
    )) ?? [];
  const allZones =
    (await safe(() => db.select().from(zones).orderBy(desc(zones.drawnAt)))) ??
    [];
  const coverage =
    (await safe(() =>
      db.select().from(screenerCoverage).orderBy(screenerCoverage.analyzedAt),
    )) ?? [];

  const zoneById = new Map(allZones.map((z) => [z.id, z]));
  const live = allZones.filter((z) => z.status === "untested");
  const broken = allZones.filter((z) => z.status === "tested_broken");
  const held = allZones.filter((z) => z.status === "tested_held");

  // Closest to going live first — that is the only ordering that matters
  // on a watchlist.
  const sorted = [...watch].sort(
    (a, b) => Math.abs(a.distancePct ?? 999) - Math.abs(b.distancePct ?? 999),
  );

  const hitRate =
    held.length + broken.length > 0
      ? (held.length / (held.length + broken.length)) * 100
      : null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Watching" value={String(watch.length)} sub="active names" />
        <Stat label="Live zones" value={String(live.length)} sub="untested" />
        <Stat
          label="Zone hit rate"
          value={hitRate == null ? "—" : `${hitRate.toFixed(0)}%`}
          n={held.length + broken.length}
          sub={`${held.length} held / ${broken.length} broke`}
          tone={hitRate != null && hitRate >= 50 ? "up" : "down"}
        />
        <Stat
          label="Screened"
          value={String(coverage.length)}
          sub="symbols the app has seen"
        />
      </div>

      <Panel
        title="Watchlist"
        right={<span className="text-xs text-faint">closest to trigger first</span>}
      >
        {sorted.length === 0 ? (
          <Empty>
            Nothing being watched. The Screener adds names here when they are
            near a level but not yet tradeable.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] tracking-wider text-faint uppercase">
                  <th className="px-2 py-2 text-left">Symbol</th>
                  <th className="px-2 py-2 text-left">Side</th>
                  <th className="px-2 py-2 text-right">Trigger</th>
                  <th className="px-2 py-2 text-right">Away</th>
                  <th className="px-2 py-2 text-left">Zone</th>
                  <th className="px-2 py-2 text-left">What has to happen</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((w) => {
                  const z = zoneById.get(w.zoneId ?? -1);
                  const close = Math.abs(w.distancePct ?? 999) <= 1.5;
                  return (
                    <tr key={w.id} className="border-b border-line/60">
                      <td className="px-2 py-2 font-semibold">{w.symbol}</td>
                      <td className="px-2 py-2">
                        {w.side ? (
                          <Badge tone={w.side === "long" ? "up" : "down"}>
                            {w.side}
                          </Badge>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="tnum px-2 py-2 text-right text-dim">
                        {w.triggerLevel == null
                          ? "—"
                          : `$${w.triggerLevel.toFixed(2)}`}
                      </td>
                      <td
                        className={`tnum px-2 py-2 text-right ${close ? "text-warn" : "text-faint"}`}
                      >
                        {w.distancePct == null
                          ? "—"
                          : `${Math.abs(w.distancePct).toFixed(1)}%`}
                      </td>
                      <td className="px-2 py-2 text-xs text-dim">
                        {z
                          ? `${z.direction} ${z.low}–${z.high} (${z.timeframe})`
                          : "—"}
                      </td>
                      <td className="px-2 py-2 text-xs text-dim">
                        {w.triggerNote ?? w.thesis ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={`Zones — ${allZones.length}`}>
        {allZones.length === 0 ? (
          <Empty>No zones recorded yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] tracking-wider text-faint uppercase">
                  <th className="px-2 py-2 text-left">Symbol</th>
                  <th className="px-2 py-2 text-left">TF</th>
                  <th className="px-2 py-2 text-left">Type</th>
                  <th className="px-2 py-2 text-right" title="Proximal edge — where you enter">
                    Entry
                  </th>
                  <th className="px-2 py-2 text-right">50%</th>
                  <th className="px-2 py-2 text-right" title="Distal edge plus buffer — where the zone is wrong">
                    SL
                  </th>
                  <th className="px-2 py-2 text-right">Dist %</th>
                  <th className="px-2 py-2 text-left">State</th>
                  <th className="px-2 py-2 text-left">Status</th>
                  <th className="px-2 py-2 text-right">Seen</th>
                </tr>
              </thead>
              <tbody>
                {allZones.map((z) => (
                  <tr key={z.id} className="border-b border-line/60">
                    <td className="px-2 py-2 font-semibold">{z.symbol}</td>
                    <td className="px-2 py-2 text-xs text-dim">{z.timeframe}</td>
                    <td className="px-2 py-2">
                      <Badge tone={z.direction === "demand" ? "up" : "down"}>
                        {z.direction}
                      </Badge>
                    </td>
                    <td className="tnum px-2 py-2 text-right">
                      {z.entryLevel?.toFixed(2) ?? z.high.toFixed(2)}
                    </td>
                    <td className="tnum px-2 py-2 text-right text-faint">
                      {z.midLevel?.toFixed(2) ?? "—"}
                    </td>
                    <td className="tnum px-2 py-2 text-right text-dim">
                      {z.stopLevel?.toFixed(2) ?? z.low.toFixed(2)}
                    </td>
                    <td
                      className={`tnum px-2 py-2 text-right ${
                        z.distancePct != null && Math.abs(z.distancePct) <= 2
                          ? "text-warn"
                          : "text-faint"
                      }`}
                    >
                      {z.distancePct == null
                        ? "—"
                        : `${z.distancePct > 0 ? "+" : ""}${z.distancePct.toFixed(2)}%`}
                    </td>
                    <td className="px-2 py-2">
                      {z.indicatorState ? (
                        <Badge
                          tone={z.indicatorState === "Fresh" ? "acc" : "neutral"}
                          title="The indicator's own read. Mitigated means price has already been into it — not the same as broken."
                        >
                          {z.indicatorState}
                        </Badge>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <Badge tone={ZONE_TONE[z.status]}>
                        {z.status.replaceAll("_", " ")}
                      </Badge>
                    </td>
                    <td className="px-2 py-2 text-right text-xs text-faint">
                      {ageLabel(z.lastSeenAt ?? z.drawnAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Screener coverage"
        right={
          <span className="text-xs text-faint">
            never-analysed first, then longest unseen
          </span>
        }
      >
        {coverage.length === 0 ? (
          <Empty>
            No symbols screened yet. The Screener records every name it looks
            at, including the rejects, so runs rotate through the list instead
            of re-reading the top of it.
          </Empty>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {coverage.map((c) => (
              <span
                key={c.symbol}
                title={`${c.analyzedAt == null ? "never analysed" : c.trend ?? "trend unknown"} · ${
                  c.distancePct != null
                    ? `${Math.abs(c.distancePct).toFixed(1)}% from zone`
                    : "distance unknown"
                } · seen ${c.timesScreened}× · last ${ageLabel(c.lastScreenedAt)}`}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                  c.nearZone
                    ? "border-warn/40 bg-warn/5 text-warn"
                    : c.analyzedAt == null
                      ? "border-acc/30 text-acc/70"
                      : "border-line text-faint"
                }`}
              >
                {c.symbol}
              </span>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
