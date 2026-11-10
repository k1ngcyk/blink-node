import { sql } from "../db";
import { config } from "./config";
import { hash, passwordVerify, decrypt, verifyTotp, token } from "./crypto";
import { HttpError } from "./http";
export async function rateLimit(key: string, max: number, seconds: number) {
  const rows =
    await sql`INSERT INTO rate_limits(key,count,reset_at) VALUES(${hash(key)},1,now()+${seconds}*interval '1 second') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.reset_at<now() THEN 1 ELSE rate_limits.count+1 END, reset_at=CASE WHEN rate_limits.reset_at<now() THEN now()+${seconds}*interval '1 second' ELSE rate_limits.reset_at END RETURNING count`;
  if (rows[0].count > max) throw new HttpError(429, "请求过于频繁，请稍后再试");
}
export function cookieToken(headers: Headers) {
  const name = config().cookie;
  const value = (headers.get("cookie") ?? "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export async function owner(headers: Headers) {
  const raw = cookieToken(headers);
  if (!raw) throw new HttpError(401, "请先登录", "SESSION_EXPIRED");
  const rows =
    await sql`SELECT u.id,u.username,u.role,s.token_hash,s.elevated_until FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=${hash(raw)} AND s.expires_at>now()`;
  if (!rows.length) throw new HttpError(401, "登录已过期", "SESSION_EXPIRED");
  if (rows[0].role !== "owner") throw new HttpError(403, "仅服务器所有者可操作");
  return rows[0] as {
    id: string;
    username: string;
    role: string;
    token_hash: string;
    elevated_until: Date;
  };
}
export function elevated(user: { elevated_until: Date }) {
  if (new Date(user.elevated_until).getTime() < Date.now())
    throw new HttpError(428, "请验证身份后继续当前操作");
}
export function sessionCookie(raw: string, seconds = config().sessionSeconds) {
  const c = config();
  return `${c.cookie}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${c.secure ? "; Secure" : ""}`;
}
let activeLogins = 0;
export async function login(username: string, password: string, code: string, ip: string) {
  await rateLimit(`login:ip:${ip}`, 12, 900);
  await rateLimit(`login:user:${username.toLowerCase()}`, 12, 900);
  if (activeLogins >= 4) throw new HttpError(429, "请稍后重试");
  activeLogins++;
  try {
    const rows =
      await sql`SELECT * FROM users WHERE username=${username.toLowerCase()} AND role='owner'`;
    const u = rows[0];
    // Fixed-cost verification for unknown accounts.
    const dummy = "scrypt-v1$0123456789abcdef0123456789abcdef$" + "0".repeat(128);
    const valid = await passwordVerify(password, u?.password_hash ?? dummy);
    const step = u ? verifyTotp(decrypt(u.totp_secret), code) : null;
    if (!u || !valid || step === null) {
      await audit(null, "login.failed", null, { ipHash: hash(ip) });
      throw new HttpError(401, "账号、密码或验证码不正确");
    }
    const raw = token();
    await sql.begin(async (tx) => {
      const fresh =
        await tx`UPDATE users SET last_totp_step=${step} WHERE id=${u.id} AND last_totp_step<${step} RETURNING id`;
      if (!fresh.length) throw new HttpError(401, "验证码已使用，请等待下一个验证码");
      await tx`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(${hash(raw)},${u.id},now()+${config().sessionSeconds}*interval '1 second')`;
      await tx`DELETE FROM sessions WHERE user_id=${u.id} AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=${u.id} ORDER BY created_at DESC LIMIT 5)`;
    });
    await audit(u.id, "login.success", null, {});
    return raw;
  } finally {
    activeLogins--;
  }
}
export async function audit(
  userId: string | null,
  action: string,
  resourceId: string | null,
  detail: Record<string, unknown> = {},
) {
  await sql`INSERT INTO audit_events(user_id,action,resource_id,detail) VALUES(${userId},${action},${resourceId},${sql.json(detail as never)})`;
}
