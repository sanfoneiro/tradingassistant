import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ *
 * Controlled vocabularies
 *
 * Single-valued tags live as enum COLUMNS on `trades` — group-by is
 * trivial and the DB rejects typos. Multi-valued tags (mistakes, and
 * anything added later) live in `tags` + `tradeTags`.
 *
 * The first four are emitted automatically by the trade-setup-grader
 * skill at entry. Nothing is typed by hand.
 * ------------------------------------------------------------------ */

export const quadrantEnum = pgEnum("quadrant", [
  "up_demand", // uptrend at demand   — with-trend long  (strong)
  "up_supply", // uptrend at supply   — countertrend short (weak)
  "down_supply", // downtrend at supply — with-trend short (strong)
  "down_demand", // downtrend at demand — countertrend long (weak)
  "contested", // price/MA slope disagree — treat as no trend
]);

export const gradeEnum = pgEnum("grade", ["A_plus", "A_minus", "B", "C"]);

export const catalystStateEnum = pgEnum("catalyst_state", [
  "agrees",
  "drifted_in",
  "opposes",
  "stale",
]);

export const entryMechanicEnum = pgEnum("entry_mechanic", [
  "limit_zone_edge",
  "market",
  "trigger_confirmation",
  "breakout",
]);

export const exitReasonEnum = pgEnum("exit_reason", [
  "target_hit",
  "stop_hit",
  "time_stop",
  "thesis_broken",
  "discretionary",
  "trailed_out",
  "gapped",
]);

export const executionEnum = pgEnum("execution", [
  "followed_plan",
  "deviated_entry",
  "deviated_exit",
  "exited_early",
  "exited_late",
  "no_exit_plan",
]);

export const regimeEnum = pgEnum("regime", [
  "risk_on",
  "risk_off",
  "pre_fomc",
  "post_cpi",
  "earnings_season",
  "thin_summer",
]);

export const emotionEnum = pgEnum("emotion", [
  "confident",
  "fomo",
  "hesitant",
  "revenge",
  "bored",
  "anxious",
]);

export const tradeStatusEnum = pgEnum("trade_status", [
  "idea",
  "graded",
  "waiting_for_trigger",
  "triggered",
  "open",
  "pending_review",
  "closed",
]);

export const zoneStatusEnum = pgEnum("zone_status", [
  "untested",
  "tested_held",
  "tested_broken",
  "expired",
]);

export const ruleTypeEnum = pgEnum("rule_type", ["gate", "veto", "sizing"]);

export const sideEnum = pgEnum("side", ["long", "short"]);

/** Where a number came from. Nothing enters this DB without one. */
export const markSourceEnum = pgEnum("mark_source", [
  "chrome_tradingview",
  "chrome_broker",
  "manual",
  "derived",
]);

/* ------------------------------------------------------------------ *
 * Account
 * ------------------------------------------------------------------ */

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  broker: text("broker"),
  balance: doublePrecision("balance"),
  equity: doublePrecision("equity"),
  /** Base used for position sizing. 1% of this is the risk budget. */
  sizingBase: doublePrecision("sizing_base"),
  source: markSourceEnum("source"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const positions = pgTable(
  "positions",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id").references(() => accounts.id),
    symbol: text("symbol").notNull(),
    side: sideEnum("side").notNull(),
    qty: doublePrecision("qty").notNull(),
    entry: doublePrecision("entry").notNull(),
    stop: doublePrecision("stop"),
    target: doublePrecision("target"),

    mark: doublePrecision("mark"),
    markSource: markSourceEnum("mark_source"),
    markAt: timestamp("mark_at", { withTimezone: true }),

    /** Commission the broker has already charged, as a positive number.
     *  Without it the app's P/L is gross and never ties out to the
     *  platform — which is the one thing this app must not do. */
    fee: doublePrecision("fee").default(0),

    pl: doublePrecision("pl"),
    plPct: doublePrecision("pl_pct"),

    /** CAPITAL AT RISK: what is actually lost if the stop fills, measured
     *  from entry. Clamped at zero — a stop past breakeven is a locked
     *  gain, not risk, and taking an absolute value here reports a
     *  guaranteed profit as danger. */
    riskUsd: doublePrecision("risk_usd"),

    /** RISK FROM HERE: what equity drops by if the stop fills today,
     *  measured from the current mark. This is the number a decision
     *  hangs on. On an aged book it diverges hard from riskUsd — a
     *  position deep underwater with a nearby stop has enormous entry
     *  risk and almost nothing left to lose. */
    riskFromMark: doublePrecision("risk_from_mark"),

    /** Set when the stop sits past breakeven: the profit guaranteed even
     *  if the stop fills. Positive means this position cannot lose. */
    lockedGain: doublePrecision("locked_gain"),

    /** Running water marks, updated by the sync agents while open.
     *  These cannot be reconstructed after the fact — capture or lose. */
    maeRunning: doublePrecision("mae_running"),
    mfeRunning: doublePrecision("mfe_running"),

    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    isOpen: boolean("is_open").default(true).notNull(),
  },
  (t) => [index("positions_symbol_idx").on(t.symbol)],
);

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").references(() => accounts.id),
  symbol: text("symbol").notNull(),
  type: text("type").notNull(), // limit | stop | tp
  level: doublePrecision("level"),
  qty: doublePrecision("qty"),
  status: text("status"), // working | filled | cancelled
  placedAt: timestamp("placed_at", { withTimezone: true }),
});

/* ------------------------------------------------------------------ *
 * Zones & wishlist
 * ------------------------------------------------------------------ */

export const zones = pgTable(
  "zones",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    direction: text("direction").notNull(), // supply | demand
    low: doublePrecision("low").notNull(),
    high: doublePrecision("high").notNull(),
    timeframe: text("timeframe").notNull(), // daily | weekly | 4h ...
    status: zoneStatusEnum("status").default("untested").notNull(),
    testCount: integer("test_count").default(0).notNull(),
    /** Independent things stacked at this price: weekly zone, daily zone,
     *  MA, prior breakdown shelf. Count them; the Method report asks
     *  whether confluence actually predicts anything. */
    confluence: jsonb("confluence").$type<string[]>().default([]),
    screenshotUrl: text("screenshot_url"),
    note: text("note"),
    drawnAt: timestamp("drawn_at", { withTimezone: true }).defaultNow(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  },
  (t) => [index("zones_symbol_idx").on(t.symbol)],
);

export const wishlist = pgTable(
  "wishlist",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    side: sideEnum("side"),
    thesis: text("thesis"),
    zoneId: integer("zone_id").references(() => zones.id),
    /** Machine-checkable, not a note: what has to happen to make this live. */
    triggerNote: text("trigger_note"),
    /** Price that turns this from watching into a setup. The Zone Watcher
     *  measures distance against this. */
    triggerLevel: doublePrecision("trigger_level"),
    /** Distance from the trigger at the last screen, in %. Lets the
     *  watchlist sort by "closest to going live". */
    distancePct: doublePrecision("distance_pct"),
    priority: integer("priority").default(3),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [uniqueIndex("wishlist_symbol_idx").on(t.symbol)],
);

/**
 * Which screener symbols have been looked at and when.
 *
 * The universe lives in Oron's saved TradingView screen, not here — the app
 * only remembers what it has already seen, so a run can ask "which have I
 * not looked at longest?" and rotate through the list instead of
 * re-examining the same large-caps at the top every session.
 */
export const screenerCoverage = pgTable(
  "screener_coverage",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    lastScreenedAt: timestamp("last_screened_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Distance to the nearest zone at that screening, in %. */
    distancePct: doublePrecision("distance_pct"),
    /** Did it survive the fast pass into full grading? */
    nearZone: boolean("near_zone").default(false).notNull(),
    trend: text("trend"), // uptrend | downtrend | contested
    note: text("note"),
    timesScreened: integer("times_screened").default(1).notNull(),
  },
  (t) => [uniqueIndex("screener_coverage_symbol_idx").on(t.symbol)],
);

/* ------------------------------------------------------------------ *
 * Suggestions — the skill's verdict, stored
 * ------------------------------------------------------------------ */

export const suggestions = pgTable("suggestions", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  side: sideEnum("side").notNull(),

  grade: gradeEnum("grade"),
  quadrant: quadrantEnum("quadrant"),
  catalystState: catalystStateEnum("catalyst_state"),
  entryMechanic: entryMechanicEnum("entry_mechanic"),
  confluenceCount: integer("confluence_count"),
  zoneId: integer("zone_id").references(() => zones.id),

  entry: doublePrecision("entry"),
  stop: doublePrecision("stop"),
  target: doublePrecision("target"),
  rr: doublePrecision("rr"),
  sizeUsd: doublePrecision("size_usd"),
  shares: doublePrecision("shares"),

  gatesPassed: jsonb("gates_passed").$type<string[]>().default([]),
  gatesFailed: jsonb("gates_failed").$type<string[]>().default([]),
  vetoesCleared: jsonb("vetoes_cleared").$type<string[]>().default([]),

  thesis: text("thesis"),
  invalidation: text("invalidation"),

  status: text("status").default("open").notNull(), // open | expired | taken | rejected
  taken: boolean("taken").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

/* ------------------------------------------------------------------ *
 * Trades — the journal core
 * ------------------------------------------------------------------ */

export const trades = pgTable(
  "trades",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    side: sideEnum("side").notNull(),
    status: tradeStatusEnum("status").default("idea").notNull(),
    suggestionId: integer("suggestion_id").references(() => suggestions.id),
    zoneId: integer("zone_id").references(() => zones.id),
    /** True when Oron found it himself rather than taking a suggestion.
     *  Powers the shadow book: does the system actually add anything? */
    selfGenerated: boolean("self_generated").default(false).notNull(),

    // --- skill-emitted tags (automatic, at entry) ---
    quadrant: quadrantEnum("quadrant"),
    grade: gradeEnum("grade"),
    catalystState: catalystStateEnum("catalyst_state"),
    entryMechanic: entryMechanicEnum("entry_mechanic"),
    confluenceCount: integer("confluence_count"),
    regime: regimeEnum("regime"),

    // --- planned ---
    entryPlanned: doublePrecision("entry_planned"),
    stopPlanned: doublePrecision("stop_planned"),
    targetPlanned: doublePrecision("target_planned"),
    rrPlanned: doublePrecision("rr_planned"),
    riskUsdPlanned: doublePrecision("risk_usd_planned"),
    riskPctOfBase: doublePrecision("risk_pct_of_base"),
    sharesPlanned: doublePrecision("shares_planned"),

    // --- actual ---
    entryActual: doublePrecision("entry_actual"),
    exitActual: doublePrecision("exit_actual"),
    stopFinal: doublePrecision("stop_final"),
    qty: doublePrecision("qty"),
    fees: doublePrecision("fees").default(0),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    // --- derived (computed on close; see lib/metrics.ts) ---
    plUsd: doublePrecision("pl_usd"),
    plPct: doublePrecision("pl_pct"),
    /** P&L ÷ initial risk. The master normalizer — every cross-trade
     *  comparison in the app is in R, never in dollars. */
    rMultiple: doublePrecision("r_multiple"),
    rrActual: doublePrecision("rr_actual"),
    slippageEntryR: doublePrecision("slippage_entry_r"),
    slippageExitR: doublePrecision("slippage_exit_r"),
    /** Max adverse excursion in R — how close this got to stopping out.
     *  Tells you whether the stop sits inside the noise band. */
    maeR: doublePrecision("mae_r"),
    /** Max favourable excursion in R — what the market actually offered.
     *  This is the QQQ story: target $2 beyond the available move. */
    mfeR: doublePrecision("mfe_r"),
    /** pl ÷ mfe — how much of the available move was captured. */
    efficiency: doublePrecision("efficiency"),
    adrAtEntry: doublePrecision("adr_at_entry"),
    stopWidthInAdr: doublePrecision("stop_width_in_adr"),
    /** Did we buy three dollars above the boundary? Negative = inside. */
    distFromZoneEdgePct: doublePrecision("dist_from_zone_edge_pct"),
    holdDays: doublePrecision("hold_days"),
    holdSessions: integer("hold_sessions"),
    dayOfWeek: integer("day_of_week"),

    // --- review (set at close) ---
    exitReason: exitReasonEnum("exit_reason"),
    execution: executionEnum("execution"),
    emotion: emotionEnum("emotion"),

    // --- compliance ---
    rulesFollowed: jsonb("rules_followed").$type<number[]>().default([]),
    rulesViolated: jsonb("rules_violated").$type<number[]>().default([]),
    adherenceScore: doublePrecision("adherence_score"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("trades_symbol_idx").on(t.symbol),
    index("trades_status_idx").on(t.status),
    index("trades_closed_idx").on(t.closedAt),
  ],
);

/* ------------------------------------------------------------------ *
 * Tags — multi-valued controlled vocabulary (mistakes, and future groups)
 * Tags are ENUMS, never free text. Notes are free text. Mixing the two
 * is how a journal's analytics rot inside a month.
 * ------------------------------------------------------------------ */

export const tags = pgTable(
  "tags",
  {
    id: serial("id").primaryKey(),
    group: text("group").notNull(), // mistake | custom groups later
    value: text("value").notNull(), // machine key
    label: text("label").notNull(), // human label
    note: text("note"), // where this came from
    active: boolean("active").default(true).notNull(),
  },
  (t) => [uniqueIndex("tags_group_value_idx").on(t.group, t.value)],
);

export const tradeTags = pgTable(
  "trade_tags",
  {
    tradeId: integer("trade_id")
      .references(() => trades.id, { onDelete: "cascade" })
      .notNull(),
    tagId: integer("tag_id")
      .references(() => tags.id)
      .notNull(),
  },
  (t) => [uniqueIndex("trade_tags_idx").on(t.tradeId, t.tagId)],
);

/* ------------------------------------------------------------------ *
 * Journal — the six required fields plus narrative
 * ------------------------------------------------------------------ */

export const journal = pgTable("journal", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id")
    .references(() => trades.id, { onDelete: "cascade" })
    .notNull(),
  playbookEntry: text("playbook_entry"),
  playbookExit: text("playbook_exit"),
  whatWorked: text("what_worked").notNull(),
  whatFailed: text("what_failed").notNull(),
  lesson: text("lesson").notNull(),
  /** Third time a lesson is flagged recurring, it gets promoted to a
   *  candidate rule and shows up in the weekly review. */
  recurring: boolean("recurring").default(false).notNull(),
  screenshotBefore: text("screenshot_before"),
  screenshotAfter: text("screenshot_after"),
  writtenAt: timestamp("written_at", { withTimezone: true }).defaultNow(),
});

/* ------------------------------------------------------------------ *
 * Action items — with the cost-of-delay counter
 * ------------------------------------------------------------------ */

export const actionItems = pgTable("action_items", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(), // close | move_stop | adjust_tp | open | review
  symbol: text("symbol"),
  text: text("text").notNull(),
  rationale: text("rationale"),

  firstRaisedAt: timestamp("first_raised_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  lastRaisedAt: timestamp("last_raised_at", { withTimezone: true }).defaultNow(),
  /** Nine consecutive briefs saying "close NKE" is not advice, it's a
   *  broken loop. This number is what makes that visible. */
  timesRepeated: integer("times_repeated").default(1).notNull(),

  markAtFirstRaise: doublePrecision("mark_at_first_raise"),
  qtyAtFirstRaise: doublePrecision("qty_at_first_raise"),
  /** Recomputed every sync: what waiting has cost so far, in dollars. */
  costOfDelayUsd: doublePrecision("cost_of_delay_usd").default(0),

  status: text("status").default("open").notNull(), // open | done | dropped
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

/* ------------------------------------------------------------------ *
 * Rules — gates, vetoes, sizing. Versioned, and grown from journal
 * lessons rather than written once and forgotten.
 * ------------------------------------------------------------------ */

export const rules = pgTable("rules", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  text: text("text").notNull(),
  type: ruleTypeEnum("type").notNull(),
  version: integer("version").default(1).notNull(),
  activeFrom: timestamp("active_from", { withTimezone: true }).defaultNow(),
  active: boolean("active").default(true).notNull(),
  /** Set when a recurring lesson got promoted into a rule. */
  originJournalId: integer("origin_journal_id"),
  note: text("note"),
});

/* ------------------------------------------------------------------ *
 * Price marks & catalysts
 * ------------------------------------------------------------------ */

export const priceMarks = pgTable(
  "price_marks",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    price: doublePrecision("price").notNull(),
    source: markSourceEnum("source").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /** 1.0 = read directly off the platform. Lower = corroborated or stale. */
    confidence: doublePrecision("confidence").default(1).notNull(),
    note: text("note"),
  },
  (t) => [index("price_marks_symbol_idx").on(t.symbol, t.capturedAt)],
);

export const catalysts = pgTable("catalysts", {
  id: serial("id").primaryKey(),
  symbol: text("symbol"), // null = macro
  kind: text("kind").notNull(), // earnings | cpi | fomc | ppi | other
  eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
  note: text("note"),
});

/* ------------------------------------------------------------------ *
 * Runs — so a skipped agent is loud, not silent
 * ------------------------------------------------------------------ */

export const runs = pgTable("runs", {
  id: serial("id").primaryKey(),
  agent: text("agent").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull(), // ok | degraded | failed
  /** True when the agent could not reach a trusted source — e.g. the
   *  machine was asleep, or Chrome was not logged in. */
  degraded: boolean("degraded").default(false).notNull(),
  marksWritten: integer("marks_written").default(0),
  notes: text("notes"),
});
