// Applies pending SQL migrations from db/migrations, in filename order.
// Usage: DATABASE_URL=... node scripts/migrate.mjs
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const dir = join(import.meta.dirname, "..", "db", "migrations");
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

// pg v9 will weaken sslmode=require to libpq semantics; pin today's strict verification.
const client = new pg.Client({
  connectionString: url.replace(/sslmode=(prefer|require|verify-ca)\b/, "sslmode=verify-full"),
});
await client.connect();

try {
  await client.query(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const { rows } = await client.query("select name from schema_migrations");
  const applied = new Set(rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("rollback");
      throw new Error(`${file}: ${err.message}`);
    }
  }
  console.log("up to date");
} finally {
  await client.end();
}
