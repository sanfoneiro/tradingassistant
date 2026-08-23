import { z } from "zod";

/**
 * Reading the Colmex terminal from a screenshot.
 *
 * Vision transcription is exactly the failure this project exists to prevent —
 * a number read off an image has no source and no guarantee. What makes it
 * acceptable here is that the platform's own screen is redundant: every
 * position publishes enough columns to check the ones that matter.
 *
 *   Net P/L   = (current − open) × qty × dir − fee
 *   SL, value = |open − SL| × qty
 *
 * So a parse is not trusted, it is verified. A row whose arithmetic does not
 * tie out is rejected rather than ingested, and the reason is reported. The
 * same trick verified the TradingView zone table; it applies here because the
 * broker, like the indicator, shows its work.
 *
 * On the price convention — Colmex's "Open price" is a BREAKEVEN that already
 * includes the entry's $2 execution fee (plus fee/qty for a long, minus for a
 * short), and the Fee column shows the anticipated exit fee. That is why
 * lockedGain computed from it reproduces the platform's SL,value column
 * exactly. We keep the platform's convention so the app and the screen agree.
 */

/** Both invariants must hold within this many dollars. Tighter than a cent
 *  would fail on the platform's own rounding; looser would let a misread
 *  digit through. */
export const TOLERANCE = 0.02;

export const colmexPosition = z.object({
  symbol: z.string().min(1),
  side: z.enum(["long", "short"]),
  qty: z.number().positive(),
  /** The "Open price" column, verbatim — a breakeven, not the raw fill. */
  openPrice: z.number().positive(),
  /** The "Current price" column. */
  currentPrice: z.number().positive(),
  /** "SL price". Null when the cell is blank — an unstopped position is a
   *  fact worth recording, not a zero. */
  slPrice: z.number().nullable(),
  /** "TP price". Null when blank. */
  tpPrice: z.number().nullable(),
  /** "Fee", as a POSITIVE number. Colmex prints it negative. */
  fee: z.number(),
  /** "Net P/L" — not stored, used to check the row. */
  netPl: z.number(),
  /** "SL, value" — not stored, used to check the row. Null when there is
   *  no stop. */
  slValue: z.number().nullable(),
});

export const colmexParse = z.object({
  accountLabel: z.string().min(1),
  balance: z.number(),
  /** The "Projected balance" figure. */
  equity: z.number(),
  positions: z.array(colmexPosition),
  /** True when the screenshot does not show the Positions panel at all, or it
   *  is unreadable. Distinct from an empty list, which means a flat book. */
  unreadable: z.boolean(),
  notes: z.string(),
});

export type ColmexParse = z.infer<typeof colmexParse>;
export type ColmexPosition = z.infer<typeof colmexPosition>;

export type RowCheck = {
  symbol: string;
  ok: boolean;
  /** Net P/L recomputed from the other columns. */
  computedNetPl: number;
  netPlDelta: number;
  /** SL,value recomputed from open price and stop. */
  computedSlValue: number | null;
  slValueDelta: number | null;
  problems: string[];
};

/**
 * Recompute what the platform already displays and compare. Two independent
 * checks per row: one ties the price columns to the P/L column, the other ties
 * the stop to the risk column. A single misread digit breaks at least one.
 */
export function checkRow(p: ColmexPosition): RowCheck {
  const dir = p.side === "long" ? 1 : -1;
  const problems: string[] = [];

  const computedNetPl =
    dir * (p.currentPrice - p.openPrice) * p.qty - Math.abs(p.fee);
  const netPlDelta = computedNetPl - p.netPl;
  if (Math.abs(netPlDelta) > TOLERANCE) {
    problems.push(
      `Net P/L does not tie out: (${p.currentPrice} − ${p.openPrice}) × ${p.qty}` +
        `${p.side === "short" ? " × −1" : ""} − ${Math.abs(p.fee)} = ` +
        `${computedNetPl.toFixed(2)}, screen shows ${p.netPl.toFixed(2)}`,
    );
  }

  let computedSlValue: number | null = null;
  let slValueDelta: number | null = null;
  if (p.slPrice != null && p.slValue != null) {
    computedSlValue = Math.abs(p.openPrice - p.slPrice) * p.qty;
    slValueDelta = computedSlValue - p.slValue;
    if (Math.abs(slValueDelta) > TOLERANCE) {
      problems.push(
        `SL,value does not tie out: |${p.openPrice} − ${p.slPrice}| × ${p.qty} = ` +
          `${computedSlValue.toFixed(2)}, screen shows ${p.slValue.toFixed(2)}`,
      );
    }
  }

  // A stop on the wrong side of entry is a misread side or a misread price,
  // not a real position. Neither invariant catches it on its own.
  if (p.slPrice != null) {
    const stopIsBelow = p.slPrice < p.openPrice;
    const plausible =
      p.side === "long"
        ? stopIsBelow || p.slPrice < p.currentPrice
        : !stopIsBelow || p.slPrice > p.currentPrice;
    if (!plausible) {
      problems.push(
        `stop ${p.slPrice} is on the wrong side of a ${p.side} at ${p.openPrice} ` +
          `with price ${p.currentPrice}`,
      );
    }
  }

  return {
    symbol: p.symbol,
    ok: problems.length === 0,
    computedNetPl,
    netPlDelta,
    computedSlValue,
    slValueDelta,
    problems,
  };
}

/**
 * The instruction given to the model. Written to make transcription the whole
 * task: read the cells, do no arithmetic, and never fill a blank. The server
 * checks the numbers afterwards, so a guess here is worse than a refusal —
 * a guess that happens to be self-consistent would pass the check.
 */
export const COLMEX_PROMPT = `Transcribe this Colmex PRO terminal screenshot.

Read values from the cells exactly as displayed. Do not calculate anything, do
not round, and do not correct a figure that looks wrong — report what is on the
screen. Every number you return is checked against the platform's own
arithmetic afterwards, so an invented value fails the check rather than
slipping through.

From the header: the account label, "BALANCE", and "PROJECTED BALANCE"
(as equity).

From the Positions panel, for each row:
- symbol, side (Long or Short), quantity
- "Open price", "Current price", "SL price", "TP price"
- "Fee" as a POSITIVE number, even though it is shown negative
- "Net P/L" and "SL, value", exactly as displayed

Rules:
- A blank or dash in SL price, TP price or SL,value is null. Never substitute
  zero, and never carry a value across from another row.
- If a cell is cut off, blurred, or you are unsure of a digit, set
  "unreadable": true and say which cell in "notes". Do not guess.
- An empty Positions panel is an empty array with "unreadable": false — that
  is a flat book, which is different from not being able to read it.
- Ignore the "Filled orders" and "Positions balance" panels entirely.`;

/** A whole-screenshot verdict, so a caller can accept or reject in one look. */
export function summarise(parse: ColmexParse, checks: RowCheck[]) {
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: !parse.unreadable && failed.length === 0,
    positions: parse.positions.length,
    verified: checks.length - failed.length,
    rejected: failed.length,
    problems: failed.flatMap((f) => f.problems),
  };
}
