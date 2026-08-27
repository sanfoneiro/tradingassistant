import { z } from "zod";

/**
 * The contract between the scheduled agents and the app.
 *
 * Rule that governs every payload here: a price without a source and a
 * timestamp is not a price. `mark` is nullable precisely so an agent that
 * cannot reach a trusted source can say so instead of guessing.
 */

const sourceEnum = z.enum([
  "chrome_tradingview",
  "chrome_broker",
  "manual",
  "derived",
]);

const sideEnum = z.enum(["long", "short"]);

export const positionIn = z.object({
  symbol: z.string().min(1),
  side: sideEnum,
  qty: z.number(),
  entry: z.number(),
  stop: z.number().nullable().optional(),
  target: z.number().nullable().optional(),
  mark: z.number().nullable(),
  markSource: sourceEnum.nullable(),
  markAt: z.coerce.date().nullable(),
  /** Commission already charged, as a POSITIVE number. Colmex shows it
   *  negative in the Fee column — send the absolute value. Without this
   *  the app's P/L is gross and will not match the platform. */
  fee: z.number().nullable().optional(),
  openedAt: z.coerce.date().nullable().optional(),
  /** Running high/low water marks while the trade is open. Send the
   *  extreme price seen since the last sync; the app keeps the max. */
  highSinceOpen: z.number().nullable().optional(),
  lowSinceOpen: z.number().nullable().optional(),
});

export const orderIn = z.object({
  symbol: z.string(),
  type: z.string(),
  level: z.number().nullable().optional(),
  qty: z.number().nullable().optional(),
  status: z.string().nullable().optional(),
});

export const accountSync = z.object({
  kind: z.literal("account_sync"),
  agent: z.string().default("morning_sync"),
  account: z.object({
    label: z.string().default("COLH70142"),
    broker: z.string().nullable().optional(),
    balance: z.number().nullable(),
    equity: z.number().nullable(),
    sizingBase: z.number().nullable().optional(),
    source: sourceEnum.nullable(),
  }),
  positions: z.array(positionIn).default([]),
  orders: z.array(orderIn).default([]),
  /** True when the agent could not reach the platform — machine asleep,
   *  Chrome not logged in, session expired. Says so loudly. */
  degraded: z.boolean().default(false),
  /** Positions missing from `positions` are treated as closed. Because a
   *  half-loaded page is indistinguishable from a mass exit, the server
   *  refuses to auto-close more than one position at a time unless this is
   *  explicitly set. Only send it when you have actually verified the
   *  platform shows a flat book. */
  confirmClosures: z.boolean().default(false),
  notes: z.string().nullable().optional(),
});

export const zoneIn = z.object({
    kind: z.literal("zone"),
    symbol: z.string(),
    direction: z.enum(["supply", "demand"]),
    /** Optional when entryLevel + stopLevel are given — the box is derived
     *  from them, so the MTF table can be transcribed column-for-column
     *  without doing arithmetic in the agent. */
    low: z.number().optional(),
    high: z.number().optional(),
    timeframe: z.string(),

    // --- straight off the indicator's table ---
    /** Entry column: proximal edge. */
    entryLevel: z.number().optional(),
    /** 50% column. */
    midLevel: z.number().optional(),
    /** SL column: distal edge plus buffer. A real stop. */
    stopLevel: z.number().optional(),
    /** Dist % column, sign included. */
    distancePct: z.number().nullable().optional(),
    /** State column, verbatim: "Fresh" or "Mitigated". */
    indicatorState: z.string().nullable().optional(),

    confluence: z.array(z.string()).default([]),
    status: z
      .enum(["untested", "tested_held", "tested_broken", "expired"])
      .default("untested"),
    note: z.string().nullable().optional(),
  screenshotUrl: z.string().nullable().optional(),
});

/**
 * A whole symbol/timeframe at once, and the only payload that can REMOVE a
 * zone.
 *
 * Posting zones one at a time can only ever add or update: a level that stops
 * being produced simply stays, so the table grows monotonically and fills with
 * levels for prices — and stocks — that no longer matter. Sending the complete
 * set lets the server retire the rest, and distinguishes the two ways a zone
 * leaves:
 *
 *   tested_broken — price closed through the distal edge. A real event, with a
 *                   direction, that expires anything depending on it.
 *   expired       — no longer tracked. Outside the cap, or the symbol left the
 *                   universe. Nothing happened to the price.
 *
 * Conflating those two would have the sweep quietly killing ideas every time
 * it narrowed its own attention.
 */
export const zoneSetIn = z.object({
  kind: z.literal("zone_set"),
  symbol: z.string().min(1),
  timeframe: z.string(),
  /** Price at computation, so the server derives distance itself rather than
   *  trusting a number that may have been computed against a different bar. */
  price: z.number().positive(),
  live: z
    .array(
      z.object({
        direction: z.enum(["supply", "demand"]),
        entryLevel: z.number(),
        midLevel: z.number(),
        stopLevel: z.number(),
        indicatorState: z.string().nullable().optional(),
      }),
    )
    .default([]),
  /** Zones price has closed through since the last run. */
  broken: z
    .array(
      z.object({
        direction: z.enum(["supply", "demand"]),
        entryLevel: z.number(),
        stopLevel: z.number(),
        /** The bar that did it, and its close. */
        brokenAt: z.coerce.date(),
        closedAt: z.number(),
      }),
    )
    .default([]),
});

export const suggestionIn = z.object({
  kind: z.literal("suggestion"),
  symbol: z.string(),
  side: sideEnum,
  grade: z.enum(["A_plus", "A_minus", "B", "C"]),
  quadrant: z.enum([
    "up_demand",
    "up_supply",
    "down_supply",
    "down_demand",
    "contested",
  ]),
  catalystState: z.enum(["agrees", "drifted_in", "opposes", "stale"]),
  entryMechanic: z.enum([
    "limit_zone_edge",
    "market",
    "trigger_confirmation",
    "breakout",
  ]),
  confluenceCount: z.number().int().nullable().optional(),
  zoneId: z.number().int().nullable().optional(),
  entry: z.number(),
  stop: z.number(),
  target: z.number(),
  rr: z.number(),
  /** Where price actually is, at the moment of grading. Required, because
   *  entry/stop/target/rr only mean anything if price is AT the zone — five
   *  percent away they are a hypothesis, and the server has no other way to
   *  tell the two apart. A name that is not there yet belongs on the
   *  wishlist. */
  currentPrice: z.number().positive(),
  sizeUsd: z.number().nullable().optional(),
  shares: z.number().nullable().optional(),
  gatesPassed: z.array(z.string()).default([]),
  gatesFailed: z.array(z.string()).default([]),
  vetoesCleared: z.array(z.string()).default([]),
  thesis: z.string().nullable().optional(),
  invalidation: z.string().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});

export const actionItemIn = z.object({
  kind: z.literal("action_items"),
  agent: z.string().default("morning_sync"),
  items: z.array(
    z.object({
      kind: z.string(), // close | move_stop | adjust_tp | open | review
      symbol: z.string().nullable().optional(),
      /** A short slug the agent controls, stable across runs for the SAME
       *  recommendation — `ssb-hold-stop`, `cbre-concentration`. Supplying it
       *  makes identity an assertion instead of a guess, which is what the
       *  server got wrong twice. Without it the server falls back to
       *  (symbol, kind), then to a text-similarity check. */
      key: z.string().nullable().optional(),
      text: z.string(),
      rationale: z.string().nullable().optional(),
      /** Current mark, used to price the cost of delay on repeats. */
      mark: z.number().nullable().optional(),
      qty: z.number().nullable().optional(),
    }),
  ),
});

/** A name worth watching but not yet tradeable. Upserts on symbol. */
export const wishlistIn = z.object({
  kind: z.literal("wishlist"),
  items: z.array(
    z.object({
      symbol: z.string().min(1),
      side: sideEnum.nullable().optional(),
      thesis: z.string().nullable().optional(),
      zoneId: z.number().int().nullable().optional(),
      /** What has to happen — in words, for the human. */
      triggerNote: z.string().nullable().optional(),
      /** The price that turns watching into a setup. */
      triggerLevel: z.number().nullable().optional(),
      /** % away at the time of screening. */
      distancePct: z.number().nullable().optional(),
      /** How the zone reads against the trend, and the structural rank the
       *  sweep computed. Ordering only — never a grade. */
      quadrant: z
        .enum(["up_demand", "up_supply", "down_supply", "down_demand", "contested"])
        .nullable()
        .optional(),
      score: z.number().nullable().optional(),
      scoreReasons: z.array(z.string()).optional(),
      priority: z.number().int().min(1).max(5).optional(),
      /** Send false to retire an entry whose zone broke or thesis died. */
      active: z.boolean().optional(),
    }),
  ),
});

/**
 * The weekly universe refresh: just the names on the saved screen. No
 * charts, no analysis, no prices — a list.
 *
 * This is deliberately its own payload because reading names out of the
 * screener DOM is reliable, while reading charts is not. Separating them
 * means the list stays current even when charting is broken.
 */
export const universeIn = z.object({
  kind: z.literal("universe"),
  /** Which saved screen this came from, for the record. */
  screen: z.string().default("EMA 200"),
  symbols: z.array(z.string().min(1)),
  /** Names no longer on the screen — dropped from the queue. */
  removed: z.array(z.string()).default([]),
});

/**
 * The fast pass: every symbol whose charts were actually READ this run,
 * whether or not it survived. Recording the rejects is the point — it is
 * what lets the next run rotate to names nobody has looked at instead of
 * re-reading the top of the list forever.
 */
export const screenerPassIn = z.object({
  kind: z.literal("screener_pass"),
  symbols: z.array(
    z.object({
      symbol: z.string().min(1),
      distancePct: z.number().nullable().optional(),
      nearZone: z.boolean().default(false),
      trend: z.enum(["uptrend", "downtrend", "contested"]).nullable().optional(),
      /** 14-day average daily range in dollars. The noise band — what tells a
       *  free stop move from one that gets hit by an ordinary day. */
      adr: z.number().nullable().optional(),
      note: z.string().nullable().optional(),
    }),
  ),
});

export const catalystIn = z.object({
  kind: z.literal("catalysts"),
  items: z.array(
    z.object({
      symbol: z.string().nullable(),
      kind: z.string(),
      eventAt: z.coerce.date(),
      note: z.string().nullable().optional(),
    }),
  ),
});

export const runIn = z.object({
  kind: z.literal("run"),
  agent: z.string(),
  status: z.enum(["ok", "degraded", "failed"]),
  degraded: z.boolean().default(false),
  notes: z.string().nullable().optional(),
});

export const ingestPayload = z.discriminatedUnion("kind", [
  accountSync,
  zoneIn,
  zoneSetIn,
  suggestionIn,
  actionItemIn,
  wishlistIn,
  universeIn,
  screenerPassIn,
  catalystIn,
  runIn,
]);

export type IngestPayload = z.infer<typeof ingestPayload>;
