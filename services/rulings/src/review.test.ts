import { describe, expect, test } from "bun:test"
import { openDatabase, type Db } from "@offpeak/common"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import type { Hex, LocalAccount, WalletClient } from "viem"
import { applyAuditCourt } from "../../indexer/src/apply/AuditCourt.ts"
import { testHash as hash } from "../../indexer/src/test-chain.ts"
import { rulingTick, type RulingDeps } from "./review.ts"

const NOW = 1_800_000_000
const HOST = "0x00000000000000000000000000000000000000f1"
const STRANGER = "0x00000000000000000000000000000000000000f3"
const COURT = "0x00000000000000000000000000000000000000a2"
const rulers = [roleAccount("rulingA"), roleAccount("rulingB"), roleAccount("rulingC")]

function deps(db: Db, account: LocalAccount = rulers[0]!): RulingDeps {
  const reader = { getBlock: async () => ({ number: 1000n, timestamp: BigInt(NOW) }) }
  return { db, reader: reader as never, writer: {} as WalletClient, account, contracts: { AuditCourt: COURT }, rulers: rulers.map((r) => r.address), chainId: 4663 }
}

const base = (id: bigint) => ({ txHash: hash(`f${id}`), logIndex: 0, blockNumber: 900n, blockTs: NOW - 2 * 86_400, contract: "AuditCourt" })

async function fileChallenge(db: Db, id: bigint, evidence = true) {
  await applyAuditCourt(db, { ...base(id), event: "ChallengeFiled", args: { challengeId: id.toString(), host: HOST, challenger: STRANGER, kind: 2, evidenceHash: hash(`e${id}`) } })
  if (!evidence) return
  await applyAuditCourt(db, { ...base(id), event: "EvidenceFiled", args: { challengeId: id.toString(), modelDigest: hash("m"), samplesRoot: hash(`root${id}`), sampleCount: 25, testId: hash("t"), statistic: "1", threshold: "1", uri: "x" } })
}

const signed = async (db: Db) => (await db.query<{ hour: string }>("SELECT hour FROM chain.settlement_sigs WHERE kind = 'ruling' ORDER BY hour")).rows.map((r) => Number(r.hour))

describe("rulingTick", () => {
  test("ordinary challenges both get a signature", async () => {
    const db = await openDatabase("pglite://memory")
    await fileChallenge(db, 1n)
    await fileChallenge(db, 2n)
    await rulingTick(deps(db))
    expect(await signed(db)).toEqual([1, 2])
  })

  test("a challenge whose evidence never applied dismisses and later ones are still ruled", async () => {
    const db = await openDatabase("pglite://memory")
    await fileChallenge(db, 1n, false)
    await fileChallenge(db, 2n)
    const results = await rulingTick(deps(db))
    expect(results.map((r) => r.reason)).toEqual(["evidence_missing", "evidence_missing"])
    expect(await signed(db)).toEqual([1, 2])
  })

  test("a row that fails is retried without holding back the rest", async () => {
    const db = await openDatabase("pglite://memory")
    await fileChallenge(db, 1n)
    await fileChallenge(db, 2n)
    let signs = 0
    const flaky = { ...rulers[0]!, sign: async (args: { hash: Hex }) => { if (++signs === 1) throw new Error("signer offline"); return rulers[0]!.sign!(args) } } as LocalAccount
    const results = await rulingTick(deps(db, flaky))
    expect(results.map((r) => r.reason)).toEqual(["ruling_failed", "evidence_missing"])
    expect(await signed(db)).toEqual([2])
    await rulingTick(deps(db))
    expect(await signed(db)).toEqual([1, 2])
  })
})
