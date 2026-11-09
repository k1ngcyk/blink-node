import { z } from "zod";
import { proxyResult, proxyStatusMessage } from "./proxy-model";
const number = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const percent = z.number().min(0).max(100);
const name = z.string().min(1).max(256);
export const metricSchema = z.object({
  bootId: z.uuid(),
  seq: number.int(),
  at: z.iso.datetime(),
  uptime: number,
  cpu: percent,
  cores: z.array(percent).max(1024),
  load: z.array(number).length(3),
  memoryTotal: number,
  memoryUsed: number,
  swapTotal: number,
  swapUsed: number,
  disks: z
    .array(
      z.object({
        name,
        mount: name,
        total: number,
        used: number,
        inodesTotal: number.nullable(),
        inodesUsed: number.nullable(),
      }),
    )
    .max(128),
  networks: z
    .array(
      z.object({
        name,
        rx: number,
        tx: number,
        rxDelta: number,
        txDelta: number,
        rxRate: number,
        txRate: number,
      }),
    )
    .max(128),
  diskReadRate: number,
  diskWriteRate: number,
  temperatures: z.array(z.object({ name, value: z.number().min(-100).max(250) })).max(128),
});
export type Metric = z.infer<typeof metricSchema>;
export const infoSchema = z.object({
  hostname: name,
  os: name,
  kernel: name,
  arch: name,
  cpuModel: name,
  cpuCount: z.number().int().min(1).max(1024),
  version: name,
  terminal: z.boolean(),
  diagnostics: z.boolean(),
  proxy: z.boolean().optional().default(false),
});
export const checkResultSchema = z.object({
  id: z.uuid(),
  at: z.iso.datetime(),
  ok: z.boolean(),
  latencyMs: number.nullable(),
  loss: percent.nullable(),
  status: z.number().int().min(100).max(599).nullable(),
  certificateDays: z.number().finite().nullable(),
  error: z.string().max(300).nullable(),
});
export const agentMessage = z.discriminatedUnion("type", [
  proxyResult,
  proxyStatusMessage,
  z.object({ type: z.literal("hello"), v: z.literal(1), info: infoSchema }),
  z.object({
    type: z.literal("metrics"),
    v: z.literal(1),
    samples: z.array(metricSchema).min(1).max(20),
  }),
  z.object({ type: z.literal("check.result"), v: z.literal(1), result: checkResultSchema }),
  z.object({
    type: z.literal("diagnostic.result"),
    v: z.literal(1),
    id: z.uuid(),
    ok: z.boolean(),
    result: z.string().max(65536),
  }),
]);
export const serverUpdate = z.object({
  name: z.string().trim().min(1).max(100),
  groupName: z.string().trim().min(1).max(64).default("默认分组"),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).default([]),
  notes: z.string().max(2000).default(""),
  quotaBytes: number.int().nullable().default(null),
  billingDay: z.number().int().min(1).max(28).default(1),
  billingInterfaces: z.array(z.string().min(1).max(128)).max(32).default([]),
});
export const checkInput = z.object({
  name: z.string().trim().min(1).max(100),
  serverId: z.uuid().nullable(),
  kind: z.enum(["tcp", "http", "icmp", "tls"]),
  target: z.string().min(1).max(2048),
  intervalSeconds: z.number().int().min(30).max(3600).default(60),
  enabled: z.boolean().default(true),
});
export const ruleInput = z
  .object({
    name: z.string().min(1).max(100),
    serverId: z.uuid().nullable(),
    metric: z.enum(["offline", "cpu", "memory", "disk", "swap", "check", "certificate", "traffic"]),
    threshold: z.number().finite().min(0).max(1e9),
    recovery: z.number().finite().min(0).max(1e9),
    durationSeconds: z.number().int().min(0).max(86400),
    enabled: z.boolean().default(true),
  })
  .refine(
    (v) => (v.metric === "certificate" ? v.recovery >= v.threshold : v.recovery <= v.threshold),
    { message: "恢复阈值方向不正确" },
  );
