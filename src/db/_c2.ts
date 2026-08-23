import postgres from "postgres";
async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const d = await sql`DELETE FROM zones WHERE symbol LIKE '\_\_%' RETURNING id`;
  console.log(`removed ${d.length} test row(s)`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
