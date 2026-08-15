export const usd = (n: number | null | undefined, dp = 2) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(dp)}`;

export const pct = (n: number | null | undefined, dp = 2) =>
  n == null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(dp)}%`;

export const rr = (n: number | null | undefined) =>
  n == null ? "—" : `${n.toFixed(2)}R`;

export const num = (n: number | null | undefined, dp = 2) =>
  n == null ? "—" : n.toFixed(dp);

/** Minutes since a timestamp — drives the staleness badge on every mark. */
export function ageMinutes(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const t = typeof d === "string" ? new Date(d) : d;
  return Math.floor((Date.now() - t.getTime()) / 60000);
}

export function ageLabel(d: Date | string | null | undefined): string {
  const m = ageMinutes(d);
  if (m == null) return "no timestamp";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Freshness tiers. A mark older than 15 minutes is amber; older than a
 * day is red. The point is that a stale number never renders like a
 * current one — the whole class of bug this app exists to kill.
 */
export function freshness(
  d: Date | string | null | undefined,
): "fresh" | "stale" | "old" | "missing" {
  const m = ageMinutes(d);
  if (m == null) return "missing";
  if (m <= 15) return "fresh";
  if (m <= 60 * 24) return "stale";
  return "old";
}

export const SOURCE_LABEL: Record<string, string> = {
  chrome_tradingview: "TradingView",
  chrome_broker: "Broker",
  manual: "Manual",
  derived: "Derived",
};

export const QUADRANT_LABEL: Record<string, string> = {
  up_demand: "Uptrend @ demand",
  up_supply: "Uptrend @ supply",
  down_supply: "Downtrend @ supply",
  down_demand: "Downtrend @ demand",
  contested: "Contested",
};

/** The two with-trend quadrants — where the method claims to earn its money. */
export const STRONG_QUADRANTS = ["up_demand", "down_supply"];

export const GRADE_LABEL: Record<string, string> = {
  A_plus: "A+",
  A_minus: "A−",
  B: "B",
  C: "C",
};
