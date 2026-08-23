import { eq } from "drizzle-orm";
import { db } from "./index";
import { suggestions, wishlist } from "./schema";
import { fetchDailyBars, Throttle } from "../lib/massive";
import { TRIGGER_BAND_PCT, triggerStamp } from "../lib/funnel";

/**
 * Apply the funnel gate to suggestions that predate it.
 *
 * Five suggestions were written on 17–18 August by the old screener, before
 * ingest refused an entry more than 2% from price. They are exactly what the
 * gate now prevents — hypothetical entry, stop, target and R:R on names price
 * never reached — and the Ideas page files them under "Actionable, every gate
 * passed".
 *
 * Rather than expiring them wholesale, each is re-checked against the current
 * price. One that is still at its level is a real idea and stays. One that is
 * not becomes a wishlist entry carrying its own entry as the trigger, which is
 * what it should have been in the first place. Nothing is discarded: the
 * thesis and the level survive the demotion.
 *
 *   npm run db:retro-gate            # report only
 *   npm run db:retro-gate -- --apply
 */

const apply = process.argv.includes("--apply");
const n = (x: number) => x.toFixed(2).padStart(9);

async function main() {
  const open = await db
    .select()
    .from(suggestions)
    .where(eq(suggestions.status, "open"));

  if (!open.length) {
    console.log("no open suggestions.");
    process.exit(0);
  }

  console.log(
    `${open.length} open suggestion(s). Re-checking each against current price ` +
      `(the gate allows ${TRIGGER_BAND_PCT}%).\n`,
  );

  const throttle = new Throttle();
  let kept = 0;
  let demoted = 0;
  let skipped = 0;

  for (const s of open) {
    let price: number | null = null;
    try {
      await throttle.take();
      const bars = await fetchDailyBars(s.symbol, { years: 1 });
      price = bars.at(-1)?.c ?? null;
    } catch (e) {
      console.log(
        `  ${s.symbol.padEnd(7)} price unavailable — left alone ` +
          `(${e instanceof Error ? e.message.slice(0, 60) : e})`,
      );
      skipped++;
      continue;
    }

    if (price == null || s.entry == null) {
      console.log(`  ${s.symbol.padEnd(7)} no price or no entry — left alone`);
      skipped++;
      continue;
    }

    const distance = ((s.entry - price) / price) * 100;
    const withinGate = Math.abs(distance) <= TRIGGER_BAND_PCT;

    if (withinGate) {
      console.log(
        `  ${s.symbol.padEnd(7)} entry ${n(s.entry)}  price ${n(price)}  ` +
          `${distance.toFixed(2).padStart(7)}%  KEEP — still at its level`,
      );
      kept++;
      continue;
    }

    console.log(
      `  ${s.symbol.padEnd(7)} entry ${n(s.entry)}  price ${n(price)}  ` +
        `${distance.toFixed(2).padStart(7)}%  demote to wishlist`,
    );
    demoted++;
    if (!apply) continue;

    await db
      .update(suggestions)
      .set({ status: "expired" })
      .where(eq(suggestions.id, s.id));

    // The level is still worth watching — carry it across as the trigger so
    // the demotion loses nothing but the premature arithmetic.
    const [prev] = await db
      .select()
      .from(wishlist)
      .where(eq(wishlist.symbol, s.symbol))
      .limit(1);

    const values = {
      symbol: s.symbol,
      side: s.side,
      thesis: s.thesis,
      zoneId: s.zoneId,
      triggerLevel: s.entry,
      distancePct: Number(distance.toFixed(4)),
      triggerNote:
        `price reaches ${s.entry} — demoted from a ${s.grade ?? "graded"} ` +
        `suggestion of ${String(s.createdAt).slice(4, 16)} that was posted ` +
        `before the 2% gate existed`,
      triggeredAt: triggerStamp(distance, prev?.triggeredAt ?? null),
      priority: Math.abs(distance) <= 6 ? 2 : 4,
      active: true,
      updatedAt: new Date(),
    };

    if (prev) {
      await db.update(wishlist).set(values).where(eq(wishlist.id, prev.id));
    } else {
      await db.insert(wishlist).values(values);
    }
  }

  console.log(
    `\n${kept} kept · ${demoted} ${apply ? "demoted" : "would be demoted"} · ${skipped} skipped`,
  );
  if (!apply && demoted) console.log("Re-run with --apply to write.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
