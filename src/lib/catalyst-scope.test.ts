import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { catalysts } from "@/db/schema";
import { replacedCatalysts } from "./catalyst-scope";

/**
 * These assert the SQL TEXT, not a return value, because the bug they guard
 * produced a perfectly well-typed query object that Postgres then rejected.
 * Nothing short of looking at the emitted statement could have caught it —
 * `npm test` was green for the 24 days the calendar sat frozen.
 */
describe("replacedCatalysts", () => {
  const kinds = ["earnings", "earnings_estimated", "macro", "ex_dividend"];

  it("binds the kinds as an IN list, never as ANY(row)", () => {
    const { sql } = db
      .delete(catalysts)
      .where(replacedCatalysts(kinds))
      .toSQL();

    // The regression: `ANY(($1, $2, $3, $4))` — ANY needs an array, and
    // Postgres raises rather than matching nothing, so the whole write 500s.
    expect(sql.toLowerCase()).not.toContain("any(");
    expect(sql.toLowerCase()).toContain(" in (");
  });

  it("carries one placeholder per kind, plus the date", () => {
    const { sql, params } = db
      .delete(catalysts)
      .where(replacedCatalysts(kinds, new Date("2026-09-21T00:00:00Z")))
      .toSQL();

    expect(params).toHaveLength(kinds.length + 1);
    expect(params.slice(1)).toEqual(kinds);
    expect(sql).toContain("event_at");
  });

  it("scopes the delete to the future, so past rows survive a resync", () => {
    const { sql } = db.delete(catalysts).where(replacedCatalysts(kinds)).toSQL();
    expect(sql).toMatch(/"event_at"\s*>/);
  });
});
