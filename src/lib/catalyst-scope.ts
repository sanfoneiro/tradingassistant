import { and, gt, inArray, type SQL } from "drizzle-orm";
import { catalysts } from "@/db/schema";

/**
 * The rows a `catalysts` payload replaces: future-dated, and only the
 * sub-calendars the payload actually carries.
 *
 * This lives here rather than inline in the route so it can be asserted
 * against without a database. The predicate it replaced was written as a raw
 * ``sql`... kind = ANY(${kinds})` ``, and Drizzle expands an array inside a
 * raw template into one placeholder per element — so Postgres received
 * `ANY(($1, $2, $3, $4))`, which is a row where an array was required. Every
 * calendar sync from 2026-08-28 on fetched correctly and then died on the
 * write with a 500, which looks exactly like a job nobody has run.
 */
export function replacedCatalysts(kinds: string[], now = new Date()): SQL {
  return and(gt(catalysts.eventAt, now), inArray(catalysts.kind, kinds))!;
}
