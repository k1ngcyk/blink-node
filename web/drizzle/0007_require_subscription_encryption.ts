import { randomBytes } from "node:crypto";
import type { TransactionSql } from "postgres";
import { encrypt } from "../src/server/crypto";

export async function up(tx: TransactionSql) {
  // Keep the backfill and constraint atomic, including upgrades from optional encryption.
  await tx`LOCK TABLE proxy_subscriptions IN ACCESS EXCLUSIVE MODE`;
  const rows = await tx`SELECT id FROM proxy_subscriptions WHERE encrypted_password IS NULL`;
  for (const row of rows) {
    const password = randomBytes(24).toString("hex");
    await tx`UPDATE proxy_subscriptions SET encrypted_password=${encrypt(password)},updated_at=now() WHERE id=${row.id}`;
  }
  await tx`ALTER TABLE proxy_subscriptions ALTER COLUMN encrypted_password SET NOT NULL`;
}
