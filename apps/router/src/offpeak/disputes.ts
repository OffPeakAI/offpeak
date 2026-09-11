import { DISPUTE_WINDOW_S, LOAD_FACTOR_MAX_BPS, countsWithinTolerance, hourOfWeek, keccakUtf8, quoteCost, recordToMessage, recountRecord, recoverUsageSigner, type Hex, type UsageRecord } from "@offpeak/shared"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import { tokenizerFor } from "../metering/tokenize.ts"
import { livePrice } from "../pricing/live.ts"
import type { Stack } from "../pipeline.ts"

const reqIdSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase())

const materialRow = z.object({
  req_id: reqIdSchema.optional(),
  /** The request body as it was sent, as JSON or as an object. */
  prompt: z.union([z.string(), z.record(z.string(), z.unknown())]),
  output: z.string().default(""),
  tool_calls: z.array(z.unknown()).optional(),
  /** The stream's `finish_reason`, which says whether the output ended on the model's end token. */
  finish: z.string().nullish(),
})

const disputeBody = z.object({
  req_ids: z.array(reqIdSchema).min(1).max(100),
  reason: z.string().min(1).max(2000),
  material: z.union([materialRow, z.array(materialRow).max(100)]).optional(),
})

type Material = z.infer<typeof materialRow>

type UsageRow = {
  req_id: string
  ts: string
  payer: string
  buyer_ref: string
  host: string
  model_digest: string
  tokens_in: number
  tokens_out: number
  prompt_hash: string
  output_hash: string
  price_in: string
  price_out: string
  host_cost_micro: string
  fee_micro: string
  fee_bps: number
  pay_mode: number
  pay_ref: string
  sheet_hash: string
  router_sig: string
  host_sig: string
  sealed: boolean
  status: string
}

export type DisputeCheck = { req_id: string; upheld: boolean; refund_micro: string; reasons: string[] }

const min = (a: bigint, b: bigint) => (a < b ? a : b)

function usageRecordOf(row: UsageRow): UsageRecord {
  return {
    reqId: row.req_id as Hex,
    buyerRef: row.buyer_ref as Hex,
    host: row.host as Hex,
    modelDigest: row.model_digest as Hex,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    promptHash: row.prompt_hash as Hex,
    outputHash: row.output_hash as Hex,
    priceIn: BigInt(row.price_in),
    priceOut: BigInt(row.price_out),
    hostCostMicro: BigInt(row.host_cost_micro),
    feeMicro: BigInt(row.fee_micro),
    payMode: row.pay_mode as UsageRecord["payMode"],
    payRef: row.pay_ref as Hex,
    ts: Number(row.ts),
    sheetHash: row.sheet_hash as Hex,
  }
}

async function signaturesHold(stack: Stack, row: UsageRow) {
  const message = recordToMessage(usageRecordOf(row))
  const router = await recoverUsageSigner(message, row.router_sig as Hex, stack.usageLedger).catch(() => null)
  const host = await recoverUsageSigner(message, row.host_sig as Hex, stack.usageLedger).catch(() => null)
  return router?.toLowerCase() === stack.router.address.toLowerCase() && host?.toLowerCase() === row.host.toLowerCase()
}

/** The most this record could fairly charge per token: the locked price of its job, or the sheet at full load. */
async function ceilingPrice(stack: Stack, row: UsageRow) {
  const locked = await stack.db.query<{ locked_price_in: string; locked_price_out: string }>("SELECT j.locked_price_in, j.locked_price_out FROM serving.job_lines l JOIN serving.jobs j ON j.id = l.job_id WHERE l.req_id = $1", [row.req_id])
  if (locked.rows[0]) return { in: BigInt(locked.rows[0].locked_price_in), out: BigInt(locked.rows[0].locked_price_out) }
  const sheet = stack.sheets.find((s) => s.sheetHash === row.sheet_hash)
  if (!sheet || sheet.host.toLowerCase() !== row.host.toLowerCase() || sheet.modelDigest !== row.model_digest || sheet.validFrom > Number(row.ts)) return null
  return livePrice(sheet, hourOfWeek(Number(row.ts)), LOAD_FACTOR_MAX_BPS)
}

function promptOf(material: Material) {
  if (typeof material.prompt !== "string") return material.prompt
  try {
    return JSON.parse(material.prompt) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Recounts from what the buyer kept, with the model's own tokenizer. Returns the counts to bill, or null when the material is not this record's. */
function recount(stack: Stack, row: UsageRow, material: Material) {
  const prompt = promptOf(material)
  if (!prompt) return null
  const model = { digest: row.model_digest as Hex }
  const contextLength = stack.models.find((entry) => entry.digest === row.model_digest)?.contextLength
  try {
    const report = recountRecord(
      { promptHash: row.prompt_hash, outputHash: row.output_hash, tokensIn: row.tokens_in, tokensOut: row.tokens_out },
      { prompt, output: { text: material.output, toolCalls: material.tool_calls, finish: material.finish }, tokenizer: tokenizerFor(model), contextLength },
    )
    return report.promptOk && report.outputOk ? { tokensIn: report.tokensIn, tokensOut: report.tokensOut } : null
  } catch {
    return null
  }
}

/** Runs every automatic check on one record and works out what it should have cost. */
async function checkRecord(stack: Stack, row: UsageRow, material: Material | undefined): Promise<DisputeCheck> {
  const billed = BigInt(row.host_cost_micro) + BigInt(row.fee_micro)
  const reasons: string[] = []
  const done = (refund: bigint): DisputeCheck => ({ req_id: row.req_id, upheld: refund > 0n, refund_micro: refund.toString(), reasons })
  if (row.status !== "final") {
    reasons.push("record_void")
    return done(0n)
  }
  if (billed === 0n) {
    reasons.push("nothing_billed")
    return done(0n)
  }
  const ceiling = await ceilingPrice(stack, row)
  if (!(await signaturesHold(stack, row))) reasons.push("bad_signature")
  if (!ceiling) reasons.push("sheet_mismatch")
  if (reasons.length > 0) return done(billed)
  let tokensIn = row.tokens_in
  let tokensOut = row.tokens_out
  if (!material) reasons.push("no_material")
  else if (row.sealed) reasons.push("sealed_no_recount")
  else {
    const counted = recount(stack, row, material)
    if (!counted) reasons.push("material_mismatch")
    else {
      if (row.tokens_in > counted.tokensIn && !countsWithinTolerance(row.tokens_in, counted.tokensIn)) tokensIn = counted.tokensIn
      if (row.tokens_out > counted.tokensOut && !countsWithinTolerance(row.tokens_out, counted.tokensOut)) tokensOut = counted.tokensOut
      if (tokensIn !== row.tokens_in || tokensOut !== row.tokens_out) reasons.push("tokens_overcounted")
    }
  }
  const priceIn = min(BigInt(row.price_in), ceiling!.in)
  const priceOut = min(BigInt(row.price_out), ceiling!.out)
  if (priceIn !== BigInt(row.price_in) || priceOut !== BigInt(row.price_out)) reasons.push("price_above_sheet")
  const fair = quoteCost({ tokensIn, tokensOut, priceIn, priceOut, feeBps: row.fee_bps }).totalMicro
  if (fair < billed && !reasons.includes("tokens_overcounted") && !reasons.includes("price_above_sheet")) reasons.push("cost_mismatch")
  return done(fair < billed ? billed - fair : 0n)
}

function materialFor(material: z.infer<typeof disputeBody>["material"], reqId: string, only: boolean) {
  if (!material) return undefined
  if (Array.isArray(material)) return material.find((row) => row.req_id === reqId) ?? (only ? material[0] : undefined)
  return material.req_id === reqId || only ? material : undefined
}

export async function openDispute(stack: Stack, wallet: string, raw: unknown) {
  const body = disputeBody.safeParse(raw)
  if (!body.success) return { error: "bad_dispute" as const }
  const reqIds = [...new Set(body.data.req_ids)]
  const now = stack.clock()
  const rows = await stack.db.query<UsageRow>("SELECT * FROM shared.usage_records WHERE req_id = ANY($1) AND payer = $2", [reqIds, wallet])
  if (rows.rows.length !== reqIds.length) return { error: "unknown_request" as const }
  if (rows.rows.some((row) => now - Number(row.ts) > DISPUTE_WINDOW_S)) return { error: "dispute_window" as const }
  const id = `dsp_${randomBytes(12).toString("hex")}`
  const checks = await Promise.all(rows.rows.map((row) => checkRecord(stack, row, materialFor(body.data.material, row.req_id, reqIds.length === 1))))
  const materialHash = body.data.material ? keccakUtf8(JSON.stringify(body.data.material)) : null
  const decided = await stack.db.transaction(async (tx) => {
    // One dispute per wallet at a time, so two at once cannot refund a record twice.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [wallet])
    const refunded = await tx.query<{ req_ids: string[] }>("SELECT req_ids FROM shared.refunds WHERE payer = $1 AND id LIKE 'dispute:%' AND req_ids && $2::text[]", [wallet, reqIds])
    const paid = new Set(refunded.rows.flatMap((row) => row.req_ids))
    for (const check of checks) {
      if (!paid.has(check.req_id) || !check.upheld) continue
      check.upheld = false
      check.refund_micro = "0"
      check.reasons.push("already_refunded")
    }
    const upheld = checks.filter((check) => check.upheld)
    const refundMicro = upheld.reduce((sum, check) => sum + BigInt(check.refund_micro), 0n)
    const refundId = refundMicro > 0n ? `dispute:${id}` : null
    const outcome = refundId ? "upheld" : "rejected"
    if (refundId) {
      await tx.query("INSERT INTO shared.refunds (id, payer, amount, reason, req_ids) VALUES ($1,$2,$3,$4,$5)", [refundId, wallet, refundMicro.toString(), "dispute_upheld", upheld.map((check) => check.req_id)])
    }
    for (const check of upheld) {
      const row = rows.rows.find((r) => r.req_id === check.req_id)!
      await tx.query("INSERT INTO serving.metering_flags (req_id, host, router_counts, host_counts, reason) VALUES ($1,$2,$3::jsonb,'{}'::jsonb,'dispute_upheld') ON CONFLICT (req_id) DO NOTHING", [
        check.req_id,
        row.host,
        JSON.stringify({ tokensIn: row.tokens_in, tokensOut: row.tokens_out }),
      ])
    }
    await tx.query("INSERT INTO serving.disputes (id, wallet, req_ids, reason, submitted_material_hash, status, outcome, refund_id, refund_micro, checks, created_at) VALUES ($1,$2,$3,$4,$5,'decided',$6,$7,$8,$9::jsonb,$10)", [
      id,
      wallet,
      reqIds,
      body.data.reason,
      materialHash,
      outcome,
      refundId,
      refundMicro.toString(),
      JSON.stringify(checks),
      now,
    ])
    return { outcome, refundId, refundMicro }
  })
  return { id, status: "decided" as const, outcome: decided.outcome, refund_id: decided.refundId, refund_micro: decided.refundMicro.toString(), checks }
}

type DisputeRow = { id: string; wallet: string; req_ids: string[]; reason: string; status: string; outcome: string | null; refund_id: string | null; refund_micro: string; checks: DisputeCheck[]; created_at: string }

/** A wallet's disputes, newest first. */
export async function listDisputes(stack: Stack, wallet: string) {
  const rows = await stack.db.query<DisputeRow>("SELECT id, wallet, req_ids, reason, status, outcome, refund_id, refund_micro, checks, created_at FROM serving.disputes WHERE wallet = $1 ORDER BY created_at DESC LIMIT 200", [wallet])
  return rows.rows.map((row) => ({
    id: row.id,
    reqIds: row.req_ids,
    reason: row.reason,
    status: row.status,
    outcome: row.outcome,
    refundId: row.refund_id,
    refundMicro: String(row.refund_micro),
    checks: row.checks,
    createdAt: Number(row.created_at),
  }))
}
