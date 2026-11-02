import { recoverAddress, type Address, type Hex } from "viem"
import type { Db } from "./db.ts"

export type SigKind = "settle" | "refund" | "ruling" | "perf" | "reward"

export type SigRow = { signer: string; batch_hash: Hex; sig: Hex; batch: unknown }

const toJson = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v))

/** Signatures are public. Each signer stores what it computed, keyed by what it signed. */
export async function storeSignature(db: Db, kind: SigKind, slot: number, signer: string, hash: Hex, sig: Hex, batch: unknown) {
  await db.query(
    `INSERT INTO chain.settlement_sigs (kind, hour, signer, batch_hash, sig, batch) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (kind, hour, signer) DO UPDATE SET batch_hash = $4, sig = $5, batch = $6::jsonb`,
    [kind, slot, signer.toLowerCase(), hash, sig, toJson(batch)],
  )
}

export async function readSignatures(db: Db, kind: SigKind, slot: number) {
  const rows = await db.query<SigRow>(
    "SELECT signer, batch_hash, sig, batch FROM chain.settlement_sigs WHERE kind = $1 AND hour = $2",
    [kind, slot],
  )
  return rows.rows
}

/**
 * Two distinct members who signed the same hash and hold the same batch, sorted the way ThresholdSig
 * requires. A row that does not verify, or a member's false copy of the batch, cannot change the result.
 */
export async function agreedSignatures(rows: SigRow[], members: Address[]) {
  const allowed = new Set(members.map((s) => s.toLowerCase()))
  const agreeing = new Map<string, { hash: Hex; batch: unknown; signers: { signer: string; sig: Hex }[] }>()
  for (const row of rows) {
    const recovered = await recoverAddress({ hash: row.batch_hash, signature: row.sig }).catch(() => null)
    if (recovered?.toLowerCase() !== row.signer || !allowed.has(row.signer)) continue
    const key = `${row.batch_hash}:${toJson(row.batch)}`
    const entry = agreeing.get(key) ?? { hash: row.batch_hash, batch: row.batch, signers: [] }
    entry.signers.push({ signer: row.signer, sig: row.sig })
    agreeing.set(key, entry)
  }
  for (const { hash, batch, signers } of agreeing.values()) {
    if (signers.length < 2) continue
    const pair = signers.sort((a, b) => (a.signer < b.signer ? -1 : 1)).slice(0, 2)
    const thresholdSig = `0x${pair.map((p) => p.sig.slice(2)).join("")}` as Hex
    return { hash, thresholdSig, batch }
  }
  return null
}
