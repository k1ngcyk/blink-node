import { sql } from "../src/db/index";
import { migrateDatabase } from "../src/db/migrate";
import { ensurePartitions } from "../src/server/metrics";
try {
  await migrateDatabase();
  await ensurePartitions();
} finally {
  await sql.end();
}
