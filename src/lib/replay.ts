/**
 * Replaying a signal against the bars that came after it.
 *
 * A trade needs six judgment fields nobody but Oron can write. A signal that
 * was never taken needs none of them: did price reach the entry, and then did
 * it reach the target or the stop first. Both are facts about the tape.
 *
 * That is the whole point. It means every idea can be scored, not just the
 * ones that became positions — including the ones a veto BLOCKED, which is
 * the only way to find out whether the vetoes are any good.
 *
 * What this cannot do, and must not pretend to:
 *
 *   - **Intraday sequence.** A daily bar says a price traded, never when. If
 *     one bar's range covers both stop and target, the outcome is genuinely
 *     unknowable and is reported as `ambiguous` rather than guessed. Folding
 *     those into wins or losses would bias the result invisibly, and if they
 *     are common the whole measurement is weak and you need to know that.
 *   - **Fills.** A touch is treated as a fill, by decision. Reality is worse:
 *     a limit at the top of a zone that trades one cent through it may or may
 *     not fill. This replay is therefore optimistic, and consistently so.
 *   - **Slippage.** Exits are assumed at the stop or target price exactly.
 *     Real stops slip — ZS slipped a dollar past $189 at the open.
 */

export type Bar = { t: number; o: number; h: number; l: number; c: number };

export type Signal = {
  symbol: string;
  side: "long" | "short";
  /** The entry zone. A single price is expressed as low === high. */
  entryLow: number;
  entryHigh: number;
  stop: number;
  target: number;
};

export type Resolution =
  | "never_triggered"
  | "hit_target"
  | "hit_stop"
  | "ambiguous"
  /** One move carried price through the entry AND past the stop. The fill and
   *  the exit are both unknowable from a daily bar, so this is counted on its
   *  own rather than as a loss — but it is the real cost of a resting order,
   *  and the reason rule 6 exists. */
  | "gapped_through"
  | "unresolved"
  /** A level that is not a finite number, or sits on the wrong side of the
   *  fill. Refused rather than computed — this is a parse error surfacing,
   *  and a confident number here is worse than none. */
  | "bad_input";

export type ReplayResult = {
  resolution: Resolution;
  /** Where the entry would have filled. Null when it never triggered. */
  entryPrice: number | null;
  /** Index into the bars array where it filled. */
  triggerIdx: number | null;
  exitPrice: number | null;
  exitIdx: number | null;
  barsToTrigger: number | null;
  barsHeld: number | null;
  /** P/L in R, gross. +2 means it made twice what it risked. */
  rGross: number | null;
  /** Gross R less the round-trip commission, expressed in R at the given
   *  risk budget. Null when no budget is supplied. */
  rNet: number | null;
  note: string;
};

export type ReplayOpts = {
  /** Sessions the signal has to reach its entry before it is abandoned. */
  triggerWindow?: number;
  /** Sessions after filling to reach target or stop. */
  resolveWindow?: number;
  /** Round-trip commission in dollars, for rNet. */
  fees?: number;
  /** Dollar risk budget the R is expressed against, for rNet. */
  riskBudget?: number;
};

export const DEFAULT_TRIGGER_WINDOW = 10;
export const DEFAULT_RESOLVE_WINDOW = 20;

/**
 * Where a resting order in the zone would fill on a bar that reaches it.
 *
 * Approaching from outside, the first price touched is the near edge — the
 * top of the zone for a long coming down, the bottom for a short coming up.
 * A bar that opens inside the zone fills at the open, and one that gaps clean
 * through fills at the open too, which is better than the order asked for and
 * is what actually happens.
 */
export function fillPrice(
  side: "long" | "short",
  bar: Bar,
  entryLow: number,
  entryHigh: number,
): number | null {
  if (side === "long") {
    if (bar.l > entryHigh) return null; // never came down to it
    return Math.min(bar.o, entryHigh);
  }
  if (bar.h < entryLow) return null; // never came up to it
  return Math.max(bar.o, entryLow);
}

/** Did this bar reach the level, in the direction that matters? */
function reached(side: "long" | "short", bar: Bar, level: number, kind: "stop" | "target") {
  const down = (side === "long") === (kind === "stop");
  return down ? bar.l <= level : bar.h >= level;
}

export function replaySignal(
  s: Signal,
  bars: Bar[],
  opts: ReplayOpts = {},
): ReplayResult {
  const triggerWindow = opts.triggerWindow ?? DEFAULT_TRIGGER_WINDOW;
  const resolveWindow = opts.resolveWindow ?? DEFAULT_RESOLVE_WINDOW;

  const none: ReplayResult = {
    resolution: "never_triggered",
    entryPrice: null,
    triggerIdx: null,
    exitPrice: null,
    exitIdx: null,
    barsToTrigger: null,
    barsHeld: null,
    rGross: null,
    rNet: null,
    note: `entry ${s.entryLow}-${s.entryHigh} not reached within ${triggerWindow} sessions`,
  };

  // Refuse non-finite levels outright. A NaN sails through every comparison
  // below as `false`, so without this a misparsed entry produces a confident
  // "hit_stop" with no entry price — which is exactly the class of plausible
  // wrong number this project exists to stop.
  const levels = { entryLow: s.entryLow, entryHigh: s.entryHigh, stop: s.stop, target: s.target };
  const bad = Object.entries(levels).filter(([, v]) => !Number.isFinite(v));
  if (bad.length)
    return {
      ...none,
      resolution: "bad_input",
      note: `not a number: ${bad.map(([k]) => k).join(", ")} — check the parse`,
    };

  if (!bars.length) return { ...none, note: "no bars after the signal date" };

  // --- 1. did price come to the entry? ---
  let triggerIdx: number | null = null;
  let entryPrice: number | null = null;
  const searchTo = Math.min(bars.length, triggerWindow);
  for (let i = 0; i < searchTo; i++) {
    const f = fillPrice(s.side, bars[i], s.entryLow, s.entryHigh);
    if (f != null) {
      triggerIdx = i;
      entryPrice = f;
      break;
    }
  }
  if (triggerIdx == null || entryPrice == null) return none;

  const riskPerShare = Math.abs(entryPrice - s.stop);
  const feeR =
    opts.fees != null && opts.riskBudget
      ? opts.fees / opts.riskBudget
      : null;

  const settle = (
    resolution: Resolution,
    exitPrice: number | null,
    exitIdx: number | null,
    note: string,
  ): ReplayResult => {
    const dir = s.side === "long" ? 1 : -1;
    const rGross =
      exitPrice != null && riskPerShare > 0
        ? (dir * (exitPrice - entryPrice!)) / riskPerShare
        : null;
    return {
      resolution,
      entryPrice,
      triggerIdx,
      exitPrice,
      exitIdx,
      barsToTrigger: triggerIdx,
      barsHeld: exitIdx == null ? null : exitIdx - triggerIdx!,
      rGross,
      rNet: rGross != null && feeR != null ? rGross - feeR : null,
      note,
    };
  };

  // The fill can land on the wrong side of the stop for two very different
  // reasons, and collapsing them would hide the interesting one.
  const dir = s.side === "long" ? 1 : -1;
  if (dir * (entryPrice - s.stop) <= 0) {
    // Did one move carry price through the whole zone AND past the stop? Then
    // this is a gap, not a bad level — the order filled and was already beyond
    // its own invalidation before anything could be done about it.
    const gapped =
      s.side === "long" ? entryPrice < s.entryLow : entryPrice > s.entryHigh;
    return settle(
      gapped ? "gapped_through" : "bad_input",
      null,
      triggerIdx,
      gapped
        ? `gapped through: filled at ${entryPrice.toFixed(2)}, already past the ${s.stop} stop. ` +
          `A resting order was beyond its own invalidation before the session opened — ` +
          `the size of the loss is not knowable from a daily bar`
        : `stop ${s.stop} is not on the losing side of a ${s.side} filled at ${entryPrice.toFixed(2)} — level looks misparsed`,
    );
  }
  if (dir * (s.target - entryPrice) <= 0)
    return settle(
      "bad_input",
      null,
      null,
      `target ${s.target} is not on the winning side of a ${s.side} filled at ${entryPrice.toFixed(2)} — level looks misparsed`,
    );

  // --- 2. target or stop first? The fill bar counts: a signal can trigger
  //        and resolve the same session. ---
  const lastIdx = Math.min(bars.length - 1, triggerIdx + resolveWindow);
  for (let i = triggerIdx; i <= lastIdx; i++) {
    const bar = bars[i];
    const hitStop = reached(s.side, bar, s.stop, "stop");
    const hitTarget = reached(s.side, bar, s.target, "target");

    if (hitStop && hitTarget)
      return settle(
        "ambiguous",
        null,
        i,
        `both ${s.stop} and ${s.target} inside one session's range — a daily bar cannot say which came first`,
      );
    if (hitStop) return settle("hit_stop", s.stop, i, `stopped at ${s.stop}`);
    if (hitTarget) return settle("hit_target", s.target, i, `target ${s.target} reached`);
  }

  return settle(
    "unresolved",
    null,
    null,
    `neither level reached within ${resolveWindow} sessions of filling`,
  );
}

/** Aggregate, with the unknowables kept visible rather than absorbed. */
export function summariseReplays(rs: ReplayResult[]) {
  const triggered = rs.filter((r) => r.triggerIdx != null);
  const wins = rs.filter((r) => r.resolution === "hit_target");
  const losses = rs.filter((r) => r.resolution === "hit_stop");
  const decided = wins.length + losses.length;
  const rNets = [...wins, ...losses]
    .map((r) => r.rNet ?? r.rGross)
    .filter((r): r is number => r != null);

  return {
    n: rs.length,
    neverTriggered: rs.filter((r) => r.resolution === "never_triggered").length,
    triggered: triggered.length,
    wins: wins.length,
    losses: losses.length,
    ambiguous: rs.filter((r) => r.resolution === "ambiguous").length,
    gappedThrough: rs.filter((r) => r.resolution === "gapped_through").length,
    unresolved: rs.filter((r) => r.resolution === "unresolved").length,
    /** Parse failures. Not a result — a reason to distrust the batch. */
    badInput: rs.filter((r) => r.resolution === "bad_input").length,
    /** Of the ones that actually resolved. Undecided cases are excluded
     *  rather than counted as losses — say the count instead. */
    winRate: decided ? wins.length / decided : null,
    totalR: rNets.length ? rNets.reduce((a, b) => a + b, 0) : null,
    avgR: rNets.length ? rNets.reduce((a, b) => a + b, 0) / rNets.length : null,
  };
}
