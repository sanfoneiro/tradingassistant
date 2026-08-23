import { eq, and } from "drizzle-orm";
import { db } from "./index";
import { trades, suggestions } from "./schema";

/**
 * Second half of the August repair: make R either right or absent.
 *
 * The old close path wrote the CURRENT stop into stopPlanned, so R is
 * measured against wherever the stop had been trailed to rather than the
 * risk originally taken. On these seven that is not a small distortion:
 *
 *   NKE  lost $422 — 5.7% of the account against a 1% budget, so roughly
 *        5.7 units of risk — but records as −1.01R, because the trailed
 *        stop happened to sit at the exit. A textbook single-unit loss.
 *   QQQ  won $69 and records as 0.94R, because the stop had been raised
 *        ABOVE a long entry. The initial risk was far smaller and the real
 *        R far larger.
 *
 * Two fixes, depending on whether the original plan survives anywhere.
 *
 * WWD and AER were graded before entry and their suggestions are still on
 * file, so the planned entry, stop and target are recoverable exactly. Both
 * were stopped out — AER by a single cent — and both produce a real R.
 *
 * The other five have no suggestion. Their initial stops are genuinely lost,
 * so stopPlanned becomes NULL and rMultiple stays null. A missing number the
 * reports grey out is the honest answer; a plausible wrong one is the exact
 * failure this project exists to prevent. The trailed stop is preserved in
 * stopFinal rather than discarded.
 *
 * Having no suggestion is itself the finding: those five were self-generated,
 * which is what the shadow book compares against.
 *
 *   npm run db:repair-levels
 */

/** Graded before entry — the plan is recoverable. */
const FROM_SUGGESTION: { symbol: string; suggestionId: number }[] = [
  { symbol: "WWD", suggestionId: 2 },
  { symbol: "AER", suggestionId: 4 },
];

/** No suggestion on file. Initial stop unrecoverable. */
const SELF_GENERATED = ["NKE", "TSLA", "XOM", "BA", "QQQ"];

async function main() {
  console.log("restoring planned levels from the graded setups…");

  for (const { symbol, suggestionId } of FROM_SUGGESTION) {
    const [s] = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.id, suggestionId))
      .limit(1);
    if (!s) {
      console.log(`  ${symbol.padEnd(5)} suggestion #${suggestionId} missing — skipped`);
      continue;
    }

    const [t] = await db
      .select()
      .from(trades)
      .where(and(eq(trades.symbol, symbol), eq(trades.status, "pending_review")))
      .limit(1);
    if (!t) {
      console.log(`  ${symbol.padEnd(5)} no trade awaiting review — skipped`);
      continue;
    }

    await db
      .update(trades)
      .set({
        suggestionId: s.id,
        entryPlanned: s.entry,
        stopPlanned: s.stop,
        targetPlanned: s.target,
        grade: s.grade,
        quadrant: s.quadrant,
        catalystState: s.catalystState,
        entryMechanic: s.entryMechanic,
        confluenceCount: s.confluenceCount,
        selfGenerated: false,
      })
      .where(eq(trades.id, t.id));

    const rps = Math.abs((t.entryActual ?? s.entry!) - s.stop!);
    const dir = t.side === "long" ? 1 : -1;
    const plv = dir * (t.exitActual! - t.entryActual!) * t.qty! - (t.fees ?? 0);
    console.log(
      `  ${symbol.padEnd(5)} #${t.id} ← suggestion #${s.id} (${s.grade})  ` +
        `stop ${s.stop}  target ${s.target}  →  R ${(plv / (rps * t.qty!)).toFixed(2)}`,
    );
  }

  console.log("\nclearing stops that are trailed, not initial…");
  for (const symbol of SELF_GENERATED) {
    const [t] = await db
      .select()
      .from(trades)
      .where(and(eq(trades.symbol, symbol), eq(trades.status, "pending_review")))
      .limit(1);
    if (!t) {
      console.log(`  ${symbol.padEnd(5)} no trade awaiting review — skipped`);
      continue;
    }

    await db
      .update(trades)
      .set({
        // Keep the trailed stop — it is a real fact about the exit.
        stopFinal: t.stopFinal ?? t.stopPlanned,
        // But it is not the risk that was taken, so it cannot stand in for it.
        stopPlanned: null,
        rrPlanned: null,
        rMultiple: null,
        selfGenerated: true,
      })
      .where(eq(trades.id, t.id));

    console.log(
      `  ${symbol.padEnd(5)} #${t.id} stopPlanned ${t.stopPlanned} → stopFinal; R will read as unknown`,
    );
  }

  console.log(
    "\nDone. WWD and AER carry a real R. The other five report P/L without\n" +
      "one, which is the truth — their initial stops were never recorded.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
