import { UsageLedgerAbi } from "@offpeak/abis"
import { verifyMerkle } from "@offpeak/shared"
import type { Hex } from "viem"
import { z } from "zod"
import { OffpeakError, bytes32Schema, errorFrom, type ClientContext } from "./core.ts"

const usageView = z.object({
  envelope: z.looseObject({ leaf: bytes32Schema }),
  proof: z
    .object({
      hour: z.coerce.number().int().nonnegative(),
      proof: z.array(bytes32Schema),
      root: bytes32Schema,
      txHash: z.string().optional(),
    })
    .nullish(),
})

export type ProofReport = {
  /** The proof reaches the published root from the leaf this client holds, and the chain, when asked, agrees. */
  ok: boolean
  /** `UsageLedger.verifyLeaf` agreed over RPC. */
  onchain: boolean
  status: "pending" | "not_found" | "mismatch" | "verified" | "local_only"
  hour?: number
  root?: Hex
  txHash?: string
  reason?: string
}

/**
 * Fetches the proof and checks it twice: locally, and on the ledger over RPC. `knownLeaf` is the leaf
 * from your own envelope, so a proof is only trusted for the record you were given.
 */
export async function fetchProof(ctx: ClientContext, reqId: string, knownLeaf?: Hex): Promise<ProofReport> {
  const id = bytes32Schema.parse(reqId)
  const res = await ctx.fetch(`${ctx.baseURL}/v1/usage/${id}`)
  if (res.status === 404) return { ok: false, onchain: false, status: "not_found" }
  if (!res.ok) throw await errorFrom(res)
  const view = usageView.parse(await res.json())
  const leaf = knownLeaf ?? view.envelope.leaf
  if (view.envelope.leaf !== leaf) return { ok: false, onchain: false, status: "mismatch", reason: "Router leaf differs from the envelope you hold" }
  if (!view.proof) return { ok: false, onchain: false, status: "pending", reason: "The hour is not settled yet" }
  const { hour, proof, root, txHash } = view.proof
  const base = { hour, root, txHash }
  if (!verifyMerkle(leaf, proof, root)) return { ...base, ok: false, onchain: false, status: "mismatch", reason: "Proof does not reach the root" }
  const reader = ctx.chain.reader()
  if (!reader) return { ...base, ok: true, onchain: false, status: "local_only", reason: "No RPC is configured" }
  let onchain: boolean
  try {
    onchain = await reader.readContract({
      address: ctx.book.contract("UsageLedger"),
      abi: UsageLedgerAbi,
      functionName: "verifyLeaf",
      args: [BigInt(hour), leaf, proof],
    })
  } catch (err) {
    if (err instanceof OffpeakError) throw err
    return { ...base, ok: true, onchain: false, status: "local_only", reason: "RPC read failed" }
  }
  return onchain ? { ...base, ok: true, onchain, status: "verified" } : { ...base, ok: false, onchain, status: "mismatch", reason: "The ledger has no such leaf for that hour" }
}
