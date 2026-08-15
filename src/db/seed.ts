import { db } from "./index";
import { tags, rules } from "./schema";

/**
 * The mistake vocabulary is drawn from the actual trade log, not from a
 * generic list. Every one of these has already happened and cost money —
 * which is the only reason to have a tag at all.
 */
const MISTAKES: { value: string; label: string; note: string }[] = [
  {
    value: "entered_before_rejection",
    label: "Entered before the zone rejected",
    note: "ZS — shorted $174.45, below a $176–181 zone that had never rejected. A confluence stack is not evidence of rejection.",
  },
  {
    value: "ignored_veto",
    label: "Ignored a fundamental veto",
    note: "ZS — shorted a sector printing record highs into a strengthening tailwind. The rule existed and was not applied.",
  },
  {
    value: "below_2to1_gate",
    label: "Took a setup under 2:1 R:R",
    note: "0-for-3 and −$1,498 on violations vs 3-for-3 and +$1,248 when followed.",
  },
  {
    value: "revenge_entry",
    label: "Re-entered inside the 24h cooldown",
    note: "Cooldown after a stop-out exists precisely because the next idea feels urgent.",
  },
  {
    value: "ignored_action_item",
    label: "Ignored a repeated action item",
    note: "NKE — nine consecutive briefs saying close it.",
  },
  {
    value: "skipped_free_stop_move",
    label: "Skipped a free stop move",
    note: "TSLA — five briefs, and by the fifth it cost nothing to do.",
  },
  {
    value: "unverified_price",
    label: "Acted on an unverified price",
    note: "GDX quoted at $112.49 against a real $88.26.",
  },
  {
    value: "target_beyond_shelf",
    label: "Target set beyond a supply/demand shelf",
    note: "QQQ — TP $735.76 missed twice by under $2 at a demonstrated shelf.",
  },
  {
    value: "stop_inside_noise_band",
    label: "Stop tighter than ~1 ADR",
    note: "Gets hit by noise regardless of whether the direction was right.",
  },
  {
    value: "correlated_double_bet",
    label: "Same bet wearing two tickers",
    note: "Two names, one sector, same quadrant is one position.",
  },
  {
    value: "chased_extension",
    label: "Chased an extended move",
    note: "Two-plus sessions into a sharp move, where the R:R gate cannot be met honestly.",
  },
  {
    value: "no_time_stop_on_B",
    label: "No time stop on a B-grade mean reversion",
    note: "A fade that has not reverted is wrong even if the stop has not been hit.",
  },
  {
    value: "held_through_binary",
    label: "Held through a binary event",
    note: "Earnings / CPI / FOMC carried without that being the thesis.",
  },
];

/** Gates must pass to enter. Vetoes kill the trade regardless of grade. */
const RULES: {
  key: string;
  text: string;
  type: "gate" | "veto" | "sizing";
  note?: string;
}[] = [
  {
    key: "rr_2to1",
    text: "Reward:risk at the first target must be at least 2:1. If it is not, fix the target or the stop — do not take it as is.",
    type: "gate",
    note: "0/3 on violations (−$1,498) vs 3/3 compliant (+$1,248).",
  },
  {
    key: "cooldown_24h",
    text: "No new entry within 24 hours of a stop-out.",
    type: "gate",
  },
  {
    key: "risk_1pct",
    text: "Risk per position is 1% of the sizing base. Cap by concentration as well as by risk.",
    type: "sizing",
  },
  {
    key: "zone_must_reject",
    text: "Never short a supply zone until price actually rejects it — a close in the lower third of the range, or back below the zone. A four-way confluence stack is not evidence of rejection.",
    type: "veto",
    note: "The ZS post-mortem. This is the rule the whole app exists to enforce.",
  },
  {
    key: "fundamentals_are_a_veto",
    text: "Fundamentals earn their keep as a veto, not a confirmation. Do not hunt for news that justifies a trade you already want; hunt for the reason it fails.",
    type: "veto",
  },
  {
    key: "no_resting_order_through_binary",
    text: "Never leave a resting limit order through earnings, CPI, NFP or FOMC. Enter before with full awareness, or trade the reaction.",
    type: "veto",
  },
  {
    key: "no_entry_48h_before_earnings",
    text: "No new position within 48 hours of an earnings print unless the earnings is the trade.",
    type: "veto",
  },
  {
    key: "stop_beyond_structure",
    text: "The stop goes beyond a structural feature, not a round number, and no tighter than roughly one average daily range.",
    type: "gate",
  },
  {
    key: "time_stop_on_B",
    text: "Every B-grade mean-reversion trade carries a time stop of roughly 8–10 sessions. If it has not reverted, close it flat.",
    type: "gate",
    note: "Hypothesis — the Method report will tell us the right number.",
  },
  {
    key: "verified_marks_only",
    text: "No decision on a price that has no source and timestamp. If it cannot be verified on the platform, the setup is omitted rather than guessed.",
    type: "gate",
  },
];

async function main() {
  console.log("seeding tag vocabulary…");
  for (const m of MISTAKES) {
    await db
      .insert(tags)
      .values({ group: "mistake", value: m.value, label: m.label, note: m.note })
      .onConflictDoNothing();
  }

  console.log("seeding rules…");
  for (const r of RULES) {
    await db
      .insert(rules)
      .values({ key: r.key, text: r.text, type: r.type, note: r.note })
      .onConflictDoNothing();
  }

  console.log(`done — ${MISTAKES.length} mistake tags, ${RULES.length} rules.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
