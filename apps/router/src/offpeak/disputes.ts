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
