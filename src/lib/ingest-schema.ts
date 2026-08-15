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
  notes: z.string().nullable().optional(),
});

export const zoneIn = z.object({
  kind: z.literal("zone"),
  symbol: z.string(),
  direction: z.enum(["supply", "demand"]),
  low: z.number(),
  high: z.number(),
  timeframe: z.string(),
  confluence: z.array(z.string()).default([]),
  status: z
    .enum(["untested", "tested_held", "tested_broken", "expired"])
    .default("untested"),
  note: z.string().nullable().optional(),
  screenshotUrl: z.string().nullable().optional(),
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
      text: z.string(),
      rationale: z.string().nullable().optional(),
      /** Current mark, used to price the cost of delay on repeats. */
      mark: z.number().nullable().optional(),
      qty: z.number().nullable().optional(),
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
  suggestionIn,
  actionItemIn,
  catalystIn,
  runIn,
]);

export type IngestPayload = z.infer<typeof ingestPayload>;
