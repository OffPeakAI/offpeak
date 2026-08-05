import { encodeAbiParameters, keccak256, type Hex } from "viem"
import { ZERO_BYTES32 } from "./constants.ts"

export type RootTotals = {
  records: number
  tokensIn: bigint
  tokensOut: bigint
  prepaidDebit: bigint
  agentCollected: bigint
  windowDrawn: bigint
  hostCredit: bigint
  fees: bigint
}

export function emptyTotals(): RootTotals {
  return {
    records: 0,
    tokensIn: 0n,
    tokensOut: 0n,
    prepaidDebit: 0n,
    agentCollected: 0n,
    windowDrawn: 0n,
    hostCredit: 0n,
    fees: 0n,
  }
}

export function totalsHashOf(t: RootTotals): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint32" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint128" },
        { type: "uint128" },
        { type: "uint128" },
        { type: "uint128" },
        { type: "uint128" },
      ],
      [
        t.records,
        t.tokensIn,
        t.tokensOut,
        t.prepaidDebit,
        t.agentCollected,
        t.windowDrawn,
        t.hostCredit,
        t.fees,
      ],
    ),
  )
}

/** Sorted-pair keccak256. Odd node is promoted. */
export function hashPair(a: Hex, b: Hex): Hex {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  const [lo, hi] = left < right ? [left, right] : [right, left]
  return keccak256(`0x${lo.slice(2)}${hi.slice(2)}` as Hex)
}

export function merkleRoot(leaves: readonly Hex[]): Hex {
  if (leaves.length === 0) return ZERO_BYTES32
  let level = leaves.map((l) => l.toLowerCase() as Hex)
  while (level.length > 1) {
    const next: Hex[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!
      const right = level[i + 1]
      next.push(right === undefined ? left : hashPair(left, right))
    }
    level = next
  }
  return level[0]!
}

export function merkleProof(leaves: readonly Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new Error("leaf index out of range")
  let idx = index
  let level = leaves.map((l) => l.toLowerCase() as Hex)
  const proof: Hex[] = []
  while (level.length > 1) {
    const next: Hex[] = []
    const len = level.length
    if (idx % 2 === 0) {
      if (idx + 1 < len) proof.push(level[idx + 1]!)
    } else {
      proof.push(level[idx - 1]!)
    }
    for (let i = 0; i < len; i += 2) {
      const left = level[i]!
      const right = level[i + 1]
      next.push(right === undefined ? left : hashPair(left, right))
    }
    idx = Math.floor(idx / 2)
    level = next
  }
  return proof
}

export function verifyMerkle(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  let computed = leaf.toLowerCase() as Hex
  for (const sibling of proof) {
    computed = hashPair(computed, sibling as Hex)
  }
  return computed === root.toLowerCase()
}

/**
 * Usage leaf.
 * leaf = keccak256(bytes.concat(keccak256(abi.encode(structHash, keccak256(routerSig), keccak256(hostSig)))))
 */
export function usageLeaf(structHash: Hex, routerSig: Hex, hostSig: Hex): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [structHash, keccak256(routerSig), keccak256(hostSig)],
    ),
  )
  return keccak256(inner)
}
