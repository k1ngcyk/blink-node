import { readFile } from "node:fs/promises";
import { sql } from "../src/db";
import { encrypt, passwordHash, base32Decode } from "../src/server/crypto";
try {
  const name = (process.env.ADMIN_USERNAME ?? "admin").toLowerCase();
  const password = await readFile(process.env.ADMIN_PASSWORD_FILE!, "utf8").then((x) => x.trim());
  const totp = await readFile(process.env.ADMIN_TOTP_SECRET_FILE!, "utf8").then((x) => x.trim());
  if (!/^[a-z0-9_-]{3,32}$/.test(name)) throw new Error("Invalid username");
  if (password.length < 16 || password.length > 256)
    throw new Error("Password must be 16–256 characters");
  if (base32Decode(totp).length < 20) throw new Error("TOTP secret must have at least 160 bits");
  const ph = await passwordHash(password);
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(741829002)`;
    const existing = await tx`SELECT id FROM users WHERE role='owner'`;
    if (existing.length && process.env.RESET_ADMIN !== "true")
      throw new Error("Owner already exists; RESET_ADMIN=true required to rotate credentials");
    if (existing.length) {
      await tx`UPDATE users SET username=${name},password_hash=${ph},totp_secret=${encrypt(totp)},last_totp_step=0 WHERE id=${existing[0].id}`;
      await tx`DELETE FROM sessions WHERE user_id=${existing[0].id}`;
    } else
      await tx`INSERT INTO users(username,password_hash,role,totp_secret) VALUES(${name},${ph},'owner',${encrypt(totp)})`;
  });
  console.log(
    "Administrator initialized. Import the local TOTP secret into your authenticator. Credentials were not printed.",
  );
} finally {
  await sql.end();
}
