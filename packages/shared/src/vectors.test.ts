import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { recoverTypedDataAddress, type Hex } from "viem"
import localDeploy from "../../abis/deployments/local.json" with { type: "json" }
import { domain } from "./eip712.ts"
import { usageStructHash, usageTypes, voucherTypes, hourCloseTypes } from "./eip712.ts"
import { merkleRoot, usageLeaf, verifyMerkle } from "./merkle.ts"
import { buyerPays, hostCostMicro, feeMicro } from "./money.ts"
import { roleAccount } from "./test-keys.ts"
import { parseRecord, recordToMessage } from "./usage.ts"

const vectors = JSON.parse(readFileSync(new URL("../fixtures/vectors.json", import.meta.url), "utf8"))
const ledger = localDeploy.contracts.UsageLedger

describe("golden vectors", () => {
  test("five usage records reproduce cost, leaf, signers, root and proofs", async () => {
    const router = roleAccount("router")
    const host = roleAccount("host")
    const leaves: Hex[] = []
    expect(vectors.usage).toHaveLength(5)
    for (const row of vectors.usage) {
      const record = parseRecord(row.record)
      const hostCost = record.payMode === 4 ? 0n : hostCostMicro(record.tokensIn, record.tokensOut, record.priceIn, record.priceOut)
      const fee = record.payMode === 4 ? 0n : feeMicro(hostCost, 400)
      expect(hostCost).toBe(record.hostCostMicro)
      expect(fee).toBe(record.feeMicro)
      expect(buyerPays(hostCost, fee).toString()).toBe(row.buyerPays)
      const message = recordToMessage(record)
      expect(usageStructHash(message)).toBe(row.structHash)
      const leaf = usageLeaf(row.structHash, row.routerSig, row.hostSig)
      expect(leaf).toBe(row.leaf)
      leaves.push(leaf)
      const routerAddr = await recoverTypedDataAddress({
        domain: domain("OffpeakUsage", ledger),
        types: usageTypes,
        primaryType: "UsageRecord",
        message: message as never,
        signature: row.routerSig,
      })
      const hostAddr = await recoverTypedDataAddress({
        domain: domain("OffpeakUsage", ledger),
        types: usageTypes,
        primaryType: "UsageRecord",
        message: message as never,
        signature: row.hostSig,
      })
      expect(routerAddr.toLowerCase()).toBe(router.address.toLowerCase())
      expect(hostAddr.toLowerCase()).toBe(host.address.toLowerCase())
    }
    expect(merkleRoot(leaves)).toBe(vectors.merkle.root)
    vectors.merkle.proofs.forEach((proof: Hex[], i: number) => {
      expect(verifyMerkle(leaves[i]!, proof, vectors.merkle.root)).toBe(true)
    })
  })

  test("hour close and voucher signatures recover", async () => {
    const router = roleAccount("router")
    const buyer = roleAccount("buyer")
    const close = await recoverTypedDataAddress({
      domain: domain("OffpeakUsage", ledger),
      types: hourCloseTypes,
      primaryType: "HourClose",
      message: {
        hour: BigInt(vectors.hourClose.hour),
        records: vectors.hourClose.records,
        root: vectors.hourClose.root,
        totalsHash: vectors.hourClose.totalsHash,
      },
      signature: vectors.hourClose.signature,
    })
    expect(close.toLowerCase()).toBe(router.address.toLowerCase())
    const voucher = await recoverTypedDataAddress({
      domain: domain("OffpeakChannel", localDeploy.contracts.ChannelManager),
      types: voucherTypes,
      primaryType: "Voucher",
      message: {
        channelId: vectors.voucher.channelId,
        seq: BigInt(vectors.voucher.seq),
        cumulative: BigInt(vectors.voucher.cumulative),
      },
      signature: vectors.voucher.signature,
    })
    expect(voucher.toLowerCase()).toBe(buyer.address.toLowerCase())
    expect(vectors.settleBatch.thresholdSig.length).toBe(2 + 65 * 2 * 2)
    expect(vectors.ruling.thresholdSig.length).toBe(2 + 65 * 2 * 2)
    expect(vectors.permit2.uptoDigest.startsWith("0x")).toBe(true)
    expect(vectors.permit2.exactDigest.startsWith("0x")).toBe(true)
    expect(vectors.priceSheet.hash.startsWith("0x")).toBe(true)
  })
})
