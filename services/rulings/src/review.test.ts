import { describe, expect, test } from "bun:test"
import { PUBLISHED_BASELINE, TEST_ID, TEST_VERSION, mulberry32, score, simulateWeek } from "@offpeak/audit-tests"
import { openDatabase, type Db } from "@offpeak/common"
import { evidenceRoot, scaleStatistic, testIdHash, type EvidenceBundle } from "@offpeak/shared"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import type { Hex, LocalAccount, WalletClient } from "viem"
import { storeBundle } from "../../../apps/auditor/src/evidence.ts"
import { applyAuditCourt } from "../../indexer/src/apply/AuditCourt.ts"
import { testHash as hash } from "../../indexer/src/test-chain.ts"
import { insertRow, signRow } from "../../settlement/src/test-rows.ts"
import { KIND_CANARY, KIND_METERING, KIND_SWAP, OUTCOME_BREACH, OUTCOME_DISMISS, OUTCOME_SWAP } from "./decide.ts"
import { rulingTick, type RulingDeps } from "./review.ts"

const NOW = 1_800_000_000
const HOST = "0x00000000000000000000000000000000000000f1"
const BUYER = "0x00000000000000000000000000000000000000f2"
const STRANGER = "0x00000000000000000000000000000000000000f3"
const AUDITOR = "0x00000000000000000000000000000000000000f4"
const COURT = "0x00000000000000000000000000000000000000a2"
const rulers = [roleAccount("rulingA"), roleAccount("rulingB"), roleAccount("rulingC")]

function deps(db: Db, account: LocalAccount = rulers[0]!): RulingDeps {
  const reader = { getBlock: async () => ({ number: 1000n, timestamp: BigInt(NOW) }) }
  return { db, reader: reader as never, writer: {} as WalletClient, account, contracts: { AuditCourt: COURT }, rulers: rulers.map((r) => r.address), auditor: AUDITOR, chainId: 4663 }
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

const hostAddr = roleAccount("host").address.toLowerCase() as Hex
const LEDGER = "0x00000000000000000000000000000000000000a5"

async function fixture(n: number, flag: (i: number) => Partial<EvidenceBundle["samples"][number]>, zs?: number[]) {
  const db = await openDatabase("pglite://memory")
  const samples: EvidenceBundle["samples"] = []
  for (let i = 0; i < n; i++) {
    const row = await signRow({ i, hour: 100, payer: BUYER }, LEDGER as Hex)
    await insertRow(db, row)
    await db.query("UPDATE shared.usage_records SET settled_hour_tx = $1 WHERE req_id = $2", [hash("settle"), row.req_id])
    samples.push({ reqId: row.req_id as Hex, hour: 100, leaf: row.leaf as Hex, proof: [], z: zs?.[i] ?? 0, canaryFail: false, refAgrees: false, meteringFlag: false, ...flag(i) })
  }
  const bundle: EvidenceBundle = { v: 1, host: hostAddr, modelDigest: hash("model"), testId: TEST_ID, testVersion: TEST_VERSION, baseline: { ...PUBLISHED_BASELINE }, samples }
  await storeBundle(db, bundle)
  return { db, bundle }
}

function courtDeps(db: Db, index: number): RulingDeps {
  const reader = {
    getBlock: async () => ({ number: 1000n, timestamp: BigInt(NOW) }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "verifyLeaf") return true
      if (functionName === "hostView") return { bondUsdg: 2_000_000_000n }
      throw new Error(functionName)
    },
    simulateContract: async (call: unknown) => ({ request: call }),
    waitForTransactionReceipt: async () => ({ status: "success" }),
  }
  const writer = { writeContract: async () => hash("tx") }
  return { db, reader: reader as never, writer: writer as unknown as WalletClient, account: rulers[index]!, contracts: { AuditCourt: COURT, HostRegistry: COURT, UsageLedger: LEDGER as Hex }, rulers: rulers.map((r) => r.address), auditor: AUDITOR, chainId: 4663 }
}

async function file(db: Db, id: bigint, challenger: string, kind: number, bundle: EvidenceBundle, stat: { statistic: bigint; threshold: bigint; testId: Hex }, root = evidenceRoot(bundle)) {
  await applyAuditCourt(db, { ...base(id), event: "ChallengeFiled", args: { challengeId: id.toString(), host: bundle.host, challenger, kind, evidenceHash: hash(`e${id}`) } })
  await applyAuditCourt(db, { ...base(id), event: "EvidenceFiled", args: { challengeId: id.toString(), modelDigest: bundle.modelDigest, samplesRoot: root, sampleCount: bundle.samples.length, testId: stat.testId, statistic: stat.statistic.toString(), threshold: stat.threshold.toString(), uri: "x" } })
}

/** Both rulers sign, then the chain reports back what landed. */
async function rule(db: Db, id: bigint) {
  await rulingTick(courtDeps(db, 0))
  await rulingTick(courtDeps(db, 1))
  const signed = await db.query<{ batch: { message: { outcome: number; slashBps: number }; reason: string } }>("SELECT batch FROM chain.settlement_sigs WHERE kind = 'ruling' AND hour = $1 LIMIT 1", [id])
  const { batch } = signed.rows[0]!
  const { outcome, slashBps } = batch.message
  const landed = { ...base(id), txHash: hash(`r${id}`), blockTs: NOW }
  await applyAuditCourt(db, { ...landed, event: "RulingPosted", args: { challengeId: id.toString(), outcome, slashBps } })
  if (outcome !== OUTCOME_SWAP) await applyAuditCourt(db, { ...landed, event: "ChallengeFinalized", args: { challengeId: id.toString(), slashBps, slashedUsdg: "0" } })
  return { outcome, slashBps, reason: batch.reason }
}

function swapZs() {
  for (let seed = 1; seed < 500; seed++) {
    const week = simulateWeek(mulberry32(seed), 200, 0.25, PUBLISHED_BASELINE.delta)
    if (score(week, PUBLISHED_BASELINE).flagged) return week.map((s) => s.z)
  }
  throw new Error("no flagged week")
}

describe("evidence is bound to the auditor's first filing", () => {
  const metering = { statistic: scaleStatistic(0.1), threshold: scaleStatistic(0.05), testId: testIdHash("metering-v1") }

  test("the auditor's filing still rules as a breach", async () => {
    const { db, bundle } = await fixture(20, (i) => ({ meteringFlag: i < 2 }))
    await file(db, 1n, AUDITOR, KIND_METERING, bundle, metering)
    expect(await rule(db, 1n)).toMatchObject({ outcome: OUTCOME_BREACH, slashBps: 2_000 })
  })

  test("a root nobody stored dismisses as missing", async () => {
    const { db, bundle } = await fixture(20, (i) => ({ meteringFlag: i < 2 }))
    await file(db, 1n, STRANGER, KIND_METERING, bundle, metering, hash("not a stored root"))
    expect(await rule(db, 1n)).toEqual({ outcome: OUTCOME_DISMISS, slashBps: 0, reason: "evidence_missing" })
  })

  test("a stranger refiling a finished bundle dismisses", async () => {
    const { db, bundle } = await fixture(20, (i) => ({ meteringFlag: i < 2 }))
    await file(db, 1n, AUDITOR, KIND_METERING, bundle, metering)
    await rule(db, 1n)
    await file(db, 2n, STRANGER, KIND_METERING, bundle, metering)
    expect(await rule(db, 2n)).toEqual({ outcome: OUTCOME_DISMISS, slashBps: 0, reason: "evidence_wrong_filer" })
  })

  test("a stranger filing first neither gains nor uses up the auditor's root", async () => {
    const { db, bundle } = await fixture(20, (i) => ({ meteringFlag: i < 2 }))
    await file(db, 1n, STRANGER, KIND_METERING, bundle, metering)
    await file(db, 2n, AUDITOR, KIND_METERING, bundle, metering)
    expect(await rule(db, 1n)).toMatchObject({ outcome: OUTCOME_DISMISS, reason: "evidence_wrong_filer" })
    expect(await rule(db, 2n)).toMatchObject({ outcome: OUTCOME_BREACH })
  })

  test("the auditor's own second filing of a root dismisses, under any kind", async () => {
    const { db, bundle } = await fixture(20, (i) => ({ canaryFail: i < 2, meteringFlag: i < 2 }))
    await file(db, 1n, AUDITOR, KIND_METERING, bundle, metering)
    await file(db, 2n, AUDITOR, KIND_CANARY, bundle, metering)
    expect(await rule(db, 1n)).toMatchObject({ outcome: OUTCOME_BREACH })
    expect(await rule(db, 2n)).toEqual({ outcome: OUTCOME_DISMISS, slashBps: 0, reason: "evidence_reused" })
  })

  test("a swap bundle the panel dismissed cannot come back as a canary or a swap", async () => {
    const zs = swapZs()
    const { db, bundle } = await fixture(zs.length, (i) => ({ canaryFail: i < 20, refAgrees: i === 0 }), zs)
    const result = score(bundle.samples, PUBLISHED_BASELINE)
    const stat = { statistic: scaleStatistic(result.statistic), threshold: scaleStatistic(result.threshold), testId: testIdHash(TEST_ID) }
    await file(db, 1n, AUDITOR, KIND_SWAP, bundle, stat)
    expect(await rule(db, 1n)).toMatchObject({ outcome: OUTCOME_SWAP, slashBps: 10_000 })
    await applyAuditCourt(db, { ...base(1n), event: "PanelDecided", args: { challengeId: "1", decision: 2, finalSlashBps: 0 } })
    await applyAuditCourt(db, { ...base(1n), event: "ChallengeFinalized", args: { challengeId: "1", slashBps: 0, slashedUsdg: "0" } })

    await file(db, 2n, STRANGER, KIND_CANARY, bundle, { statistic: 0n, threshold: 0n, testId: hash("anything") })
    expect(await rule(db, 2n)).toMatchObject({ outcome: OUTCOME_DISMISS })
    await file(db, 3n, STRANGER, KIND_SWAP, bundle, stat)
    expect(await rule(db, 3n)).toMatchObject({ outcome: OUTCOME_DISMISS })
  }, 120_000)
})
