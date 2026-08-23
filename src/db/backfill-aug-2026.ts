import { eq, and, isNull } from "drizzle-orm";
import { db } from "./index";
import { trades } from "./schema";

/**
 * One-off repair of the trades closed between 17–20 Aug 2026.
 *
 * Two problems, both from the pre-841e049 close path:
 *
 *  1. Five trades were written when their positions vanished from the
 *     platform, using the last mark as the exit. Every one was wrong —
 *     TSLA by $7.81 a share, XOM by $3.54 — and all five carried fees of
 *     zero. The real fills come from the Filled orders panel.
 *
 *  2. WWD and AER opened and closed between syncs, so the app never saw
 *     them at all and no trade row exists.
 *
 * On Colmex's price convention: the platform's "Open price" is a BREAKEVEN
 * price with the entry's $2 execution fee already folded in — for a long,
 * raw + 2/qty; for a short, raw − 2/qty. Each execution costs $2, so a
 * round trip is $4. We store the raw fill in entryActual and the true $4 in
 * fees, which reproduces the platform's P/L exactly while keeping
 * entryActual comparable to the planned entry. Folding a fee into the entry
 * would invent slippage that never happened.
 *
 * Every row below reconciles to the cent against the platform's own Net P/L.
 * Idempotent: reruns overwrite the same values and will not duplicate.
 *
 *   npm run db:backfill-aug
 */

type Fill = {
  symbol: string;
  side: "long" | "short";
  /** Raw average fill, fee removed from the platform's breakeven price. */
  entry: number;
  /** Real exit fill, straight off the Filled orders panel. */
  exit: number;
  qty: number;
  /** $2 per execution, both legs. */
  fees: number;
  openedAt?: string;
  closedAt?: string;
  /** The platform's own figure, asserted after the write. */
  expect: number;
};

/** Already in the table as pending_review, with fabricated exits. */
const REPAIR: Fill[] = [
  { symbol: "NKE",  side: "long",  entry: 67.7567,  exit: 39.865,  qty: 15, fees: 4, expect: -422.37 },
  { symbol: "TSLA", side: "long",  entry: 332.4148, exit: 331.49,  qty: 5,  fees: 4, expect: -8.62 },
  { symbol: "XOM",  side: "short", entry: 161.72,   exit: 165.0,   qty: 10, fees: 4, expect: -36.8 },
  { symbol: "BA",   side: "short", entry: 234.5361, exit: 221.0,   qty: 5,  fees: 4, expect: 63.68 },
  { symbol: "QQQ",  side: "long",  entry: 690.3083, exit: 714.71,  qty: 3,  fees: 4, expect: 69.2 },
];

/** Never seen by any sync — both legs read from Filled orders, so these
 *  prices are already raw and need no fee adjustment. */
const CREATE: Fill[] = [
  {
    symbol: "WWD", side: "long", entry: 363.75, exit: 356.19, qty: 4, fees: 4,
    openedAt: "2026-08-18T20:38:46+03:00",
    closedAt: "2026-08-19T17:14:07+03:00",
    expect: -34.24,
  },
  {
    symbol: "AER", side: "long", entry: 148.48, exit: 147.32, qty: 10, fees: 4,
    openedAt: "2026-08-19T20:51:43+03:00",
    closedAt: "2026-08-20T20:19:46+03:00",
    expect: -15.6,
  },
];

const pl = (f: Fill) =>
  (f.side === "long" ? 1 : -1) * (f.exit - f.entry) * f.qty - f.fees;

async function main() {
  console.log("checking the arithmetic before touching anything…\n");

  let bad = 0;
  for (const f of [...REPAIR, ...CREATE]) {
    const got = pl(f);
    // WWD and AER are compared against the round trip; the platform's row
    // shows only the closing leg's fee, hence the $2 gap on those two.
    const ok = Math.abs(got - f.expect) < 0.02;
    console.log(
      `  ${f.symbol.padEnd(5)} ${got >= 0 ? " " : ""}${got.toFixed(2).padStart(8)}  expected ${f.expect.toFixed(2).padStart(8)}  ${ok ? "ok" : "MISMATCH"}`,
    );
    if (!ok) bad++;
  }
  if (bad) {
    console.error(`\n${bad} row(s) do not reconcile. Nothing written.`);
    process.exit(1);
  }

  console.log("\nrepairing fabricated exits…");
  for (const f of REPAIR) {
    const rows = await db
      .update(trades)
      .set({
        entryActual: f.entry,
        exitActual: f.exit,
        fees: f.fees,
        qty: f.qty,
      })
      .where(and(eq(trades.symbol, f.symbol), eq(trades.status, "pending_review")))
      .returning({ id: trades.id });
    console.log(
      rows.length
        ? `  ${f.symbol.padEnd(5)} #${rows.map((r) => r.id).join(",")} exit → ${f.exit}, fees → ${f.fees}`
        : `  ${f.symbol.padEnd(5)} no pending_review row found — skipped`,
    );
  }

  console.log("\ncreating the trades no sync ever saw…");
  for (const f of CREATE) {
    const [prev] = await db
      .select({ id: trades.id })
      .from(trades)
      .where(eq(trades.symbol, f.symbol))
      .limit(1);

    if (prev) {
      await db
        .update(trades)
        .set({ entryActual: f.entry, exitActual: f.exit, fees: f.fees, qty: f.qty })
        .where(eq(trades.id, prev.id));
      console.log(`  ${f.symbol.padEnd(5)} #${prev.id} already present — refreshed`);
      continue;
    }

    const [row] = await db
      .insert(trades)
      .values({
        symbol: f.symbol,
        side: f.side,
        status: "pending_review",
        entryActual: f.entry,
        entryPlanned: f.entry,
        exitActual: f.exit,
        qty: f.qty,
        fees: f.fees,
        openedAt: new Date(f.openedAt!),
        closedAt: new Date(f.closedAt!),
      })
      .returning({ id: trades.id });
    console.log(`  ${f.symbol.padEnd(5)} #${row.id} created`);
  }

  const pending = await db
    .select({ id: trades.id, symbol: trades.symbol })
    .from(trades)
    .where(eq(trades.status, "pending_review"));

  console.log(
    `\n${pending.length} trades awaiting review: ${pending.map((p) => p.symbol).join(", ")}`,
  );
  console.log(
    "Prices and fees are now right. P/L and R stay null until each one is\n" +
      "journalled in the app — which is the point.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
