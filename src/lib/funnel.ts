/**
 * Where one stage of the funnel ends and the next begins.
 *
 *   zone      a fact about the chart
 *   wishlist  a zone worth waiting for — a trigger, and no R:R
 *   idea      price has arrived, so entry, stop, target and R:R are real
 *   trade     taken
 *
 * Two thresholds separate them, and both live here rather than in the route
 * that happens to enforce them. `chart-zones` drew these lines first and was
 * right; the app now holds one copy of each.
 */

/** Inside this band the numbers mean something, so a suggestion is allowed
 *  and a wishlist entry counts as triggered. Beyond it, entry/stop/target/rr
 *  are a hypothesis. */
export const TRIGGER_BAND_PCT = 2;

/** Wide enough to be worth watching, not close enough to grade. */
export const WATCH_BAND_PCT = 6;

/** Is price close enough to this level for the numbers to be real? */
export function atTrigger(distancePct: number | null | undefined): boolean {
  return distancePct != null && Math.abs(distancePct) <= TRIGGER_BAND_PCT;
}

/** Worth carrying on the wishlist at all. */
export function worthWatching(distancePct: number | null | undefined): boolean {
  return distancePct != null && Math.abs(distancePct) <= WATCH_BAND_PCT;
}

/**
 * When a wishlist entry crosses into the trigger band it is stamped, and the
 * stamp survives while it stays there — so "at its trigger since Tuesday and
 * still not graded" is answerable. Drifting back out clears it, because the
 * next arrival is a new event, not a continuation of the old one.
 *
 * Computed at the single door into the table so every writer agrees, rather
 * than left to whichever agent happens to be posting.
 */
export function triggerStamp(
  distancePct: number | null | undefined,
  previous: Date | null,
  now: Date = new Date(),
): Date | null {
  if (!atTrigger(distancePct)) return null;
  return previous ?? now;
}

/** How long a name has been sitting at its trigger, in whole days. */
export function daysWaiting(since: Date | null, now: Date = new Date()): number | null {
  if (!since) return null;
  return Math.floor((now.getTime() - since.getTime()) / 86_400_000);
}
