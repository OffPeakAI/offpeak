import { describe, expect, test } from "bun:test"
import { verifyMerkle } from "../../../packages/shared/src/index.ts"
import type { Address } from "viem"
import { buildRefundTree, refundLeaf } from "./refund-tree.ts"

const buyer = (n: number) => `0x${String(n).repeat(40)}` as Address

describe("buildRefundTree", () => {
  test("splits the pool by spend and every proof verifies", () => {
    const tree = buildRefundTree([{ buyer: buyer(2), spent: 300n }, { buyer: buyer(1), spent: 100n }, { buyer: buyer(3), spent: 600n }], 1_000n)
    expect(tree.entries.map((e) => e.amount)).toEqual([100n, 300n, 600n])
    for (const entry of tree.entries) expect(verifyMerkle(refundLeaf(entry.buyer, entry.amount), entry.proof, tree.root)).toBe(true)
  })

  test("rounds down, so it can never promise more than the pool", () => {
    const tree = buildRefundTree([{ buyer: buyer(1), spent: 1n }, { buyer: buyer(2), spent: 1n }, { buyer: buyer(3), spent: 1n }], 100n)
    expect(tree.entries.reduce((sum, e) => sum + e.amount, 0n)).toBe(99n)
  })

  test("drops buyers whose share rounds to nothing", () => {
    const tree = buildRefundTree([{ buyer: buyer(1), spent: 1n }, { buyer: buyer(2), spent: 1_000_000n }], 100n)
    expect(tree.entries.map((e) => e.buyer)).toEqual([buyer(2)])
  })

  test("a claim for any other amount fails", () => {
    const tree = buildRefundTree([{ buyer: buyer(1), spent: 1n }, { buyer: buyer(2), spent: 1n }], 100n)
    const entry = tree.entries[0]!
    expect(verifyMerkle(refundLeaf(entry.buyer, entry.amount + 1n), entry.proof, tree.root)).toBe(false)
  })

  test("nothing to refund gives an empty tree", () => {
    expect(buildRefundTree([], 100n).entries).toEqual([])
    expect(buildRefundTree([{ buyer: buyer(1), spent: 5n }], 0n).entries).toEqual([])
  })
})
