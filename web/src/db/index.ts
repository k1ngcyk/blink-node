import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { secret } from "../server/config";
import * as schema from "./schema";

const globalDb = globalThis as unknown as {
  blinkSql?: ReturnType<typeof postgres>;
  blinkOrmSql?: ReturnType<typeof postgres>;
};
const databaseUrl = secret("DATABASE_URL") || "postgres://invalid@127.0.0.1:5432/blink";
export const sql =
  globalDb.blinkSql ??
  postgres(databaseUrl, {
    max: 12,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    connection: { statement_timeout: 15000, application_name: "blink-node" },
    onnotice: () => {},
  });
// Drizzle intentionally overrides JSON/date serializers. Keep its small pool separate
// so the metrics worker can safely use native postgres.js JSON and date parameters.
export const ormSql =
  globalDb.blinkOrmSql ??
  postgres(databaseUrl, {
    max: 3,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: { statement_timeout: 15000, application_name: "blink-orm" },
    onnotice: () => {},
  });
if (process.env.NODE_ENV !== "production") {
  globalDb.blinkSql = sql;
  globalDb.blinkOrmSql = ormSql;
}
export const db = drizzle(ormSql, { schema });
