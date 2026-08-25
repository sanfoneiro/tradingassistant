import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { suggestions, zones, rules } from "@/db/schema";
import { Panel, Badge, Empty } from "@/components/ui";
import { usd, num, QUADRANT_LABEL, GRADE_LABEL, ageLabel } from "@/lib/format";
import { safe, dbConfigured } from "@/lib/safe";

export const dynamic = "force-dynamic";

const GRADE_TONE = {
  A_plus: "up",
  A_minus: "up",
  B: "warn",
  C: "down",
} as const;

export default async function IdeasPage() {
  if (!dbConfigured())
    return <p className="py-12 text-center text-sm text-dim">Database not connected.</p>;

  const rows =
    (await safe(() =>
      db.select().from(suggestions).orderBy(desc(suggestions.createdAt)),
    )) ?? [];
  const allZones = (await safe(() => db.select().from(zones))) ?? [];
  const allRules = (await safe(() => db.select().from(rules))) ?? [];

  const zoneById = new Map(allZones.map((z) => [z.id, z]));
  const ruleByKey = new Map(allRules.map((r) => [r.key, r]));

  // An idea past its expiry is lapsed, not open — the status column is only
  // updated when something happens TO it, and time passing is not an event.
  const now = Date.now();
  const isLive = (s: (typeof rows)[number]) =>
    s.status === "open" && (!s.expiresAt || s.expiresAt.getTime() > now);

  const open = rows.filter(isLive);
  const actionable = open.filter((s) => (s.gatesFailed?.length ?? 0) === 0);
  const blocked = open.filter((s) => (s.gatesFailed?.length ?? 0) > 0);
  const dead = rows.filter((s) => !isLive(s));

  return (
    <div className="space-y-5">
      <Panel
        title={`Actionable — ${actionable.length}`}
        right={
          <span className="text-xs text-faint">
            every gate passed, every veto cleared
          </span>
        }
      >
        {actionable.length === 0 ? (
          <Empty>
            Nothing passes all gates right now. That is a normal state, not a
            gap — most days the honest answer is no trade.
          </Empty>
        ) : (
          <div className="space-y-3">
            {actionable.map((s) => (
              <Card key={s.id} s={s} zone={zoneById.get(s.zoneId ?? -1)} />
            ))}
          </div>
        )}
      </Panel>

      {blocked.length > 0 && (
        <Panel
          title={`Blocked — ${blocked.length}`}
          right={
            <span className="text-xs text-faint">
              recorded, never actionable
            </span>
          }
        >
          <p className="mb-3 text-xs text-dim">
            These failed a gate. They are kept because blocked ideas are the
            only way to find out whether the gates are earning their keep — if
            the ones you skipped would have worked, the rule is wrong.
          </p>
          <div className="space-y-3">
            {blocked.map((s) => (
              <Card
                key={s.id}
                s={s}
                zone={zoneById.get(s.zoneId ?? -1)}
                ruleByKey={ruleByKey}
                blocked
              />
            ))}
          </div>
        </Panel>
      )}

      {dead.length > 0 && (
        <Panel title={`Expired or taken — ${dead.length}`}>
          <table className="w-full text-sm">
            <tbody>
              {dead.slice(0, 25).map((s) => (
                <tr key={s.id} className="border-b border-line/60">
                  <td className="px-2 py-1.5 font-semibold">{s.symbol}</td>
                  <td className="px-2 py-1.5 text-xs text-dim">
                    {s.grade ? GRADE_LABEL[s.grade] : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-faint">{s.status}</td>
                  <td className="px-2 py-1.5 text-right text-xs text-faint">
                    {ageLabel(s.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}

function Card({
  s,
  zone,
  ruleByKey,
  blocked,
}: {
  s: typeof suggestions.$inferSelect;
  zone?: typeof zones.$inferSelect;
  ruleByKey?: Map<string, typeof rules.$inferSelect>;
  blocked?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border bg-panel2 px-4 py-3 ${
        blocked ? "border-down/30" : "border-line"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg font-semibold">{s.symbol}</span>
        <Badge tone={s.side === "long" ? "up" : "down"}>{s.side}</Badge>
        {s.grade && (
          <Badge tone={GRADE_TONE[s.grade]}>{GRADE_LABEL[s.grade]}</Badge>
        )}
        {s.quadrant && <Badge tone="purple">{QUADRANT_LABEL[s.quadrant]}</Badge>}
        {s.catalystState && (
          <Badge tone={s.catalystState === "opposes" ? "down" : "neutral"}>
            catalyst {s.catalystState}
          </Badge>
        )}
        {s.confluenceCount != null && (
          <Badge title="Independent things stacked at this level">
            {s.confluenceCount}× confluence
          </Badge>
        )}
        <span className="ml-auto text-xs text-faint">
          {ageLabel(s.createdAt)}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-x-6 gap-y-1 text-sm sm:grid-cols-6">
        <F label="Entry" v={s.entry} />
        <F label="Stop" v={s.stop} />
        <F label="Target" v={s.target} />
        <F label="R:R" v={s.rr} plain tone={(s.rr ?? 0) >= 2 ? "up" : "down"} />
        <F label="Size" v={s.sizeUsd} />
        <F label="Shares" v={s.shares} plain />
      </div>

      {zone && (
        <p className="mt-2 text-xs text-dim">
          Zone: {zone.direction} {zone.low}–{zone.high} ({zone.timeframe},{" "}
          {zone.status.replace("_", " ")})
          {zone.confluence?.length ? ` — ${zone.confluence.join(", ")}` : ""}
        </p>
      )}

      {s.thesis && <p className="mt-2 text-sm text-ink">{s.thesis}</p>}
      {s.invalidation && (
        <p className="mt-1 text-xs text-dim">
          <span className="text-faint">Invalidated by:</span> {s.invalidation}
        </p>
      )}

      {blocked && s.gatesFailed?.length ? (
        <div className="mt-3 rounded-md border border-down/30 bg-down/5 px-3 py-2">
          {s.gatesFailed.map((k) => (
            <p key={k} className="text-xs text-down">
              <b>{k}</b>
              {ruleByKey?.get(k) ? ` — ${ruleByKey.get(k)!.text}` : ""}
            </p>
          ))}
        </div>
      ) : null}

      {s.entryMechanic && (
        <p className="mt-2 text-[11px] text-faint">
          entry: {s.entryMechanic.replaceAll("_", " ")}
        </p>
      )}
    </div>
  );
}

function F({
  label,
  v,
  plain,
  tone,
}: {
  label: string;
  v: number | null;
  plain?: boolean;
  tone?: "up" | "down";
}) {
  return (
    <div>
      <div className="text-[10px] tracking-wider text-faint uppercase">
        {label}
      </div>
      <div
        className={`tnum ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-ink"}`}
      >
        {v == null ? "—" : plain ? num(v) : usd(v)}
      </div>
    </div>
  );
}
