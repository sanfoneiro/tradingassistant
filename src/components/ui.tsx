import { freshness, ageLabel, SOURCE_LABEL } from "@/lib/format";
import { MIN_SAMPLE } from "@/lib/metrics";

export function Panel({
  title,
  right,
  children,
  className = "",
}: {
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-line bg-panel ${className}`}
    >
      {title && (
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold tracking-wide text-dim uppercase">
            {title}
          </h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
  n,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "up" | "down" | "warn";
  /** Sample size. Under MIN_SAMPLE the number is greyed — a 100% win
   *  rate on two trades has burned better traders than us. */
  n?: number;
}) {
  const thin = n != null && n < MIN_SAMPLE;
  const toneClass = thin
    ? "text-faint"
    : tone === "up"
      ? "text-up"
      : tone === "down"
        ? "text-down"
        : tone === "warn"
          ? "text-warn"
          : "text-ink";

  return (
    <div className="rounded-lg border border-line bg-panel2 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-faint">
        {label}
      </div>
      <div className={`tnum mt-1 text-xl ${toneClass}`}>{value}</div>
      {(sub || thin) && (
        <div className="mt-0.5 text-[11px] text-faint">
          {thin ? `${n} trades — not enough to read` : sub}
        </div>
      )}
    </div>
  );
}

/**
 * Every price in this app renders through here. A number with no source
 * and no timestamp is visibly not a number you can act on.
 */
export function Mark({
  value,
  source,
  at,
  dp = 2,
}: {
  value: number | null | undefined;
  source?: string | null;
  at?: Date | string | null;
  dp?: number;
}) {
  if (value == null) {
    return (
      <span
        className="tnum text-down"
        title="No trusted mark. The agent flagged this rather than guessing."
      >
        no mark
      </span>
    );
  }
  const f = freshness(at);
  const cls =
    f === "fresh"
      ? "text-ink"
      : f === "stale"
        ? "text-warn"
        : f === "old"
          ? "text-down"
          : "text-faint";
  const title = `${source ? SOURCE_LABEL[source] ?? source : "unknown source"} · ${ageLabel(at)}`;
  return (
    <span className={`tnum ${cls}`} title={title}>
      ${value.toFixed(dp)}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "up" | "down" | "warn" | "acc" | "purple";
  title?: string;
}) {
  const map = {
    neutral: "border-line text-dim",
    up: "border-up/40 text-up bg-up/5",
    down: "border-down/40 text-down bg-down/5",
    warn: "border-warn/40 text-warn bg-warn/5",
    acc: "border-acc/40 text-acc bg-acc/5",
    purple: "border-purple/40 text-purple bg-purple/5",
  } as const;
  return (
    <span
      title={title}
      className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] whitespace-nowrap ${map[tone]}`}
    >
      {children}
    </span>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-faint">
      {children}
    </div>
  );
}

export function RiskBar({
  segments,
  total,
}: {
  segments: { label: string; value: number }[];
  total: number;
}) {
  if (!total) return null;
  const palette = [
    "#5aa7ff",
    "#a97bff",
    "#e3b341",
    "#3fb950",
    "#f85149",
    "#4dd0e1",
    "#ff8b83",
  ];
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full border border-line">
        {segments.map((s, i) => (
          <div
            key={s.label}
            style={{
              width: `${(s.value / total) * 100}%`,
              background: palette[i % palette.length],
            }}
            title={`${s.label} — $${s.value.toFixed(2)} (${((s.value / total) * 100).toFixed(0)}%)`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-dim">
        {segments.map((s, i) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: palette[i % palette.length] }}
            />
            {s.label}
            <span className="tnum text-faint">
              {((s.value / total) * 100).toFixed(0)}%
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
