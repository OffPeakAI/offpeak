import { OffpeakVaultAbi, X402EscrowAbi } from "@offpeak/abis"
import { agreedSignatures, firstBlockAtOrAfter, log, readSignatures, storeSignature, type Db, type SigRow } from "@offpeak/common"
import { domain, hourStart, refundTypes } from "@offpeak/shared"
import { hashTypedData, keccak256, toBytes, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem"

const MAX_REFUNDS = 500
/** The vault caps a refund only at the reserve, so this bounds what one hour can pay out: 1,000 USDG. */
const MAX_BATCH_MICRO = 1_000_000_000n
const ESCROW_STATUS_EXACT = 4

export type RefundDeps = {
  db: Db
  reader: PublicClient
  writer: WalletClient
  account: LocalAccount
  vault: Address
  escrow?: Address
  settlers: Address[]
  chainId: number
}

type RefundRow = { id: string; payer: string; amount: string; reason: string; req_ids: string[] }

type Stored = {
  r: { batchId: string; refunds: { payer: Address; amount: string; refundId: Hex }[] }
  ids: { id: string; refundId: Hex }[]
}

/** An excluded record's refund is in the outcome two signers stored for a batch that landed. */
async function inLandedBatch(deps: RefundDeps, row: RefundRow) {
  const claim = JSON.stringify([{ id: row.id, payer: row.payer, amount: String(row.amount) }])
  const signed = await deps.db.query<SigRow>(
    `SELECT s.signer, s.batch_hash, s.sig, s.batch FROM chain.settlement_sigs s
     JOIN chain.events e ON e.contract = 'OffpeakVault' AND e.event = 'Settled' AND e.args->>'batchHash' = s.batch_hash
     WHERE s.kind = 'settle' AND s.batch->'payments'->'refunds' @> $1::jsonb`,
    [claim],
  )
  return (await agreedSignatures(signed.rows, deps.settlers)) !== null
}

/** An unserved `exact` gets back what the escrow took from this payer, unless a payment row says it was served or its money already joined fees. */
async function exactUnserved(deps: RefundDeps, row: RefundRow) {
  const reqId = row.req_ids[0]
  if (!deps.escrow || row.req_ids.length !== 1 || row.id !== `exact-unserved:${reqId}`) return false
  const view = await deps.reader.readContract({ address: deps.escrow, abi: X402EscrowAbi, functionName: "escrowView", args: [reqId as Hex] })
  if (view.status !== ESCROW_STATUS_EXACT || view.payer.toLowerCase() !== row.payer.toLowerCase() || view.captured !== BigInt(row.amount)) return false
  const spent = await deps.db.query("SELECT 1 FROM shared.agent_payments WHERE payment_id = $1 UNION ALL SELECT 1 FROM chain.swept_payments WHERE source = $1", [reqId])
  return spent.rows.length === 0
}

/** Disputes and lost lines return at most what this payer was billed in hours that settled, once per record. */
async function billedAndSettled(deps: RefundDeps, row: RefundRow, counted: Set<string>) {
  const reqIds = [...new Set(row.req_ids)]
  if (reqIds.length === 0 || (row.reason === "night_line_lost" && row.id !== `night-line:${reqIds[0]}`)) return false
  const billed = await deps.db.query<{ payer: string; cost: string }>(
    `SELECT r.payer, r.host_cost_micro + r.fee_micro AS cost
     FROM shared.usage_records r JOIN chain.settlements s ON s.hour = r.hour
     WHERE r.req_id = ANY($1) AND r.status = 'final'
       AND NOT EXISTS (SELECT 1 FROM chain.settlement_rejects x WHERE x.req_id = r.req_id)`,
    [reqIds],
  )
  if (billed.rows.length !== reqIds.length || billed.rows.some((r) => r.payer.toLowerCase() !== row.payer.toLowerCase())) return false
  if (BigInt(row.amount) > billed.rows.reduce((sum, r) => sum + BigInt(r.cost), 0n)) return false
  // An excess refund names every record of its payment and repays money the records never cost, so it blocks nothing here.
  const paid = await deps.db.query("SELECT 1 FROM shared.refunds WHERE paid_hour IS NOT NULL AND reason IN ('dispute_upheld', 'night_line_lost') AND req_ids && $1::text[]", [reqIds])
  if (paid.rows.length > 0 || reqIds.some((id) => counted.has(id))) return false
  for (const id of reqIds) counted.add(id)
  return true
}

/** The refund table is writable by the router, so a row is only a claim until facts it cannot write back it up. */
function refundBacked(deps: RefundDeps, row: RefundRow, counted: Set<string>) {
  if (row.reason === "excluded_record") return inLandedBatch(deps, row)
  if (row.reason === "exact_unserved") return exactUnserved(deps, row)
  if (row.reason === "dispute_upheld" || row.reason === "night_line_lost") return billedAndSettled(deps, row, counted)
  return false
}

/** Signs this hour's refunds that facts back, taking no more than the batch cap or what the reserve held at the hour's start. */
async function signRefunds(deps: RefundDeps, hour: number) {
  const rows = await deps.db.query<RefundRow>(
    `SELECT id, payer, amount, reason, req_ids FROM shared.refunds
     WHERE paid_hour IS NULL AND created_at < to_timestamp($1) ORDER BY id`,
    [hourStart(hour)],
  )
  if (rows.rows.length === 0) return
  const pin = await firstBlockAtOrAfter(deps.reader, hourStart(hour))
  if (pin === null) return
  const reserve = await deps.reader.readContract({
    address: deps.vault,
    abi: OffpeakVaultAbi,
    functionName: "protocolReserve",
    blockNumber: pin,
  })
  let left = reserve < MAX_BATCH_MICRO ? reserve : MAX_BATCH_MICRO
  const kept: RefundRow[] = []
  const counted = new Set<string>()
  for (const row of rows.rows) {
    if (kept.length === MAX_REFUNDS) break
    const amount = BigInt(row.amount)
    if (amount <= 0n || amount > left) continue
    if (!(await refundBacked(deps, row, counted))) {
      log("settlement", "refund_unbacked", { id: row.id, reason: row.reason })
      continue
    }
    left -= amount
    kept.push(row)
  }
  if (kept.length === 0) return

  const refunds = kept.map((row) => ({
    payer: row.payer as Address,
    amount: BigInt(row.amount),
    refundId: keccak256(toBytes(row.id)),
  }))
  const message = { batchId: BigInt(hour), refunds }
  const hash = hashTypedData({
    domain: domain("OffpeakSettlement", deps.vault, deps.chainId),
    types: refundTypes,
    primaryType: "RefundBatch",
    message,
  })
  const sig = await deps.account.sign!({ hash })
  const stored: Stored = {
    r: { batchId: String(hour), refunds: refunds.map((r) => ({ ...r, amount: r.amount.toString() })) },
    ids: kept.map((row, i) => ({ id: row.id, refundId: refunds[i]!.refundId })),
  }
  await storeSignature(deps.db, "refund", hour, deps.account.address, hash, sig, stored)
}

/** One pass of the hourly refund batch. The chain says what is paid, since the indexer can lag a racing signer. */
export async function refundTick(deps: RefundDeps, hour: number) {
  await signRefunds(deps, hour)
  const agreed = await agreedSignatures(await readSignatures(deps.db, "refund", hour), deps.settlers)
  if (!agreed) return "waiting"
  const { r, ids } = agreed.batch as Stored
  for (const { id, refundId } of ids) {
    await deps.db.query("INSERT INTO chain.refund_ids (refund_id, id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [refundId, id])
  }
  for (const { refundId } of r.refunds) {
    const paid = await deps.reader.readContract({ address: deps.vault, abi: OffpeakVaultAbi, functionName: "refundPaid", args: [refundId] })
    if (paid) return "paid"
  }
  const { request } = await deps.reader.simulateContract({
    address: deps.vault,
    abi: OffpeakVaultAbi,
    functionName: "refund",
    args: [{ batchId: BigInt(r.batchId), refunds: r.refunds.map((x) => ({ ...x, amount: BigInt(x.amount) })) }, agreed.thresholdSig],
    account: deps.account,
  })
  const hash = await deps.writer.writeContract(request)
  await deps.reader.waitForTransactionReceipt({ hash })
  return hash
}
