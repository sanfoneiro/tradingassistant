/**
 * What session a bar belongs to, and whether it is still forming.
 *
 * This exists because the sweep used to *assume* the last daily bar was
 * today's. On the free data plan it is not: a range request through today
 * returns 200 with the series truncated at the prior close. Nothing errored,
 * so `--after-open` priced zones against yesterday and then dropped a
 * completed bar it mistook for a forming one, leaving trend classification
 * two sessions behind while reporting a clean run.
 *
 * The fix is to ask the bar what session it covers rather than assume, and
 * `now` is injectable so the question can be tested in both directions.
 */

const NY = "America/New_York";

type EtParts = { date: string; minutes: number; weekday: number; label: string };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * US and Israeli DST changes land on different dates, so a fixed UTC offset
 * is wrong for a couple of weeks twice a year. "What time is it in New York"
 * never is.
 */
export function etParts(d: Date): EtParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NY,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(d);

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hh = Number(get("hour")) % 24;
  const mm = Number(get("minute"));

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hh * 60 + mm,
    weekday: DAYS.indexOf(get("weekday")),
    label: `${get("weekday")} ${String(hh).padStart(2, "0")}:${get("minute")} ET`,
  };
}

/** The session date a moment falls in, New York time, as YYYY-MM-DD. */
export function etDate(d: Date): string {
  return etParts(d).date;
}

export const OPEN = 9 * 60 + 30; // 09:30 ET
export const CLOSE = 16 * 60; // 16:00 ET

/**
 * Minutes to ADD to a New York wall-clock time to get UTC at that instant:
 * +240 on EDT, +300 on EST. Derived from the clock rather than hardcoded,
 * because the whole point is not to assume an offset.
 */
function etOffsetMinutes(at: Date): number {
  const utcMinutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  let diff = utcMinutes - etParts(at).minutes;
  if (diff < -720) diff += 1440; // the two clocks are on different dates
  if (diff > 720) diff -= 1440;
  return diff;
}

/**
 * Turn a naive New York wall-clock stamp ("2026-08-31T08:30:00", as Finviz
 * publishes it) into a real instant.
 *
 * Two passes, because the offset depends on the date and the date is what we
 * are trying to place. Reading these as UTC would shift every earnings time
 * by four or five hours — enough to move an event across the 48h veto
 * boundary, and silently, since the result still looks like a plausible time.
 */
export function etWallClockToUtc(local: string): Date {
  const asIfUtc = new Date(`${local.replace(" ", "T")}Z`);
  if (Number.isNaN(asIfUtc.getTime())) return asIfUtc;
  const firstGuess = new Date(asIfUtc.getTime() + etOffsetMinutes(asIfUtc) * 60_000);
  return new Date(asIfUtc.getTime() + etOffsetMinutes(firstGuess) * 60_000);
}

export type BarState = {
  /** The session the bar covers, YYYY-MM-DD in New York terms. */
  session: string;
  /** Does the last bar cover the session we are currently in? */
  lastIsToday: boolean;
  /**
   * Is that bar still being written? Only a forming bar may be excluded from
   * level detection — dropping a COMPLETED one silently reruns the engine a
   * session short.
   */
  forming: boolean;
};

/**
 * Daily bars are stamped at midnight ET, so the bar's own timestamp names its
 * session directly.
 */
export function barState(lastBarT: number, now: Date): BarState {
  const bar = etDate(new Date(lastBarT));
  const here = etParts(now);
  const lastIsToday = bar === here.date;
  const weekday = here.weekday >= 1 && here.weekday <= 5;

  return {
    session: bar,
    lastIsToday,
    forming: lastIsToday && weekday && here.minutes < CLOSE,
  };
}
