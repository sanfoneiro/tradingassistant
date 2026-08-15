import { eq } from "drizzle-orm";
import { db } from "@/db";
import { rules, trades } from "@/db/schema";
import { Panel, Empty, Badge } from "@/components/ui";
import { usd } from "@/lib/format";
import { stats, MIN_SAMPLE } from "@/lib/metrics";
import { safe, dbConfigured } from "@/lib/safe";

export const dynamic = "force-dynamic";

const TYPE_TONE = {
  gate: "acc",
  veto: "down",
  sizing: "purple",
} as const;

export default async function RulesPage() {
  if (!dbConfigured())
    return <p className="py-12 text-center text-sm text-dim">Database not connected.</p>;

  const all = (await safe(() => db.select().from(rules).where(eq(rules.active, true)))) ?? [];
  const closed =
    (await safe(() => db.select().from(trades).where(eq(trades.status, "closed")))) ??
    [];

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-line bg-panel2 px-4 py-3 text-xs text-dim">
        <b className="text-ink">Gates</b> must pass before entry.{" "}
        <b className="text-ink">Vetoes</b> kill the trade regardless of how good
        the setup looks. Both are enforced by the grader, not by memory — the
        expensive lesson is that a rule which exists but is not enforced is not
        a rule.
      </div>

      <Panel title="Active rules">
        {all.length === 0 ? (
          <Empty>
            No rules seeded. Run <code className="text-acc">npm run db:seed</code>.
          </Empty>
        ) : (
          <ul className="space-y-3">
            {all.map((r) => {
              const followed = closed.filter((t) =>
                (t.rulesFollowed as number[] | null)?.includes(r.id),
              );
              const violated = closed.filter((t) =>
                (t.rulesViolated as number[] | null)?.includes(r.id),
              );
              const sf = stats(followed);
              const sv = stats(violated);
              const enough = followed.length + violated.length > 0;

              return (
                <li
                  key={r.id}
                  className="rounded-lg border border-line bg-panel2 px-4 py-3"
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <Badge tone={TYPE_TONE[r.type]}>{r.type}</Badge>
                    <code className="text-[11px] text-faint">{r.key}</code>
                  </div>
                  <p className="text-sm">{r.text}</p>
                  {r.note && (
                    <p className="mt-1 text-xs text-faint">{r.note}</p>
                  )}
                  {enough && (
                    <div className="mt-2 flex gap-6 text-xs">
                      <span className="text-dim">
                        Followed{" "}
                        <b className="tnum text-up">
                          {followed.length}× {usd(sf.netPl)}
                        </b>
                      </span>
                      <span className="text-dim">
                        Violated{" "}
                        <b className="tnum text-down">
                          {violated.length}× {usd(sv.netPl)}
                        </b>
                      </span>
                      {followed.length + violated.length < MIN_SAMPLE && (
                        <Badge>thin</Badge>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
