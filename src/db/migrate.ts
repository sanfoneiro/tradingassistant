import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import postgres from "postgres";

/**
 * Applies the .sql files in drizzle/ in name order. Every statement here is
 * written to be idempotent, so re-running is safe — which matters more than
 * elegance when the alternative is `push --force` guessing at a diff.
 */
async function main() {
  const dir = join(process.cwd(), "drizzle");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

  for (const f of files) {
    process.stdout.write(`applying ${f} … `);
    await sql.unsafe(readFileSync(join(dir, f), "utf8"));
    console.log("ok");
  }

  await sql.end();
  console.log(`${files.length} migration(s) applied.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
