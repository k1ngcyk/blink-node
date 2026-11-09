import { z } from "zod";
import { config } from "./config";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function sameOrigin(headers: Headers) {
  if (headers.get("origin") !== config().origin) throw new HttpError(403, "请求来源不受信任");
  const site = headers.get("sec-fetch-site");
  if (site && !["same-origin", "none"].includes(site)) throw new HttpError(403, "跨站请求已拒绝");
}
export function clientIp(headers: Headers) {
  // Only use the header that our directly-connected Caddy overwrites.
  return config().trustedProxy
    ? (headers.get("x-blink-client-ip") ?? "unknown").slice(0, 64)
    : "local";
}
export async function body<T>(request: Request, schema: z.ZodType<T>, max = 32768): Promise<T> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "需要 JSON 请求");
  if (Number(request.headers.get("content-length") ?? 0) > max)
    throw new HttpError(413, "请求过大");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "缺少请求内容");
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    length += r.value.length;
    if (length > max) {
      await reader.cancel();
      throw new HttpError(413, "请求过大");
    }
    chunks.push(r.value);
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON 格式错误");
  }
  const result = schema.safeParse(data);
  if (!result.success)
    throw new HttpError(
      400,
      result.error.issues
        .map((x) => `${x.path.join(".")}: ${x.message}`)
        .join("; ")
        .slice(0, 600),
    );
  return result.data;
}
export function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}
export function failure(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return json({ error: "参数格式错误" }, 400);
  console.error(
    "Request failed",
    error instanceof Error
      ? { name: error.name, frames: error.stack?.split("\n").slice(1, 6) }
      : "unknown",
  );
  return json({ error: "请求失败，请稍后重试" }, 500);
}
