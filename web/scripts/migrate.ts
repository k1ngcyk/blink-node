import { readdir, readFile } from "node:fs/promises";
import { sql } from "../src/db/index";
import { ensurePartitions } from "../src/server/metrics";
try {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(741829001)`;
    await tx`CREATE TABLE IF NOT EXISTS blink_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const file of (await readdir(new URL("../drizzle/", import.meta.url)))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if ((await tx`SELECT 1 FROM blink_migrations WHERE name=${file}`).length) continue;
      await tx.unsafe(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
      await tx`INSERT INTO blink_migrations(name) VALUES(${file})`;
      console.log(`Applied ${file}`);
    }
  });
  await ensurePartitions();
} finally {
  await sql.end();
}
