/**
 * One-off repair: zones written before 2026-08-18 used two conventions for
 * the same timeframe ("daily" and "1D", "weekly" and "1W"). Zones upsert on
 * (symbol, timeframe, direction), so the two conventions never converged —
 * the same level existed twice and neither copy ever refreshed the other.
 *
 * The ingest route now normalises on the way in, so this can only ever need
 * to run once. It is safe to run again: the second pass finds nothing.
 *
 *   npx tsx --env-file=.env src/db/fix-timeframes.ts
 *
 * Where both conventions exist for the same (symbol, direction), the row
 * with the more recent lastSeenAt wins and the older one is deleted — the
 * fresher read is the one the charts actually confirmed.
 */
import { db } from "./index";
import { zones, wishlist, suggestions, trades } from "./schema";
import { eq, inArray } from "drizzle-orm";

/**
 * wishlist, suggestions and trades all carry a zoneId FK with no ON DELETE
 * rule, so a duplicate cannot simply be deleted — anything pointing at it
 * has to be repointed at the survivor first, or Postgres refuses and, worse,
 * a journalled trade loses the level it was taken against.
 */
async function repoint(from: number, to: number) {
  await db.update(wishlist).set({ zoneId: to }).where(eq(wishlist.zoneId, from));
  await db.update(suggestions).set({ zoneId: to }).where(eq(suggestions.zoneId, from));
  await db.update(trades).set({ zoneId: to }).where(eq(trades.zoneId, from));
}

const CANON: Record<string, string> = {
  daily: "1D", d: "1D", "1d": "1D",
  weekly: "1W", w: "1W", "1w": "1W",
  monthly: "1M", m: "1M", "1m": "1M",
  "4h": "4H", "1h": "1H",
};

async function main() {
  const all = await db.select().from(zones);
  console.log(`${all.length} zones in the table`);

  const canonical = (tf: string) =>
    CANON[tf.trim().toLowerCase()] ?? tf.trim().toUpperCase();

  const stale = all.filter((z) => canonical(z.timeframe) !== z.timeframe);
  if (!stale.length) {
    console.log("nothing to fix — every timeframe is already canonical");
    process.exit(0);
  }

  console.log(`${stale.length} rows use a non-canonical timeframe:`);
  for (const z of stale) {
    console.log(`  #${z.id} ${z.symbol} ${z.direction} "${z.timeframe}" -> "${canonical(z.timeframe)}"`);
  }

  const drop: number[] = [];
  let renamed = 0;

  for (const z of stale) {
    const target = canonical(z.timeframe);
    const clash = all.find(
      (o) =>
        o.id !== z.id &&
        o.symbol === z.symbol &&
        o.direction === z.direction &&
        o.timeframe === target,
    );

    if (!clash) {
      await db.update(zones).set({ timeframe: target }).where(eq(zones.id, z.id));
      renamed++;
      continue;
    }

    // Both conventions exist. Keep whichever was seen most recently.
    const zAt = z.lastSeenAt?.getTime() ?? 0;
    const cAt = clash.lastSeenAt?.getTime() ?? 0;
    if (zAt > cAt) {
      await repoint(clash.id, z.id);
      drop.push(clash.id);
      await db.update(zones).set({ timeframe: target }).where(eq(zones.id, z.id));
      renamed++;
      console.log(`  #${z.id} is fresher than #${clash.id} — keeping #${z.id}`);
    } else {
      await repoint(z.id, clash.id);
      drop.push(z.id);
      console.log(`  #${clash.id} is fresher than #${z.id} — dropping #${z.id}`);
    }
  }

  if (drop.length) {
    await db.delete(zones).where(inArray(zones.id, drop));
  }

  console.log(`\nrenamed ${renamed}, deleted ${drop.length} duplicate(s)`);
  console.log("re-run to confirm it reports nothing to fix");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
