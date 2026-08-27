import { describe, it, expect } from "vitest";
import {
  parseEarnings,
  parseDividends,
  parseEconomic,
  parseRouteInitData,
  FinvizError,
} from "./finviz";

/**
 * These fixtures reproduce the REAL payload shape observed on 2026-08-27,
 * including the fields the parser deliberately ignores — `epsEstimate`,
 * `marketCap`, `yield`, and the nested `boxoverData` object. A fixture built
 * only from what the code reads today keeps passing when the code starts
 * reading one more field, which is how three action-item tests once guarded
 * behaviour that could not occur.
 */
function page(data: unknown): string {
  return (
    `<html><head><title>x</title></head><body>` +
    `<script id="route-init-data" type="application/json">${JSON.stringify({ data })}</script>` +
    `</body></html>`
  );
}

const EARNINGS = page({
  initialDateFrom: "2026-08-31",
  initialSort: "earningsDate",
  initialPage: 1,
  entries: {
    items: [
      {
        earningsDate: "2026-08-31T08:30:00",
        isEarningDateEstimate: false,
        ticker: "SAIC",
        company: "Science Applications International Corp",
        marketCap: 5452.022252935416,
        epsEstimate: 2.3085,
        epsActual: null,
        salesEstimate: 1764.077,
        oneDayPriceReaction: null,
        boxoverData: { ticker: "SAIC", country: "USA", industry: "IT Services" },
      },
      {
        earningsDate: "2026-10-19T12:00:00",
        isEarningDateEstimate: true,
        ticker: "APOG",
        company: "Apogee Enterprises Inc",
        marketCap: 847.67,
        epsEstimate: 0.4467,
        epsActual: null,
        boxoverData: { ticker: "APOG", country: "USA" },
      },
    ],
    page: 1,
    pageSize: 50,
    totalItemsCount: 2,
    totalPages: 1,
  },
});

const DIVIDENDS_TRUNCATED = page({
  initialDateFrom: "2026-08-31",
  entries: {
    items: [
      {
        ticker: "ADC",
        company: "Agree Realty Corp",
        exdate: "2026-08-31",
        ordinary: 0.267,
        special: null,
        yield: 4.366366302255361,
        boxoverData: { ticker: "ADC", industry: "REIT - Retail", marketCap: 9104.56 },
      },
    ],
    page: 1,
    pageSize: 50,
    // The live case: 77 exist, page 1 carries 50, and &page=2 is ignored.
    totalItemsCount: 77,
    totalPages: 2,
  },
});

/** The economic calendar uses a 0..n keyed object, not an array. */
const ECONOMIC = page({
  initialDateFrom: "2026-08-31",
  entries: {
    0: {
      calendarId: 399143,
      ticker: "UNITEDSTADALFEDMANIN",
      event: "Dallas Fed Manufacturing Index",
      category: "Dallas Fed Manufacturing Index",
      date: "2026-08-31T10:30:00",
      reference: "Aug",
      referenceDate: "2026-08-31",
      actual: null,
      previous: "1.3",
      forecast: null,
      importance: 2,
      isHigherPositive: 0,
      allDay: false,
    },
    1: {
      calendarId: 399200,
      ticker: "UNITEDSTAISMMANPMI",
      event: "ISM Manufacturing PMI",
      date: "2026-09-01T10:00:00",
      reference: "Aug",
      actual: null,
      previous: "55.6",
      forecast: null,
      importance: 3,
      allDay: false,
    },
  },
});

describe("parseEarnings", () => {
  it("reads ticker, company and the ET time as a real instant", () => {
    const e = parseEarnings(EARNINGS);
    expect(e).toHaveLength(2);
    expect(e[0].ticker).toBe("SAIC");
    // 08:30 ET in August is 12:30Z. A naive UTC read would give 08:30Z.
    expect(e[0].at.toISOString()).toBe("2026-08-31T12:30:00.000Z");
  });

  it("carries isEarningDateEstimate through in both directions", () => {
    const e = parseEarnings(EARNINGS);
    expect(e[0].estimated).toBe(false); // confirmed, near-dated
    expect(e[1].estimated).toBe(true); // October, an estimate
  });

  it("treats a MISSING estimate flag as estimated, not confirmed", () => {
    // The safe direction: assuming "confirmed" from an absent field is what
    // opens a position into a print.
    const noFlag = page({
      entries: {
        items: [{ ticker: "ZZZ", company: "Z", earningsDate: "2026-09-15T08:00:00" }],
        totalItemsCount: 1,
      },
    });
    expect(parseEarnings(noFlag)[0].estimated).toBe(true);
  });

  it("does not carry any price or estimate number through", () => {
    const e = parseEarnings(EARNINGS);
    expect(Object.keys(e[0]).sort()).toEqual(["at", "company", "estimated", "ticker"]);
  });
});

describe("completeness", () => {
  it("flags a truncated page rather than reporting a short list as whole", () => {
    const d = parseDividends(DIVIDENDS_TRUNCATED);
    expect(d).toHaveLength(1);
    expect(d.meta.total).toBe(77);
    expect(d.meta.complete).toBe(false); // 1 of 77 — must not read as "all"
  });

  it("calls a full page complete", () => {
    expect(parseEarnings(EARNINGS).meta.complete).toBe(true);
  });
});

describe("parseEconomic", () => {
  it("reads the 0..n keyed object and keeps the impact rating", () => {
    const e = parseEconomic(ECONOMIC);
    expect(e.map((x) => x.event)).toEqual([
      "Dallas Fed Manufacturing Index",
      "ISM Manufacturing PMI",
    ]);
    expect(e[1].importance).toBe(3);
    expect(e[0].at.toISOString()).toBe("2026-08-31T14:30:00.000Z"); // 10:30 ET
  });
});

describe("failure is loud", () => {
  /**
   * The whole point. Finviz returns zero rows for weeks that certainly have
   * earnings, and a shape change would otherwise look identical to a quiet
   * week. Neither may reach a veto as "nothing scheduled".
   */
  it("throws when the payload blob is missing rather than returning nothing", () => {
    expect(() => parseRouteInitData("<html><body>nope</body></html>")).toThrow(
      FinvizError,
    );
  });

  it("throws on a blob that is not valid JSON", () => {
    const broken =
      `<script id="route-init-data" type="application/json">{"data":{</script>`;
    expect(() => parseRouteInitData(broken)).toThrow(FinvizError);
  });

  it("distinguishes a genuinely empty window from a broken one", () => {
    // Real shape, zero rows — parses fine and reports zero. The CALLER must
    // treat that as unknown; the parser's job is only to not lie about it.
    const empty = page({ entries: { items: [], totalItemsCount: 0, totalPages: 0 } });
    const e = parseEarnings(empty);
    expect(e).toHaveLength(0);
    expect(e.meta.complete).toBe(true);
  });
});
