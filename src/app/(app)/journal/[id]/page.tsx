import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { trades, tags, tradeTags, journal } from "@/db/schema";
import { Panel, Badge } from "@/components/ui";
import { usd, rr, num, QUADRANT_LABEL, GRADE_LABEL } from "@/lib/format";
import { safe } from "@/lib/safe";
import ReviewForm from "./review-form";

export const dynamic = "force-dynamic";

export default async function TradeReview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tradeId = Number(id);
  if (!Number.isFinite(tradeId)) notFound();

  const trade = await safe(
    async () =>
      (await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1))[0],
  );
  if (!trade) notFound();

  const mistakes =
    (await safe(() => db.select().from(tags).where(eq(tags.group, "mistake")))) ??
    [];
  const applied =
    (await safe(() =>
      db.select().from(tradeTags).where(eq(tradeTags.tradeId, tradeId)),
    )) ?? [];
  const entry = await safe(
    async () =>
      (
        await db.select().from(journal).where(eq(journal.tradeId, tradeId)).limit(1)
      )[0],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{trade.symbol}</h1>
        <Badge tone={trade.side === "long" ? "up" : "down"}>{trade.side}</Badge>
        {trade.grade && <Badge tone="acc">{GRADE_LABEL[trade.grade]}</Badge>}
        {trade.quadrant && (
          <Badge tone="purple">{QUADRANT_LABEL[trade.quadrant]}</Badge>
        )}
        {trade.catalystState && <Badge>{trade.catalystState}</Badge>}
        {trade.status === "pending_review" && (
          <Badge tone="warn">awaiting review</Badge>
        )}
      </div>

      <Panel title="The numbers">
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
          <Field label="Entry planned" value={fmt(trade.entryPlanned)} />
          <Field label="Entry actual" value={fmt(trade.entryActual)} />
          <Field label="Stop" value={fmt(trade.stopPlanned)} />
          <Field label="Target" value={fmt(trade.targetPlanned)} />
          <Field label="Exit" value={fmt(trade.exitActual)} />
          <Field label="Qty" value={num(trade.qty, 0)} />
          <Field label="R:R planned" value={num(trade.rrPlanned)} />
          <Field label="R:R actual" value={num(trade.rrActual)} />
          <Field
            label="P/L"
            value={usd(trade.plUsd)}
            tone={(trade.plUsd ?? 0) >= 0 ? "up" : "down"}
          />
          <Field
            label="R multiple"
            value={rr(trade.rMultiple)}
            tone={(trade.rMultiple ?? 0) >= 0 ? "up" : "down"}
          />
          <Field
            label="MFE"
            value={rr(trade.mfeR)}
            hint="What the market actually offered"
          />
          <Field
            label="MAE"
            value={rr(trade.maeR)}
            hint="How close this came to stopping out"
          />
          <Field label="Efficiency" value={num(trade.efficiency)} hint="P/L ÷ MFE" />
          <Field
            label="Stop width"
            value={trade.stopWidthInAdr != null ? `${num(trade.stopWidthInAdr)} ADR` : "—"}
            hint="Under ~1 ADR is inside the noise band"
          />
          <Field label="Hold" value={trade.holdDays != null ? `${num(trade.holdDays, 1)}d` : "—"} />
          <Field label="Confluence" value={trade.confluenceCount != null ? String(trade.confluenceCount) : "—"} />
        </div>
        {trade.mfeR != null && trade.rMultiple != null && trade.mfeR > trade.rMultiple + 0.5 && (
          <p className="mt-4 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
            The move offered {rr(trade.mfeR)} and this captured {rr(trade.rMultiple)}.
            Worth asking whether the target sat beyond what was actually available.
          </p>
        )}
      </Panel>

      <ReviewForm
        tradeId={tradeId}
        mistakes={mistakes.map((m) => ({
          id: m.id,
          label: m.label,
          note: m.note ?? "",
        }))}
        applied={applied.map((a) => a.tagId)}
        existing={
          entry
            ? {
                whatWorked: entry.whatWorked,
                whatFailed: entry.whatFailed,
                lesson: entry.lesson,
                recurring: entry.recurring,
                playbookEntry: entry.playbookEntry ?? "",
                playbookExit: entry.playbookExit ?? "",
              }
            : null
        }
        exitActual={trade.exitActual}
        exitProvisional={trade.exitProvisional}
        exitReason={trade.exitReason}
        execution={trade.execution}
        emotion={trade.emotion}
      />
    </div>
  );
}

function fmt(n: number | null) {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

function Field({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
  hint?: string;
}) {
  return (
    <div title={hint}>
      <div className="text-[10px] tracking-wider text-faint uppercase">
        {label}
      </div>
      <div
        className={`tnum ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-ink"}`}
      >
        {value}
      </div>
    </div>
  );
}
