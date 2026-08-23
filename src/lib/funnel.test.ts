import { describe, it, expect } from "vitest";
import {
  atTrigger,
  worthWatching,
  triggerStamp,
  daysWaiting,
  TRIGGER_BAND_PCT,
  WATCH_BAND_PCT,
} from "./funnel";

describe("bands", () => {
  it("the trigger band is signed-agnostic — above or below both count", () => {
    expect(atTrigger(1.9)).toBe(true);
    expect(atTrigger(-1.9)).toBe(true);
    expect(atTrigger(0)).toBe(true);
  });

  it("the boundary is inclusive, so a name exactly at 2% is gradeable", () => {
    expect(atTrigger(TRIGGER_BAND_PCT)).toBe(true);
    expect(atTrigger(TRIGGER_BAND_PCT + 0.01)).toBe(false);
  });

  it("watching is wider than triggering", () => {
    expect(worthWatching(5)).toBe(true);
    expect(atTrigger(5)).toBe(false);
    expect(worthWatching(WATCH_BAND_PCT + 0.01)).toBe(false);
  });

  it("an unknown distance is neither — never a default of true", () => {
    expect(atTrigger(null)).toBe(false);
    expect(atTrigger(undefined)).toBe(false);
    expect(worthWatching(null)).toBe(false);
  });
});

describe("triggerStamp", () => {
  const t0 = new Date("2026-08-20T12:00:00Z");
  const t1 = new Date("2026-08-24T12:00:00Z");

  it("stamps on first arrival", () => {
    expect(triggerStamp(0.5, null, t1)).toEqual(t1);
  });

  it("keeps the original stamp while it stays in the band", () => {
    // The point of the stamp is "how long has this been waiting" — refreshing
    // it on every sweep would reset that clock twice a day and answer nothing.
    expect(triggerStamp(0.5, t0, t1)).toEqual(t0);
    expect(triggerStamp(1.9, t0, t1)).toEqual(t0);
  });

  it("clears when price drifts back out", () => {
    expect(triggerStamp(4, t0, t1)).toBeNull();
  });

  it("a fresh arrival after drifting out is a new event, not a continuation", () => {
    const cleared = triggerStamp(4, t0, t1);
    expect(cleared).toBeNull();
    expect(triggerStamp(0.5, cleared, t1)).toEqual(t1);
  });

  it("an unknown distance clears rather than holds", () => {
    expect(triggerStamp(null, t0, t1)).toBeNull();
  });
});

describe("daysWaiting", () => {
  it("counts whole days since the stamp", () => {
    const since = new Date("2026-08-20T12:00:00Z");
    expect(daysWaiting(since, new Date("2026-08-20T18:00:00Z"))).toBe(0);
    expect(daysWaiting(since, new Date("2026-08-23T12:00:00Z"))).toBe(3);
  });

  it("is null when nothing is waiting", () => {
    expect(daysWaiting(null)).toBeNull();
  });
});
