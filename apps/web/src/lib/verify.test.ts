import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { Hex } from "viem"
import { buyerTotal, checkLines, proofLine, proofState, verdict, verifyRecord, type UsageRow } from "./verify.ts"

const vectors = JSON.parse(readFileSync(new URL("../../../../packages/shared/fixtures/vectors.json", import.meta.url), "utf8"))
const keys = { routerSigner: vectors.addresses.router as string, usageLedger: vectors.addresses.contracts.UsageLedger as string }

function row(index = 1): Pick<UsageRow, "record" | "routerSig" | "hostSig" | "leaf" | "feeBps"> {
  const source = vectors.usage[index]
  return { record: source.record, routerSig: source.routerSig, hostSig: source.hostSig, leaf: source.leaf, feeBps: 400 }
}

const pass = { routerSig: true, hostSig: true, cost: true, fee: true, leaf: true }

describe("local verification", () => {
  test("every golden record passes every check", async () => {
    for (let index = 0; index < vectors.usage.length; index++) {
      expect(await verifyRecord(row(index), keys)).toEqual(pass)
    }
  })

  test("a changed token count fails the signatures, the cost and the leaf", async () => {
    const tampered = row()
    tampered.record = { ...tampered.record, tokensOut: tampered.record.tokensOut + 1000 }
    expect(await verifyRecord(tampered, keys)).toEqual({ routerSig: false, hostSig: false, cost: false, fee: false, leaf: false })
  })

  test("a signature from the wrong key fails that check alone", async () => {
    const swapped = row()
    swapped.routerSig = swapped.hostSig
    const checks = await verifyRecord(swapped, keys)
    expect(checks.routerSig).toBe(false)
    expect(checks.hostSig).toBe(true)
    expect(checks.cost).toBe(true)
  })

  test("a junk signature is a failed check, not a crash", async () => {
    const junk = row()
    junk.hostSig = "0x1234"
    expect((await verifyRecord(junk, keys)).hostSig).toBe(false)
  })

  test("the wrong fee rate fails the fee check", async () => {
    expect((await verifyRecord({ ...row(), feeBps: 296 }, keys)).fee).toBe(false)
    expect((await verifyRecord({ ...row(), feeBps: 999 }, keys)).fee).toBe(false)
  })

  test("the router's address must be the one the network publishes", async () => {
    expect((await verifyRecord(row(), { ...keys, routerSigner: vectors.addresses.buyer })).routerSig).toBe(false)
  })
})

describe("proof status", () => {
  const closes = { leaf: vectors.usage[1].leaf as Hex, hourClosesAt: 1_000 }
  const proof = { hour: 1, leaf: vectors.usage[1].leaf, proof: vectors.merkle.proofs[1], root: vectors.merkle.root, txHash: "0xaa" }

  test("waits while the hour is open, then until it settles", () => {
    expect(proofState(closes, null, 999)).toEqual({ state: "open", closesAt: 1_000 })
    expect(proofState(closes, null, 1_000)).toEqual({ state: "awaiting" })
    expect(proofLine({ state: "awaiting" }).tone).toBe("wait")
  })

  test("a real proof reaches the root", () => {
    expect(proofState(closes, proof, 2_000)).toEqual({ state: "proven", root: vectors.merkle.root, txHash: "0xaa" })
  })

  test("a proof for a different root is a failure", () => {
    const state = proofState(closes, { ...proof, root: `0x${"ab".repeat(32)}` }, 2_000)
    expect(state).toEqual({ state: "broken" })
    expect(proofLine(state).tone).toBe("fail")
  })

  test("a proof for a different leaf is a failure", () => {
    expect(proofState(closes, { ...proof, leaf: vectors.usage[0].leaf }, 2_000)).toEqual({ state: "broken" })
  })
})

describe("what the page shows", () => {
  test("one failed check turns the whole record red", () => {
    expect(verdict(pass)).toEqual({ tone: "ok", label: "Verified" })
    expect(verdict({ ...pass, fee: false })).toEqual({ tone: "fail", label: "Failed" })
    expect(verdict(null).tone).toBe("wait")
  })

  test("each check explains itself", () => {
    const lines = checkLines({ ...pass, cost: false })
    expect(lines).toHaveLength(5)
    expect(lines.find((line) => line.label === "Cost")?.tone).toBe("fail")
    expect(lines.filter((line) => line.tone === "ok")).toHaveLength(4)
  })

  test("the total is host cost plus fee", () => {
    expect(buyerTotal({ hostCostMicro: "47", feeMicro: "2" })).toBe(49n)
  })
})
