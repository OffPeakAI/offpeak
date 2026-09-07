import { OffpeakVaultAbi } from "@offpeak/abis"
import { agreedSignatures, firstBlockAtOrAfter, readSignatures, storeSignature, type Db } from "@offpeak/common"
import { domain, hourStart, refundTypes } from "@offpeak/shared"
import { hashTypedData, keccak256, toBytes, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem"

const MAX_REFUNDS = 500

export type RefundDeps = {
  db: Db
  reader: PublicClient
  writer: WalletClient
  account: LocalAccount
  vault: Address
  settlers: Address[]
  chainId: number
}

type Stored = {
  r: { batchId: string; refunds: { payer: Address; amount: string; refundId: Hex }[] }
  ids: { id: string; refundId: Hex }[]
}

/** Signs this hour's refunds, taking only what the reserve held at the hour's start. */
async function signRefunds(deps: RefundDeps, hour: number) {
  const rows = await deps.db.query<{ id: string; payer: string; amount: string }>(
    `SELECT id, payer, amount FROM shared.refunds
     WHERE paid_hour IS NULL AND created_at < to_timestamp($1) ORDER BY id LIMIT $2`,
    [hourStart(hour), MAX_REFUNDS],
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
  let left = reserve
  const kept = rows.rows.filter((row) => {
    if (BigInt(row.amount) > left) return false
    left -= BigInt(row.amount)
    return true
  })
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
