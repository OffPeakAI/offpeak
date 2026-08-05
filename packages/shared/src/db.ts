import { bigint, boolean, doublePrecision, index, integer, jsonb, numeric, pgSchema, primaryKey, smallint, text, timestamp } from "drizzle-orm/pg-core"

export const shared = pgSchema("shared")

export const usageRecords = shared.table(
  "usage_records",
  {
    reqId: text("req_id").primaryKey(),
    hour: bigint("hour", { mode: "bigint" }).notNull(),
    ts: bigint("ts", { mode: "bigint" }).notNull(),
    payer: text("payer").notNull(),
    buyerRef: text("buyer_ref").notNull(),
    host: text("host").notNull(),
    modelDigest: text("model_digest").notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    promptHash: text("prompt_hash").notNull(),
    outputHash: text("output_hash").notNull(),
    priceIn: bigint("price_in", { mode: "bigint" }).notNull(),
    priceOut: bigint("price_out", { mode: "bigint" }).notNull(),
    hostCostMicro: bigint("host_cost_micro", { mode: "bigint" }).notNull(),
    feeMicro: bigint("fee_micro", { mode: "bigint" }).notNull(),
    feeBps: integer("fee_bps").notNull(),
    payMode: smallint("pay_mode").notNull(),
    payRef: text("pay_ref").notNull(),
    sheetHash: text("sheet_hash").notNull(),
    windowId: numeric("window_id", { precision: 78, scale: 0 }),
    routerSig: text("router_sig").notNull(),
    hostSig: text("host_sig").notNull(),
    leaf: text("leaf").notNull(),
    sealed: boolean("sealed").notNull().default(false),
    status: text("status").notNull().default("final"),
    settledHourTx: text("settled_hour_tx"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_records_hour_idx").on(t.hour, t.status),
    index("usage_records_payer_idx").on(t.payer, t.hour),
  ],
)

export const usageHours = shared.table("usage_hours", {
  hour: bigint("hour", { mode: "bigint" }).primaryKey(),
  records: integer("records").notNull(),
  root: text("root").notNull(),
  totals: jsonb("totals").notNull(),
  totalsHash: text("totals_hash").notNull(),
  routerCloseSig: text("router_close_sig").notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  settleTx: text("settle_tx"),
  settledAt: timestamp("settled_at", { withTimezone: true }),
})

export const agentPayments = shared.table("agent_payments", {
  paymentId: text("payment_id").primaryKey(),
  kind: text("kind").notNull(),
  payer: text("payer").notNull(),
  amountMicro: bigint("amount_micro", { mode: "bigint" }).notNull(),
  reqIds: text("req_ids").array().notNull(),
  channelId: text("channel_id"),
  voucherSeq: bigint("voucher_seq", { mode: "bigint" }),
  voucherSig: text("voucher_sig"),
  collectedTx: text("collected_tx"),
  collectedHour: bigint("collected_hour", { mode: "bigint" }),
  drawnHour: bigint("drawn_hour", { mode: "bigint" }),
  writtenOffHour: bigint("written_off_hour", { mode: "bigint" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const channelState = shared.table("channel_state", {
  channelId: text("channel_id").primaryKey(),
  payer: text("payer").notNull(),
  latestSeq: bigint("latest_seq", { mode: "bigint" }).notNull(),
  cumulative: bigint("cumulative", { mode: "bigint" }).notNull(),
  voucherSig: text("voucher_sig").notNull(),
  claimed: bigint("claimed", { mode: "bigint" }).notNull().default(0n),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const windowPerf = shared.table(
  "window_perf",
  {
    windowId: numeric("window_id", { precision: 78, scale: 0 }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    tokensPerS: doublePrecision("tokens_per_s").notNull(),
    demanded: boolean("demanded").notNull(),
  },
  (t) => [primaryKey({ columns: [t.windowId, t.ts] })],
)

export const refunds = shared.table("refunds", {
  id: text("id").primaryKey(),
  payer: text("payer").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  reason: text("reason").notNull(),
  reqIds: text("req_ids").array().notNull(),
  paidHour: bigint("paid_hour", { mode: "bigint" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
