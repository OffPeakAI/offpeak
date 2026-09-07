import { domain, emptyTotals, hourEnd, merkleRoot, settleTypes, totalsHashOf, type RootTotals } from "@offpeak/shared"
import { encodeAbiParameters, hashTypedData, keccak256, type Address, type Hex } from "viem"
import { verifyRecord, type RejectReason, type UsageRow, type VerifyContext } from "./verify.ts"

export const WRITE_OFF_AFTER_HOURS = 24

/**
 * Measured worst cases from `contracts/test/gas`. A settle above the chain's 32M limit could never land
 * and the hour could never split, so the builder keeps every batch under it by rule.
 */
const GAS_BUDGET = 30_000_000
const GAS_BASE = 1_000_000
const GAS_NEW_DEBIT = 62_000
const GAS_REPEAT_DEBIT = 25_000
const GAS_CREDIT = 145_000
const GAS_WINDOW_DRAW = 70_000
const MAX_WINDOW_DRAWS = 500
const UNIT_TOKENS = 1_000_000n

export type BuyerFacts = {
  hourlyCap: bigint
  dailyCap: bigint
  withdrawRequestedAt: bigint
  /** What the vault has already debited this buyer on the hour's UTC day. */
  dayDebited: bigint
}

export type PaymentRow = {
  paymentId: Hex
  payer: Address
  amountMicro: bigint
  reqIds: string[]
  /** Records this payment covers that settlement has not excluded. */
  covered: { reqId: string; host: string; hostCost: bigint; fee: bigint }[]
  writeOff: boolean
  /** Records in this payment the reserve already paid for. Their money joins fees. */
  recoveredMicro: bigint
  /** Written off before its money arrived, so the late funds join fees. */
  lateCollection: boolean
  /** Set on a write-off for one record that no payment ever covered. */
  orphanReqId?: string
  /** Set on money that reached the pool with no payment row, naming where it came from. */
  sweptFrom?: string
}

export type Sweep = { paymentId: Hex; source: string; amount: bigint }
export type PayerRefund = { id: string; payer: Address; amount: bigint; reason: string; reqIds: string[] }

/** What the chain says a holder can still draw from a Window, read at the pinned block. */
export type WindowFacts = { available: bigint; firstHour: number; endHour: number; host: string }

export const windowKey = (windowId: string | null, holder: string) => `${windowId}:${holder}`
export const unusedTokens = (balance: bigint, drawn: bigint) => balance * UNIT_TOKENS - drawn

export type HourInput = {
  hour: number
  chainId: number
  vault: Address
  rows: UsageRow[]
  buyers: Map<string, BuyerFacts>
  payments: PaymentRow[]
  protocolReserve: bigint
  agentPool: bigint
  windows: Map<string, WindowFacts>
  closeRoot: string | null
  ctx: VerifyContext
}

export type Reject = { reqId: string; reason: RejectReason }

type Debit = { buyer: Address; amount: bigint; lastTs: bigint }
type Credit = { host: Address; amount: bigint }
type WindowDraw = { windowId: bigint; holder: Address; tokens: bigint }

export type SettleBatch = {
  chainId: bigint
  vault: Address
  hour: bigint
  root: Hex
  totalsHash: Hex
  debits: Debit[]
  credits: Credit[]
  windowDraws: WindowDraw[]
  fees: bigint
  agentPoolDraw: bigint
  reserveDraw: bigint
  agentPaymentsHash: Hex
}

export type BuiltHour = {
  b: SettleBatch
  t: RootTotals
  batchHash: Hex
  rejects: Reject[]
  drawn: Hex[]
  writtenOff: Hex[]
  orphans: string[]
  swept: Sweep[]
  refunds: PayerRefund[]
  closeMatched: boolean
}

function totalsOf(rows: UsageRow[]): RootTotals {
  const totals = emptyTotals()
  totals.records = rows.length
  for (const row of rows) {
    const hostCost = BigInt(row.host_cost_micro)
    const fee = BigInt(row.fee_micro)
    totals.tokensIn += BigInt(row.tokens_in)
    totals.tokensOut += BigInt(row.tokens_out)
    if (row.pay_mode === 0) totals.prepaidDebit += hostCost + fee
    if (row.pay_mode >= 1 && row.pay_mode <= 3) totals.agentCollected += hostCost + fee
    if (row.pay_mode === 4) totals.windowDrawn += BigInt(row.tokens_in + row.tokens_out)
    if (row.pay_mode !== 4) {
      totals.hostCredit += hostCost
      totals.fees += fee
    }
  }
  return totals
}

const byTsThenId = (a: UsageRow, b: UsageRow) => Number(a.ts) - Number(b.ts) || (a.req_id < b.req_id ? -1 : 1)

/**
 * Applies what the vault would refuse, record by record in time order, so a router bug costs
 * the protocol that record's revenue and never stalls the hour.
 */
function applyBuyerLimits(rows: UsageRow[], input: HourInput, rejects: Reject[]): UsageRow[] {
  const spent = new Map<string, bigint>()
  const kept: UsageRow[] = []
  for (const row of [...rows].sort(byTsThenId)) {
    if (row.pay_mode !== 0) {
      kept.push(row)
      continue
    }
    const facts = input.buyers.get(row.payer)
    const requestedAt = facts?.withdrawRequestedAt ?? 0n
    if (requestedAt !== 0n && BigInt(row.ts) > requestedAt) {
      rejects.push({ reqId: row.req_id, reason: "after_withdraw_request" })
      continue
    }
    const cost = BigInt(row.host_cost_micro) + BigInt(row.fee_micro)
    const total = (spent.get(row.payer) ?? 0n) + cost
    if (total > (facts?.hourlyCap ?? 0n)) {
      rejects.push({ reqId: row.req_id, reason: "over_hourly_cap" })
      continue
    }
    if ((facts?.dayDebited ?? 0n) + total > (facts?.dailyCap ?? 0n)) {
      rejects.push({ reqId: row.req_id, reason: "over_daily_cap" })
      continue
    }
    spent.set(row.payer, total)
    kept.push(row)
  }
  return kept.sort((a, b) => (a.req_id < b.req_id ? -1 : 1))
}

/** A draw the holder cannot cover leaves the batch, since the contract would otherwise shrink it unseen. */
function applyWindowLimits(rows: UsageRow[], input: HourInput, rejects: Reject[]): UsageRow[] {
  const spent = new Map<string, bigint>()
  const excluded = new Set<string>()
  for (const row of [...rows].sort(byTsThenId)) {
    if (row.pay_mode !== 4) continue
    const key = windowKey(row.window_id, row.payer)
    const facts = input.windows.get(key)
    const total = (spent.get(key) ?? 0n) + BigInt(row.tokens_in + row.tokens_out)
    const inside = facts !== undefined && input.hour >= facts.firstHour && input.hour < facts.endHour
    if (!inside || total > facts.available || facts.host !== row.host) {
      excluded.add(row.req_id)
      rejects.push({ reqId: row.req_id, reason: "over_window_balance" })
      continue
    }
    spent.set(key, total)
  }
  return rows.filter((row) => !excluded.has(row.req_id))
}
