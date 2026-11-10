import { readdir, readFile } from "node:fs/promises";
import { sql } from "./index";

export async function migrateDatabase() {
  const directory = new URL("../../drizzle/", import.meta.url);
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(741829001)`;
    await tx`CREATE TABLE IF NOT EXISTS blink_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const file of (await readdir(directory)).filter((f) => /\.(sql|ts)$/.test(f)).sort()) {
      if ((await tx`SELECT 1 FROM blink_migrations WHERE name=${file}`).length) continue;
      const url = new URL(file, directory);
      if (file.endsWith(".sql")) await tx.unsafe(await readFile(url, "utf8"));
      else await (await import(url.href)).up(tx);
      await tx`INSERT INTO blink_migrations(name) VALUES(${file})`;
      console.log(`Applied ${file}`);
    }
  });
}
