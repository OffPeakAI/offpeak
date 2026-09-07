import { OffpeakVaultAbi, OfpkHooksAbi, WindowMarketAbi } from "@offpeak/abis"
import { firstBlockAtOrAfter, type Db } from "@offpeak/common"
import { dayIndex, hourEnd, hourIndex, hourStart } from "@offpeak/shared"
import { keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem"
import { WRITE_OFF_AFTER_HOURS, unusedTokens, windowKey, type BuyerFacts, type HourInput, type PaymentRow, type WindowFacts } from "./build.ts"
import type { UsageRow, VerifyContext } from "./verify.ts"

export const HOUR_CLOSE_GRACE_S = 600
/** With no router close by this long after the hour, signers settle from the rows themselves. */
export const CLOSE_FALLBACK_S = 1800

const CHUNK = 25

export type GatherDeps = {
  db: Db
  reader: PublicClient
  chainId: number
  contracts: Record<string, Address>
  routerAddress: Address
}

export type Gathered = { input: HourInput; pin: bigint } | { waiting: string }

async function chunked<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += CHUNK) {
    out.push(...(await Promise.all(items.slice(i, i + CHUNK).map(fn))))
  }
  return out
}

async function windowFacts(deps: GatherDeps, rows: UsageRow[], blockNumber: bigint) {
  const facts = new Map<string, WindowFacts>()
  const market = deps.contracts.WindowMarket
  if (!market) return facts
  const held = [...new Map(rows.filter((r) => r.pay_mode === 4 && r.window_id !== null).map((r) => [windowKey(r.window_id, r.payer), r])).values()]
  const reads = await chunked(held, async (row) => {
    const contract = { address: market, abi: WindowMarketAbi, blockNumber }
    const id = BigInt(row.window_id!)
    const [window, holder] = await Promise.all([
      deps.reader.readContract({ ...contract, functionName: "windowView", args: [id] }),
      deps.reader.readContract({ ...contract, functionName: "holderView", args: [id, row.payer as Address] }),
    ])
    return { key: windowKey(row.window_id, row.payer), window, holder }
  })
  for (const { key, window, holder } of reads) {
    facts.set(key, {
      available: unusedTokens(holder.balance, holder.drawnTokens),
      firstHour: hourIndex(Number(window.t0)),
      endHour: hourIndex(Number(window.t1)),
      host: window.host.toLowerCase(),
    })
  }
  return facts
}

/** Every signer reads the chain at the same block, so they all see the same facts. */
async function pinBlock(deps: GatherDeps, hour: number): Promise<bigint | null> {
  const closed = await firstBlockAtOrAfter(deps.reader, hourEnd(hour) + HOUR_CLOSE_GRACE_S)
  if (closed === null) return null
  const previous = await deps.db.query<{ block: string }>("SELECT block FROM chain.settlements WHERE hour = $1", [hour - 1])
  const settledAt = previous.rows[0] ? BigInt(previous.rows[0].block) : 0n
  return settledAt > closed ? settledAt : closed
}

async function buyerFacts(deps: GatherDeps, payer: Address, hour: number, blockNumber: bigint): Promise<BuyerFacts> {
  const vault = { address: deps.contracts.OffpeakVault!, abi: OffpeakVaultAbi, blockNumber }
  const [caps, state, dayDebit] = await Promise.all([
    deps.reader.readContract({ ...vault, functionName: "effectiveCaps", args: [payer, BigInt(hour)] }),
    deps.reader.readContract({ ...vault, functionName: "buyerState", args: [payer] }),
    deps.reader.readContract({ ...vault, functionName: "dayDebit", args: [payer] }),
  ])
  return {
    hourlyCap: caps[0],
    dailyCap: caps[1],
    withdrawRequestedAt: state.withdrawRequestedAt,
    dayDebited: dayDebit[0] === BigInt(dayIndex(hourStart(hour))) ? dayDebit[1] : 0n,
  }
}

type PaymentDbRow = {
  payment_id: string
  payer: string
  amount_micro: string
  req_ids: string[]
  collected_hour: string | null
  written_off_hour: string | null
  created_at: string
}

/** A payment waits for its records, except one whose records never arrive, which goes after a day. */
function readyToSettle(row: PaymentDbRow, known: { hour: string }[], hour: number) {
  const latest = known.reduce((max, r) => Math.max(max, Number(r.hour)), 0)
  if (latest > hour) return false
  if (row.collected_hour === null && latest > hour - WRITE_OFF_AFTER_HOURS) return false
  return known.length === row.req_ids.length || Number(row.created_at) <= hourStart(hour - WRITE_OFF_AFTER_HOURS)
}

async function readPayments(db: Db, hour: number): Promise<PaymentRow[]> {
  const rows = await db.query<PaymentDbRow>(
    `SELECT payment_id, payer, amount_micro, req_ids, collected_hour, written_off_hour, EXTRACT(EPOCH FROM created_at)::bigint AS created_at
     FROM shared.agent_payments
     WHERE drawn_hour IS NULL AND (collected_hour IS NULL OR collected_hour <= $1) AND (written_off_hour IS NULL OR collected_hour IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM chain.swept_payments s WHERE s.source = payment_id)`,
    [hour],
  )
  const payments: PaymentRow[] = []
  for (const row of rows.rows) {
    const base = {
      paymentId: row.payment_id as Hex,
      payer: row.payer as Address,
      amountMicro: BigInt(row.amount_micro),
      reqIds: row.req_ids,
    }
    if (row.written_off_hour !== null) {
      payments.push({ ...base, covered: [], writeOff: false, recoveredMicro: 0n, lateCollection: true })
      continue
    }
    const known = await db.query<{ req_id: string; host: string; host_cost_micro: string; fee_micro: string; hour: string; rejected: boolean; orphaned: boolean }>(
      `SELECT r.req_id, r.host, r.host_cost_micro, r.fee_micro, r.hour,
         EXISTS (SELECT 1 FROM chain.settlement_rejects x WHERE x.req_id = r.req_id) AS rejected,
         EXISTS (SELECT 1 FROM chain.orphan_writeoffs o WHERE o.req_id = r.req_id) AS orphaned
       FROM shared.usage_records r WHERE r.req_id = ANY($1) AND r.status = 'final'`,
      [row.req_ids],
    )
    if (!readyToSettle(row, known.rows, hour)) continue
    const cost = (r: { host_cost_micro: string; fee_micro: string }) => BigInt(r.host_cost_micro) + BigInt(r.fee_micro)
    payments.push({
      ...base,
      covered: known.rows
        .filter((r) => !r.rejected && !r.orphaned)
        .map((r) => ({ reqId: r.req_id, host: r.host, hostCost: BigInt(r.host_cost_micro), fee: BigInt(r.fee_micro) }))
        .sort((a, b) => (a.reqId < b.reqId ? -1 : 1)),
      writeOff: row.collected_hour === null,
      recoveredMicro: known.rows.filter((r) => r.orphaned).reduce((sum, r) => sum + cost(r), 0n),
      lateCollection: false,
    })
  }
  return payments
}

/** Served agent records that no payment names still owe their hosts, so they write off like any other. */
async function readOrphans(db: Db, hour: number): Promise<PaymentRow[]> {
  const rows = await db.query<{ req_id: string; payer: string; host: string; host_cost_micro: string; fee_micro: string }>(
    `SELECT r.req_id, r.payer, r.host, r.host_cost_micro, r.fee_micro FROM shared.usage_records r
     WHERE r.pay_mode BETWEEN 1 AND 3 AND r.status = 'final' AND r.hour <= $1
       AND NOT EXISTS (SELECT 1 FROM chain.settlement_rejects x WHERE x.req_id = r.req_id)
       AND NOT EXISTS (SELECT 1 FROM chain.orphan_writeoffs o WHERE o.req_id = r.req_id)
       AND NOT EXISTS (SELECT 1 FROM shared.agent_payments p WHERE r.req_id = ANY(p.req_ids))`,
    [hour - WRITE_OFF_AFTER_HOURS],
  )
  return rows.rows.map((r) => {
    const hostCost = BigInt(r.host_cost_micro)
    const fee = BigInt(r.fee_micro)
    return {
      paymentId: keccak256(r.req_id as Hex),
      payer: r.payer as Address,
      amountMicro: hostCost + fee,
      reqIds: [r.req_id],
      covered: [{ reqId: r.req_id, host: r.host, hostCost, fee }],
      writeOff: true,
      recoveredMicro: 0n,
      lateCollection: false,
      orphanReqId: r.req_id,
    }
  })
}
