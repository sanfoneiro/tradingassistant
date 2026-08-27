import { describe, it, expect } from "vitest";
import { etDate, etParts, barState, etWallClockToUtc, CLOSE } from "./session";

/**
 * These fixtures are real timestamps taken from the API, not invented ones.
 * A daily bar for 2026-08-26 came back stamped 1787716800000 — midnight ET,
 * not midnight UTC — and the whole question this file answers depends on
 * that convention, so the test asserts it before asserting anything else.
 */
const BAR_2026_08_26 = 1787716800000; // per-ticker aggregate, session start
const BAR_2026_08_27 = BAR_2026_08_26 + 86_400_000;

describe("etDate", () => {
  it("reads a daily bar stamp as the session it covers, not the UTC date", () => {
    // 04:00Z is midnight ET. A naive UTC read gets this right; the case that
    // separates them is the evening, below.
    expect(new Date(BAR_2026_08_26).toISOString()).toBe("2026-08-26T04:00:00.000Z");
    expect(etDate(new Date(BAR_2026_08_26))).toBe("2026-08-26");
  });

  it("puts a US evening moment in that day's session, not the next UTC day", () => {
    // 2026-08-26 21:00 ET = 2026-08-27 01:00Z. The UTC date has already
    // rolled over; the trading session has not.
    const evening = new Date("2026-08-27T01:00:00Z");
    expect(evening.toISOString().slice(0, 10)).toBe("2026-08-27");
    expect(etDate(evening)).toBe("2026-08-26");
  });
});

describe("barState", () => {
  it("calls the bar forming when it is today's and the market is still open", () => {
    // Thu 2026-08-27, 11:00 ET — inside the after-open window.
    const now = new Date("2026-08-27T15:00:00Z");
    expect(etParts(now).minutes).toBeLessThan(CLOSE);

    const s = barState(BAR_2026_08_27, now);
    expect(s.session).toBe("2026-08-27");
    expect(s.lastIsToday).toBe(true);
    expect(s.forming).toBe(true);
  });

  it("does NOT call today's bar forming once the session has closed", () => {
    // Thu 2026-08-27, 18:10 ET — when the evening sweep runs. The bar is
    // today's and complete; dropping it would rerun the engine a day short.
    const now = new Date("2026-08-27T22:10:00Z");
    expect(etParts(now).minutes).toBeGreaterThan(CLOSE);

    const s = barState(BAR_2026_08_27, now);
    expect(s.lastIsToday).toBe(true);
    expect(s.forming).toBe(false);
  });

  /**
   * The regression. This is the exact live state: the free plan cannot see
   * today, so mid-session the newest bar is the PRIOR close. The old code
   * did `afterOpen ? daily.slice(0, -1) : daily` and threw that completed
   * bar away, which is how trend classification ended up two sessions behind
   * while the run reported clean.
   */
  it("does not treat yesterday's completed bar as today's forming one", () => {
    const now = new Date("2026-08-27T15:00:00Z"); // Thu 11:00 ET, mid-session
    const s = barState(BAR_2026_08_26, now); // newest bar is Wednesday's

    expect(s.session).toBe("2026-08-26");
    expect(s.lastIsToday).toBe(false);
    expect(s.forming).toBe(false); // must not be dropped from the settled set
  });

  it("does not call a stale bar forming on a weekend", () => {
    // Sat 2026-08-29, 11:00 ET. Minutes are inside the session window, so
    // only the weekday check can reject this one.
    const now = new Date("2026-08-29T15:00:00Z");
    expect(etParts(now).weekday).toBe(6);
    expect(etParts(now).minutes).toBeLessThan(CLOSE);

    expect(barState(BAR_2026_08_27, now).forming).toBe(false);
  });
});

/**
 * Finviz publishes calendar times as naive New York wall clock — no zone
 * suffix. Reading them as UTC is the easy mistake and a silent one: the
 * result is still a plausible timestamp, just four or five hours out, which
 * is enough to move an earnings release across the 48h veto boundary.
 */
describe("etWallClockToUtc", () => {
  it("reads a summer (EDT) stamp as ET, not UTC", () => {
    // Finviz: SAIC reports 2026-08-31 08:30 ET = 12:30Z (UTC-4).
    const d = etWallClockToUtc("2026-08-31T08:30:00");
    expect(d.toISOString()).toBe("2026-08-31T12:30:00.000Z");
    expect(d.toISOString()).not.toBe("2026-08-31T08:30:00.000Z"); // the naive read
  });

  it("reads a winter (EST) stamp with the other offset", () => {
    // US DST ends 2026-11-01, so December is UTC-5.
    expect(etWallClockToUtc("2026-12-09T08:30:00").toISOString()).toBe(
      "2026-12-09T13:30:00.000Z",
    );
  });

  it("round-trips back to the wall clock it came from, both sides of DST", () => {
    for (const local of ["2026-08-31T08:30:00", "2026-12-09T08:30:00"]) {
      const back = etParts(etWallClockToUtc(local));
      const [date, time] = local.split("T");
      expect(back.date).toBe(date);
      expect(back.minutes).toBe(Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)));
    }
  });

  it("survives an after-midnight-UTC evening stamp", () => {
    // 20:00 ET is next-day 00:00Z — the case where the two dates disagree.
    expect(etWallClockToUtc("2026-08-28T20:00:00").toISOString()).toBe(
      "2026-08-29T00:00:00.000Z",
    );
  });
});
