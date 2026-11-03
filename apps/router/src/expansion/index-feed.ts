import { createHash } from "node:crypto"
import { CHAIN_ID } from "@offpeak/shared"
import type { Stack } from "../context.ts"

export type Print = {
  id: string
  ts: number
  payer: string
  host: string
  model: string
  input: number
  output: number
  cost: string
  fee: string
  settled: boolean
}
export const INDEX_POLICY = { version: 1, minBuyers: 5, minHosts: 3, minRecords: 10, maxHostShareBps: 5000, maxRecords: 10000 } as const
const lower = (s: string) => s.toLowerCase()

/** Prices describe paid, settled receipts. A sparse or concentrated market gets no price. */
export function aggregatePrints(prints: Print[]) {
  const unique = new Map<string, Print>()
  for (const p of prints) {
    if (
      !p.settled ||
      lower(p.payer) === lower(p.host) ||
      p.input < 0 ||
      p.output < 0 ||
      p.input + p.output === 0 ||
      BigInt(p.cost) <= 0n ||
      BigInt(p.fee) < 0n
    )
      continue
    unique.set(lower(p.id), p)
  }
  const rows = [...unique.values()],
    hosts = new Map<string, bigint>()
  let cost = 0n,
    tokens = 0n
  for (const row of rows) {
    const n = BigInt(row.input + row.output)
    tokens += n
    cost += BigInt(row.cost) + BigInt(row.fee)
    hosts.set(lower(row.host), (hosts.get(lower(row.host)) ?? 0n) + n)
  }
  const buyers = new Set(rows.map((r) => lower(r.payer))).size
  const maxShare = tokens ? Number(([...hosts.values()].reduce((a, b) => (a > b ? a : b), 0n) * 10000n) / tokens) : 0
  const reason =
    rows.length < INDEX_POLICY.minRecords
      ? "insufficient_records"
      : buyers < INDEX_POLICY.minBuyers
        ? "insufficient_buyers"
        : hosts.size < INDEX_POLICY.minHosts
          ? "insufficient_hosts"
          : maxShare > INDEX_POLICY.maxHostShareBps
            ? "concentrated_supply"
            : null
  return {
    status: reason ? "insufficient_data" : "published",
    reason,
    records: rows.length,
    buyers,
    hosts: hosts.size,
    largestHostShareBps: maxShare,
    tokens: tokens.toString(),
    buyerCostMicro: cost.toString(),
    blendedMicroPerMillion: reason ? null : ((cost * 1000000n) / tokens).toString(),
    receiptIds: rows.map((r) => r.id).sort(),
  }
}

/** Domain-separated signed JSON; wallets/addresses of buyers never leave this function. */
export async function indexFeed(stack: Stack) {
  const end = Math.floor(stack.clock() / 3600) * 3600,
    start = end - 86400
  const result = await stack.db.query<{
    req_id: string
    ts: string
    payer: string
    host: string
    model_digest: string
    tokens_in: number
    tokens_out: number
    host_cost_micro: string
    fee_micro: string
  }>(
    `SELECT u.req_id,u.ts,u.payer,u.host,u.model_digest,u.tokens_in,u.tokens_out,u.host_cost_micro,u.fee_micro
     FROM shared.usage_records u
     WHERE u.ts >= $1 AND u.ts < $2 AND u.status='final' AND u.settled_hour_tx IS NOT NULL AND u.pay_mode <> 4
       AND (u.pay_mode = 0 OR EXISTS (SELECT 1 FROM shared.agent_payments a WHERE u.req_id = ANY(a.req_ids) AND a.collected_tx IS NOT NULL AND a.drawn_hour IS NOT NULL AND a.written_off_hour IS NULL))
       AND NOT EXISTS (SELECT 1 FROM shared.refunds r WHERE u.req_id = ANY(r.req_ids))
     ORDER BY u.ts,u.req_id LIMIT $3`,
    [start, end, INDEX_POLICY.maxRecords + 1],
  )
  const overflow = result.rows.length > INDEX_POLICY.maxRecords
  const groups = new Map<string, Print[]>()
  if (!overflow)
    for (const r of result.rows) {
      const key = `${r.model_digest}:${Math.floor(Number(r.ts) / 3600) * 3600}`
      const p: Print = {
        id: r.req_id,
        ts: Number(r.ts),
        payer: r.payer,
        host: r.host,
        model: r.model_digest,
        input: r.tokens_in,
        output: r.tokens_out,
        cost: String(r.host_cost_micro),
        fee: String(r.fee_micro),
        settled: true,
      }
      groups.set(key, [...(groups.get(key) ?? []), p])
    }
  const points = [...groups.values()]
    .map((rows) => ({ modelDigest: rows[0]!.model, hour: Math.floor(rows[0]!.ts / 3600) * 3600, ...aggregatePrints(rows) }))
    .sort((a, b) => a.hour - b.hour || a.modelDigest.localeCompare(b.modelDigest))
  const payload = {
    schema: "offpeak-index-v1",
    chainId: CHAIN_ID,
    usageLedger: stack.usageLedger,
    start,
    end,
    asOf: stack.clock(),
    expiresAt: stack.clock() + 120,
    currency: "USDG",
    unit: "micro-USDG per 1M combined input/output tokens, buyer fees included",
    policy: INDEX_POLICY,
    status: overflow ? "volume_limit" : points.some((p) => p.status === "published") ? "published" : "insufficient_data",
    points,
    limitations: [
      "Same-wallet self-payments excluded; distinct wallets are not proof of distinct people.",
      "Prices are grouped by exact model digest; no quality equivalence is assumed.",
      "A router signature authenticates the publisher, not market independence.",
      "No slot occupancy or peak/off-peak spread is published without measured slot data.",
    ],
  }
  const message = JSON.stringify(payload),
    hash = createHash("sha256").update(message).digest("hex")
  return {
    payload,
    hash: `sha256:${hash}`,
    signer: stack.router.address,
    signature: await stack.router.signMessage({ message: `OFFPEAK_INDEX_V1\n${hash}` }),
  }
}
