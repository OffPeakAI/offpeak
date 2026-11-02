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

/**
 * Past the gas limit the smallest buyers and draws wait out of the batch, so the hour lands and the
 * exclusion is public. Whatever room is left goes to agent payments, which can simply wait an hour.
 */
function applyGasBudget(rows: UsageRow[], input: HourInput, rejects: Reject[]) {
  const hosts = new Set(rows.filter((r) => r.pay_mode === 0).map((r) => r.host))
  let left = GAS_BUDGET - GAS_BASE - hosts.size * GAS_CREDIT
  const owed = new Map<string, bigint>()
  for (const row of rows) {
    if (row.pay_mode === 0) owed.set(row.payer, (owed.get(row.payer) ?? 0n) + BigInt(row.host_cost_micro) + BigInt(row.fee_micro))
  }
  const largestFirst = [...owed].sort(([a, x], [b, y]) => (x === y ? (a < b ? -1 : 1) : x > y ? -1 : 1))
  const excluded = new Set<string>()
  for (const [payer] of largestFirst) {
    const gas = (input.buyers.get(payer)?.dayDebited ?? 0n) > 0n ? GAS_REPEAT_DEBIT : GAS_NEW_DEBIT
    if (gas > left) excluded.add(payer)
    else left -= gas
  }
  const draws = windowDrawsOf(rows).sort((a, b) => (a.tokens === b.tokens ? 0 : a.tokens > b.tokens ? -1 : 1))
  const excludedDraws = new Set<string>()
  draws.forEach((draw, i) => {
    if (i >= MAX_WINDOW_DRAWS || GAS_WINDOW_DRAW > left) excludedDraws.add(windowKey(draw.windowId.toString(), draw.holder))
    else left -= GAS_WINDOW_DRAW
  })
  const dropped = (row: UsageRow) =>
    (row.pay_mode === 0 && excluded.has(row.payer)) || (row.pay_mode === 4 && excludedDraws.has(windowKey(row.window_id, row.payer)))
  for (const row of rows) {
    if (dropped(row)) rejects.push({ reqId: row.req_id, reason: "over_batch_capacity" })
  }
  return { kept: rows.filter((row) => !dropped(row)), gasLeft: left }
}

function debitsOf(rows: UsageRow[]): Debit[] {
  const byBuyer = new Map<string, Debit>()
  for (const row of rows) {
    if (row.pay_mode !== 0) continue
    const cost = BigInt(row.host_cost_micro) + BigInt(row.fee_micro)
    const debit = byBuyer.get(row.payer) ?? { buyer: row.payer as Address, amount: 0n, lastTs: 0n }
    debit.amount += cost
    if (BigInt(row.ts) > debit.lastTs) debit.lastTs = BigInt(row.ts)
    byBuyer.set(row.payer, debit)
  }
  return [...byBuyer.values()].sort((a, b) => (a.buyer < b.buyer ? -1 : 1))
}

function windowDrawsOf(rows: UsageRow[]): WindowDraw[] {
  const draws = new Map<string, WindowDraw>()
  for (const row of rows) {
    if (row.pay_mode !== 4 || row.window_id === null) continue
    const key = `${row.window_id}:${row.payer}`
    const draw = draws.get(key) ?? { windowId: BigInt(row.window_id), holder: row.payer as Address, tokens: 0n }
    draw.tokens += BigInt(row.tokens_in + row.tokens_out)
    draws.set(key, draw)
  }
  return [...draws.values()].sort((a, b) =>
    a.windowId === b.windowId ? (a.holder < b.holder ? -1 : 1) : a.windowId < b.windowId ? -1 : 1,
  )
}

type Payout = { hostCredits: Map<string, bigint>; fees: bigint }

function addRecord(payout: Payout, host: string, hostCost: bigint, fee: bigint) {
  payout.hostCredits.set(host, (payout.hostCredits.get(host) ?? 0n) + hostCost)
  payout.fees += fee
}

/**
 * Every collected unit a payment owes leaves the pool, so no hour stalls. A payment that paid for an
 * excluded record hands the difference back to its payer as a refund, and a host never gets paid for
 * a record this hour excluded. The vault pays refunds from the reserve, so that difference stays in
 * the pool, because drawing it into fees would spend the same money twice.
 */
function applyPayments(input: HourInput, payout: Payout, excluded: Set<string>, gasLeft: number) {
  const drawn: Hex[] = []
  const writtenOff: Hex[] = []
  const orphans: string[] = []
  const swept: Sweep[] = []
  const refunds: PayerRefund[] = []
  let agentPoolDraw = 0n
  let reserveDraw = 0n
  // A draw past the pool would revert the whole hour, so a bad row waits instead.
  const poolCovers = (amount: bigint) => agentPoolDraw + amount <= input.agentPool
  let creditRoom = gasLeft
  // New hosts cost gas in this batch. A payment that does not fit stays undrawn until a later hour.
  const roomFor = (hosts: string[]) => {
    const fresh = new Set(hosts.filter((host) => !payout.hostCredits.has(host)))
    if (fresh.size * GAS_CREDIT > creditRoom) return false
    creditRoom -= fresh.size * GAS_CREDIT
    return true
  }
  const ordered = [...input.payments].sort((a, b) => (a.paymentId < b.paymentId ? -1 : 1))
  for (const payment of ordered) {
    if (payment.lateCollection) {
      if (!poolCovers(payment.amountMicro)) continue
      agentPoolDraw += payment.amountMicro
      payout.fees += payment.amountMicro
      drawn.push(payment.paymentId)
      if (payment.sweptFrom) swept.push({ paymentId: payment.paymentId, source: payment.sweptFrom, amount: payment.amountMicro })
      continue
    }
    const covered = payment.covered.filter((c) => !excluded.has(c.reqId))
    const cost = covered.reduce((sum, c) => sum + c.hostCost + c.fee, 0n)
    if (!roomFor(covered.map((c) => c.host))) continue
    if (payment.writeOff) {
      if (reserveDraw + cost > input.protocolReserve) continue
      reserveDraw += cost
      writtenOff.push(payment.paymentId)
      if (payment.orphanReqId) orphans.push(payment.orphanReqId)
    } else {
      const due = cost + payment.recoveredMicro
      const shortfall = due > payment.amountMicro ? due - payment.amountMicro : 0n
      const draw = payment.amountMicro < due ? payment.amountMicro : due
      if (reserveDraw + shortfall > input.protocolReserve || !poolCovers(draw)) continue
      reserveDraw += shortfall
      agentPoolDraw += draw
      payout.fees += payment.recoveredMicro
      drawn.push(payment.paymentId)
      if (payment.amountMicro > due) {
        refunds.push({ id: `agent-excess:${payment.paymentId}`, payer: payment.payer, amount: payment.amountMicro - due, reason: "excluded_record", reqIds: payment.reqIds })
      }
    }
    for (const c of covered) addRecord(payout, c.host, c.hostCost, c.fee)
  }
  return { drawn, writtenOff, orphans, swept, refunds, agentPoolDraw, reserveDraw }
}

export function batchHashOf(b: SettleBatch): Hex {
  return hashTypedData({
    domain: domain("OffpeakSettlement", b.vault, Number(b.chainId)),
    types: settleTypes,
    primaryType: "SettleBatch",
    message: b,
  })
}

/** Pure over its input: every signer given the same hour produces the same batch hash. */
export async function buildBatch(input: HourInput): Promise<BuiltHour> {
  const rejects: Reject[] = []
  const valid: UsageRow[] = []
  for (const row of input.rows) {
    const reason = await verifyRecord(row, input.ctx)
    if (reason) rejects.push({ reqId: row.req_id, reason })
    else valid.push(row)
  }
  const { kept, gasLeft } = applyGasBudget(applyWindowLimits(applyBuyerLimits(valid, input, rejects), input, rejects), input, rejects)
  rejects.sort((a, b) => (a.reqId < b.reqId ? -1 : 1))

  const payout: Payout = { hostCredits: new Map(), fees: 0n }
  for (const row of kept) {
    if (row.pay_mode === 0) addRecord(payout, row.host, BigInt(row.host_cost_micro), BigInt(row.fee_micro))
  }
  const excluded = new Set(rejects.map((r) => r.reqId))
  const { drawn, writtenOff, orphans, swept, refunds, agentPoolDraw, reserveDraw } = applyPayments(input, payout, excluded, gasLeft)

  const t = totalsOf(kept)
  const root = merkleRoot(kept.map((row) => row.leaf as Hex))
  const paymentIds = [...drawn, ...writtenOff].sort()
  const b: SettleBatch = {
    chainId: BigInt(input.chainId),
    vault: input.vault,
    hour: BigInt(input.hour),
    root,
    totalsHash: totalsHashOf(t),
    debits: debitsOf(kept),
    credits: [...payout.hostCredits]
      .filter(([, amount]) => amount > 0n)
      .map(([host, amount]) => ({ host: host as Address, amount }))
      .sort((x, y) => (x.host < y.host ? -1 : 1)),
    windowDraws: windowDrawsOf(kept),
    fees: payout.fees,
    agentPoolDraw,
    reserveDraw,
    agentPaymentsHash: keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [paymentIds])),
  }
  return {
    b,
    t,
    batchHash: batchHashOf(b),
    rejects,
    drawn,
    writtenOff,
    orphans,
    swept,
    refunds,
    closeMatched: input.closeRoot === null || input.closeRoot === root,
  }
}

export function readyAt(hour: number, graceSeconds: number): number {
  return hourEnd(hour) + graceSeconds
}
