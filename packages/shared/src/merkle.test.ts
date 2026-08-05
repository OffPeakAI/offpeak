import { describe, expect, test } from "bun:test"
import { keccak256, toBytes, type Hex } from "viem"
import { hashPair, merkleProof, merkleRoot, totalsHashOf, usageLeaf, verifyMerkle } from "./merkle.ts"
import { ZERO_BYTES32 } from "./constants.ts"

describe("merkle", () => {
  test("empty root is zero and a single leaf is itself", () => {
    expect(merkleRoot([])).toBe(ZERO_BYTES32)
    const leaf = keccak256(toBytes("a"))
    expect(merkleRoot([leaf])).toBe(leaf)
  })

  test("sorted pairs and proofs verify, odd node promoted", () => {
    const leaves = ["a", "b", "c", "d", "e"].map((s) => keccak256(toBytes(s)))
    const root = merkleRoot(leaves)
    for (let i = 0; i < leaves.length; i++) {
      const proof = merkleProof(leaves, i)
      expect(verifyMerkle(leaves[i]!, proof, root)).toBe(true)
    }
    const swapped = hashPair(leaves[1]!, leaves[0]!)
    expect(swapped).toBe(hashPair(leaves[0]!, leaves[1]!))
  })

  test("usage leaf double-hashes the encoded triple", () => {
    const struct = keccak256(toBytes("struct"))
    const routerSig = `0x${"ab".repeat(65)}` as Hex
    const hostSig = `0x${"cd".repeat(65)}` as Hex
    const leaf = usageLeaf(struct, routerSig, hostSig)
    expect(leaf.startsWith("0x")).toBe(true)
    expect(leaf).not.toBe(struct)
  })

  test("totals hash is stable", () => {
    const h1 = totalsHashOf({
      records: 2,
      tokensIn: 10n,
      tokensOut: 4n,
      prepaidDebit: 5n,
      agentCollected: 0n,
      windowDrawn: 0n,
      hostCredit: 4n,
      fees: 1n,
    })
    const h2 = totalsHashOf({
      records: 2,
      tokensIn: 10n,
      tokensOut: 4n,
      prepaidDebit: 5n,
      agentCollected: 0n,
      windowDrawn: 0n,
      hostCredit: 4n,
      fees: 1n,
    })
    expect(h1).toBe(h2)
  })
})
