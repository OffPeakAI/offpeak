import { bigint, boolean, doublePrecision, integer, jsonb, pgSchema, primaryKey, smallint, text, timestamp } from "drizzle-orm/pg-core"

export const serving = pgSchema("serving")

export const accounts = serving.table("accounts", {
  id: text("id").primaryKey(),
  wallet: text("wallet").notNull().unique(),
  auditOptIn: boolean("audit_opt_in").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const apiKeys = serving.table("api_keys", {
  keyHash: text("key_hash").primaryKey(),
  accountId: text("account_id").notNull(),
  label: text("label").notNull(),
  rpmLimit: integer("rpm_limit").notNull().default(600),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
})

export const holds = serving.table("holds", {
  id: text("id").primaryKey(),
  accountId: text("account_id"),
  wallet: text("wallet").notNull(),
  hour: bigint("hour", { mode: "bigint" }).notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  status: text("status").notNull(),
  reqId: text("req_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
})

export const priceSheets = serving.table("price_sheets", {
  sheetHash: text("sheet_hash").primaryKey(),
  host: text("host").notNull(),
  modelDigest: text("model_digest").notNull(),
  validFrom: bigint("valid_from", { mode: "bigint" }).notNull(),
  baseIn: jsonb("base_in").notNull(),
  baseOut: jsonb("base_out").notNull(),
  floorIn: bigint("floor_in", { mode: "bigint" }).notNull(),
  floorOut: bigint("floor_out", { mode: "bigint" }).notNull(),
  nonce: bigint("nonce", { mode: "bigint" }).notNull(),
  sig: text("sig").notNull(),
})

export const requests = serving.table("requests", {
  reqId: text("req_id").primaryKey(),
  accountId: text("account_id"),
  wallet: text("wallet").notNull(),
  modelDigest: text("model_digest").notNull(),
  host: text("host").notNull(),
  payMode: smallint("pay_mode").notNull(),
  tokensIn: integer("tokens_in").notNull(),
  tokensOut: integer("tokens_out").notNull(),
  ttftMs: integer("ttft_ms"),
  durationMs: integer("duration_ms"),
  status: text("status").notNull(),
  errorCode: text("error_code"),
  sealed: boolean("sealed").notNull().default(false),
  ts: bigint("ts", { mode: "bigint" }).notNull(),
  hostCounts: jsonb("host_counts"),
})

export const hostLoad = serving.table(
  "host_load",
  {
    host: text("host").notNull(),
    modelDigest: text("model_digest").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    util: doublePrecision("util").notNull(),
    ttftP95Ms: doublePrecision("ttft_p95_ms").notNull(),
    inflight: integer("inflight").notNull(),
    healthy: boolean("healthy").notNull(),
  },
  (t) => [primaryKey({ columns: [t.host, t.modelDigest, t.ts] })],
)

export const hourLocks = serving.table("hour_locks", {
  hour: bigint("hour", { mode: "bigint" }).primaryKey(),
})
