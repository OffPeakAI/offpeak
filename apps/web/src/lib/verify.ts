import { recoverTypedDataAddress, type Hex } from "viem"
import { FEE_BPS_MIN, domain, feeMicro, hostCostMicro, leafFor, parseRecord, recordToMessage, usageTypes, verifyMerkle, type UsageRecord, type UsageRecordJson } from "./shared.ts"

const FEE_BPS_MAX = 400
const WINDOW_DRAW = 4

export type UsageRow = {
  record: UsageRecordJson
  routerSig: Hex
  hostSig: Hex
  leaf: Hex
  sealed: boolean
  feeBps: number
  hour: number
  status: string
  settledTx: string | null
  model: string | null
  hourClosesAt: number
}

export type ProofRow = { hour: number; leaf: string; proof: string[]; root: string; txHash: string }

export type Checks = { routerSig: boolean; hostSig: boolean; cost: boolean; fee: boolean; leaf: boolean }

async function signedBy(record: UsageRecord, signature: Hex, expected: string, usageLedger: string) {
  try {
    const got = await recoverTypedDataAddress({
      domain: domain("OffpeakUsage", usageLedger),
      types: usageTypes,
      primaryType: "UsageRecord",
      message: recordToMessage(record) as never,
      signature,
    })
    return got.toLowerCase() === expected.toLowerCase()
  } catch {
    return false
  }
}

/** Runs in the browser, on the record alone: both signatures, the cost arithmetic, the fee, the leaf. */
export async function verifyRecord(row: Pick<UsageRow, "record" | "routerSig" | "hostSig" | "leaf" | "feeBps">, keys: { routerSigner: string; usageLedger: string }): Promise<Checks> {
  const record = parseRecord(row.record)
  const drawn = record.payMode === WINDOW_DRAW
  const hostCost = drawn ? 0n : hostCostMicro(record.tokensIn, record.tokensOut, record.priceIn, record.priceOut)
  const fee = drawn ? 0n : feeMicro(hostCost, row.feeBps)
  const [routerSig, hostSig] = await Promise.all([signedBy(record, row.routerSig, keys.routerSigner, keys.usageLedger), signedBy(record, row.hostSig, record.host, keys.usageLedger)])
  return {
    routerSig,
    hostSig,
    cost: hostCost === record.hostCostMicro,
    fee: fee === record.feeMicro && (drawn || (row.feeBps >= FEE_BPS_MIN && row.feeBps <= FEE_BPS_MAX)),
    leaf: leafFor(record, row.routerSig, row.hostSig) === row.leaf,
  }
}

export type ProofState =
  | { state: "open"; closesAt: number }
  | { state: "awaiting" }
  | { state: "proven"; root: string; txHash: string }
  | { state: "broken" }

/** An unsettled hour is waiting, not failing. Only a proof that does not reach its root is a failure. */
export function proofState(row: Pick<UsageRow, "leaf" | "hourClosesAt">, proof: ProofRow | null | undefined, now: number): ProofState {
  if (proof) {
    const fits = proof.leaf.toLowerCase() === row.leaf.toLowerCase() && verifyMerkle(row.leaf, proof.proof as Hex[], proof.root as Hex)
    return fits ? { state: "proven", root: proof.root, txHash: proof.txHash } : { state: "broken" }
  }
  return now < row.hourClosesAt ? { state: "open", closesAt: row.hourClosesAt } : { state: "awaiting" }
}

export type Tone = "ok" | "fail" | "wait"

export type Line = { label: string; tone: Tone; detail: string }

const yes = (label: string, pass: boolean, good: string, bad: string): Line => ({ label, tone: pass ? "ok" : "fail", detail: pass ? good : bad })

export function checkLines(checks: Checks): Line[] {
  return [
    yes("Router signature", checks.routerSig, "Recovered to the router's address.", "Does not recover to the router's address."),
    yes("Host signature", checks.hostSig, "Recovered to the host on the record.", "Does not recover to the host on the record."),
    yes("Cost", checks.cost, "Tokens × price matches the host cost.", "Tokens × price does not match the host cost."),
    yes("Fee", checks.fee, "Matches your fee rate.", "Does not match the fee rate."),
    yes("Merkle leaf", checks.leaf, "Recomputed from the record and both signatures.", "Differs from the record and signatures."),
  ]
}

export function proofLine(proof: ProofState): Line {
  if (proof.state === "proven") return { label: "Proof", tone: "ok", detail: "The leaf reaches the settled root." }
  if (proof.state === "broken") return { label: "Proof", tone: "fail", detail: "This proof does not reach its root. Dispute this record." }
  if (proof.state === "open") return { label: "Proof", tone: "wait", detail: "The hour is still open, so there is no root yet." }
  return { label: "Proof", tone: "wait", detail: "The hour has closed. The proof appears once it settles." }
}

/** One word for the list. A failed check outranks everything. */
export function verdict(checks: Checks | null): { tone: Tone; label: string } {
  if (!checks) return { tone: "wait", label: "Checking" }
  return Object.values(checks).every(Boolean) ? { tone: "ok", label: "Verified" } : { tone: "fail", label: "Failed" }
}

export const PAY_MODES = ["Prepaid", "x402 upto", "x402 exact", "Channel", "Window"] as const

export function buyerTotal(record: Pick<UsageRecordJson, "hostCostMicro" | "feeMicro">) {
  return BigInt(record.hostCostMicro) + BigInt(record.feeMicro)
}
