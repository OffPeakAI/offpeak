import { parseRecord, serializeEnvelope, type Hex, type UsageRecordJson } from "@offpeak/shared"
import { z } from "zod"
import { sessionWallet } from "../auth/siwe.ts"
import { oai } from "../http.ts"
import { auth, type Stack } from "../pipeline.ts"

const LIST_MAX = 100
const LIST_DEFAULT = 50

type Row = {
  req_id: Hex
  hour: string
  ts: string
  buyer_ref: Hex
  host: Hex
  model_digest: Hex
  tokens_in: number
  tokens_out: number
  prompt_hash: Hex
  output_hash: Hex
  price_in: string
  price_out: string
  host_cost_micro: string
  fee_micro: string
  pay_mode: UsageRecordJson["payMode"]
  pay_ref: Hex
  sheet_hash: Hex
  router_sig: Hex
  host_sig: Hex
  leaf: Hex
  sealed: boolean
  status: string
  host_counts: { tokensIn: number; tokensOut: number } | null
}

const SELECT = `SELECT u.req_id, u.hour, u.ts, u.buyer_ref, u.host, u.model_digest, u.tokens_in, u.tokens_out, u.prompt_hash, u.output_hash,
  u.price_in, u.price_out, u.host_cost_micro, u.fee_micro, u.pay_mode, u.pay_ref, u.sheet_hash, u.router_sig, u.host_sig, u.leaf, u.sealed, u.status, r.host_counts
  FROM shared.usage_records u LEFT JOIN serving.requests r ON r.req_id = u.req_id`

function envelopeOf(row: Row) {
  const record = parseRecord({
    reqId: row.req_id,
    buyerRef: row.buyer_ref,
    host: row.host,
    modelDigest: row.model_digest,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    promptHash: row.prompt_hash,
    outputHash: row.output_hash,
    priceIn: String(row.price_in),
    priceOut: String(row.price_out),
    hostCostMicro: String(row.host_cost_micro),
    feeMicro: String(row.fee_micro),
    payMode: row.pay_mode,
    payRef: row.pay_ref,
    ts: Number(row.ts),
    sheetHash: row.sheet_hash,
  })
  // A record written before hosts' counts were kept reports the billed counts, which the host signed.
  const hostCounts = row.host_counts ?? { tokensIn: row.tokens_in, tokensOut: row.tokens_out }
  return serializeEnvelope({ v: 1, record, routerSig: row.router_sig, hostSig: row.host_sig, leaf: row.leaf, hostCounts, sealed: row.sealed, proofUrl: `/v1/usage/${row.req_id}` })
}

/** The proof URL every envelope carries. A record names no wallet, and a request id cannot be guessed. */
export async function usageRecord(stack: Stack, reqId: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(reqId)) return null
  const id = reqId.toLowerCase()
  const rows = await stack.db.query<Row>(`${SELECT} WHERE u.req_id = $1`, [id])
  const row = rows.rows[0]
  if (!row) return null
  return { envelope: envelopeOf(row), proof: (await stack.indexer.proof(id)) ?? null }
}

const listQuery = z.object({
  since: z.union([z.string().regex(/^\d{1,12}$/).transform(Number), z.iso.datetime({ offset: true }).transform((value) => Math.floor(Date.parse(value) / 1000))]).default(0),
  limit: z.coerce.number().int().min(1).max(LIST_MAX).default(LIST_DEFAULT),
  before_ts: z.coerce.number().int().nonnegative().optional(),
  before_id: z.string().regex(/^0x[0-9a-f]{64}$/).optional(),
})

/** Only an API key or a signed-in session lists records. Anything else on the request does not count. */
async function buyerOf(stack: Stack, req: Request) {
  const authorization = req.headers.get("authorization")
  if (!authorization) return null
  if (authorization.startsWith("Bearer sess_")) return sessionWallet(stack, authorization)
  const payer = await auth(stack, new Request(req.url, { headers: { authorization } }))
  if (payer instanceof Response) return payer.status === 429 ? payer : null
  return payer.mode === 0 ? payer.wallet : null
}

/** The caller's own records, newest first. `before_ts` and `before_id` carry on from `next`. */
export async function serveUsageList(stack: Stack, req: Request) {
  const buyer = await buyerOf(stack, req)
  if (buyer instanceof Response) return buyer
  if (!buyer) return oai(401, "Send an API key or sign in", "auth", "no_key")
  const parsed = listQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams))
  if (!parsed.success) return oai(400, "since is a unix time or ISO 8601, and limit is 1 to 100", "invalid_request", "bad_query")
  const { since, limit, before_ts: beforeTs, before_id: beforeId } = parsed.data
  const cursor = beforeTs !== undefined && beforeId ? { ts: beforeTs, reqId: beforeId } : null
  const rows = await stack.db.query<Row>(
    `${SELECT} WHERE u.payer = $1 AND u.ts >= $2 AND ($3::bigint IS NULL OR (u.ts, u.req_id) < ($3::bigint, $4::text))
     ORDER BY u.ts DESC, u.req_id DESC LIMIT $5`,
    [buyer, since, cursor?.ts ?? null, cursor?.reqId ?? null, limit + 1],
  )
  const page = rows.rows.slice(0, limit)
  const last = page.at(-1)
  return Response.json({
    records: page.map((row) => ({ envelope: envelopeOf(row), status: row.status })),
    next: rows.rows.length > limit && last ? { before_ts: Number(last.ts), before_id: last.req_id } : null,
  })
}
