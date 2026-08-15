import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;

if (!url && process.env.NODE_ENV === "production") {
  // Fail loudly rather than serving a page full of zeros.
  console.error("DATABASE_URL is not set — the app cannot read anything.");
}

const client = postgres(url ?? "postgresql://localhost:5432/placeholder", {
  max: 1,
  idle_timeout: 20,
  prepare: false,
});

export const db = drizzle(client, { schema });
export { schema };
