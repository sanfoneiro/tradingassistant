/**
 * Move the sizing rules from a six-slot book to a two-slot one — and back.
 *
 * This is deliberately NOT a migration in drizzle/. Migrations re-apply on
 * every run, which would mean the next `db:migrate` silently undid a revert;
 * a rule you cannot turn off is not versioned, it is welded. The `rules` table
 * already carries `version` and `active`, so the switch belongs here:
 *
 *   npm run rules:sizing-policy            two slots  (45% / 60%, 1-2% risk)
 *   npm run rules:sizing-policy -- --revert  six slots (15% / 20%, 1% risk)
 *   npm run rules:sizing-policy -- --dry     print, write nothing
 *
 * Both keys keep their names. `risk_1pct` is a stale name for a rule that now
 * says 1-2%, and it stays anyway: twelve stored suggestions name it by that
 * exact string in gatesPassed, and orphaning that history to fix a label is a
 * bad trade.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from ".";
import { rules } from "./schema";

const MAX_SLOTS = 2;

const V2 = [
  {
    key: "sizing_window",
    type: "gate" as const,
    text:
      `A setup must be sizeable before it is a setup. With at most ${MAX_SLOTS} positions ` +
      `open at once, position size is capped at 45% of the sizing base (60% for an ` +
      `A_plus, and only when 45% will not carry the trade), and at that size the ` +
      `reward-to-risk must still clear 2:1 NET of the $4.00 round trip. Those two limits ` +
      `define a window: at least enough shares for the ratio to survive the commission, ` +
      `at most enough to respect the cap. When the window is empty there is no size that ` +
      `satisfies both — skip the trade rather than take it smaller, and do not grade it at all.`,
    note:
      `Raised 2026-09-01 from 15%/20%, because the book narrowed to at most ${MAX_SLOTS} ` +
      `concurrent positions — NOT because concentration became more acceptable. The cap is ` +
      `deployment divided by slots: 15% x 6 and 45% x 2 are the same 90% total exposure, and ` +
      `sizingPolicy() in src/lib/metrics.ts asserts by exact equality that it still returns ` +
      `15%/20% at six slots. What it fixes: a 4% stop on a $180 share against a $7,600 base ` +
      `was cut to 6 shares by the old cap — risking $43, which is 0.57% and not the 1% the ` +
      `rule claimed, with the $4 round trip eating 9.3% of the risk budget. At two slots it ` +
      `is 19 shares, $137, and 2.9%. Revert: npm run rules:sizing-policy -- --revert`,
  },
  {
    key: "risk_1pct",
    type: "sizing" as const,
    text:
      `Risk per position is 1% of the sizing base, or up to 2% on an A_plus. Cap by ` +
      `concentration as well as by risk. With at most ${MAX_SLOTS} positions open, 2% each ` +
      `is 4% of portfolio heat, inside the 6% ceiling.`,
    note:
      `The 2% A_plus allowance is Oron's, stated 2026-09-01. It is a HYPOTHESIS with no ` +
      `closed trades behind it: nothing in the book yet shows that an A_plus sized up ` +
      `out-earns an A_plus at 1%, and the Method report is what should decide. Heat, not ` +
      `the per-position number, is the constraint being held fixed — ${MAX_SLOTS} slots x 3% ` +
      `is the 6% ceiling, so 2% leaves room and 3% does not.`,
  },
];

async function show(label: string) {
  const rows = await db
    .select()
    .from(rules)
    .where(sql`${rules.key} in ('sizing_window', 'risk_1pct')`);
  console.log(`\n--- ${label} ---`);
  for (const r of rows.sort((a, b) => a.key.localeCompare(b.key) || a.version - b.version))
    console.log(`  ${r.key.padEnd(15)} v${r.version}  active=${r.active}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const revert = argv.includes("--revert");
  const dry = argv.includes("--dry");

  await show("before");
  if (dry) {
    console.log(`\n[dry] would ${revert ? "revert to v1 (six slots)" : "activate v2 (two slots)"}`);
    return;
  }

  for (const r of V2) {
    const existing = await db
      .select()
      .from(rules)
      .where(and(eq(rules.key, r.key), eq(rules.version, 2)));

    if (revert) {
      await db.update(rules).set({ active: false }).where(and(eq(rules.key, r.key), eq(rules.version, 2)));
      await db.update(rules).set({ active: true }).where(and(eq(rules.key, r.key), eq(rules.version, 1)));
      continue;
    }

    if (existing.length === 0) {
      await db.insert(rules).values({
        key: r.key,
        text: r.text,
        type: r.type,
        version: 2,
        active: true,
        note: r.note,
      });
    } else {
      // Idempotent: re-running refreshes the text and re-activates, it does
      // not stack a third copy.
      await db
        .update(rules)
        .set({ text: r.text, note: r.note, active: true })
        .where(and(eq(rules.key, r.key), eq(rules.version, 2)));
    }
    await db.update(rules).set({ active: false }).where(and(eq(rules.key, r.key), eq(rules.version, 1)));
  }

  await show("after");
  console.log(
    revert
      ? "\nreverted — six slots, 15%/20%, 1% risk"
      : `\nactive — ${MAX_SLOTS} slots, 45%/60%, 1-2% risk`,
  );
}
main().then(() => process.exit(0));
