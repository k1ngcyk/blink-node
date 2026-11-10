import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  bigint,
  doublePrecision,
  primaryKey,
  inet,
} from "drizzle-orm/pg-core";
const time = (name: string) => timestamp(name, { withTimezone: true });
export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  username: text().unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text().notNull().default("member"),
  totpSecret: text("totp_secret").notNull(),
  lastTotpStep: bigint("last_totp_step", { mode: "number" }).notNull().default(0),
  createdAt: time("created_at").defaultNow().notNull(),
});
export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  expiresAt: time("expires_at").notNull(),
  createdAt: time("created_at").defaultNow().notNull(),
  elevatedUntil: time("elevated_until").notNull(),
});
export const servers = pgTable("servers", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  groupName: text("group_name").notNull().default("默认分组"),
  tags: text().array().notNull().default([]),
  notes: text().notNull().default(""),
  tokenHash: text("token_hash").unique(),
  revoked: boolean().notNull().default(false),
  info: jsonb().notNull().default({}),
  lastSeen: time("last_seen"),
  connectionIp: inet("connection_ip"),
  latest: jsonb(),
  latestAt: time("latest_at"),
  quotaBytes: bigint("quota_bytes", { mode: "number" }),
  billingDay: integer("billing_day").notNull().default(1),
  billingInterfaces: text("billing_interfaces").array().notNull().default([]),
  createdAt: time("created_at").defaultNow().notNull(),
});
export const enrollments = pgTable("enrollments", {
  tokenHash: text("token_hash").primaryKey(),
  serverId: uuid("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  expiresAt: time("expires_at").notNull(),
  usedAt: time("used_at"),
});
export const checks = pgTable("checks", {
  id: uuid().primaryKey().defaultRandom(),
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),
  name: text().notNull(),
  kind: text().notNull(),
  target: text().notNull(),
  intervalSeconds: integer("interval_seconds").notNull().default(60),
  enabled: boolean().notNull().default(true),
  latest: jsonb(),
  lastRun: time("last_run"),
  createdAt: time("created_at").notNull().defaultNow(),
});
export const alertRules = pgTable("alert_rules", {
  id: uuid().primaryKey().defaultRandom(),
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),
  name: text().notNull(),
  metric: text().notNull(),
  threshold: doublePrecision().notNull(),
  recovery: doublePrecision().notNull(),
  durationSeconds: integer("duration_seconds").notNull().default(60),
  enabled: boolean().notNull().default(true),
  mutedUntil: time("muted_until"),
});
export const alerts = pgTable("alerts", {
  id: uuid().primaryKey().defaultRandom(),
  ruleId: uuid("rule_id")
    .notNull()
    .references(() => alertRules.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),
  checkId: uuid("check_id").references(() => checks.id, { onDelete: "cascade" }),
  state: text().notNull(),
  since: time("since").notNull(),
  value: doublePrecision().notNull(),
  updatedAt: time("updated_at").notNull(),
  notifiedAt: time("notified_at"),
});
export const channels = pgTable("channels", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  kind: text().notNull(),
  encryptedConfig: text("encrypted_config").notNull(),
  enabled: boolean().notNull().default(true),
});
export const grants = pgTable(
  "resource_grants",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resourceId: uuid("resource_id").notNull(),
    resourceType: text("resource_type").notNull().default("proxy_instance"),
    permission: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.resourceId, t.permission] })],
);
