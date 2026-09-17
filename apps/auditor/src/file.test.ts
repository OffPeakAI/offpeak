import { beforeEach, describe, expect, test } from "bun:test"
import { PUBLISHED_BASELINE, TEST_ID, TEST_VERSION, mulberry32, scan, score, simulateWeek } from "@offpeak/audit-tests"
import { AuditCourtAbi } from "@offpeak/abis"
import { CHALLENGE_BOND, evidenceRoot, scaleStatistic, testIdHash, type Hex } from "@offpeak/shared"
import { TransactionReceiptNotFoundError, decodeFunctionData, keccak256, parseTransaction, toBytes } from "viem"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { Metrics } from "../../../services/common/src/metrics.ts"
import { KIND_SWAP, OUTCOME_SWAP, decideRuling } from "../../../services/rulings/src/decide.ts"
import { openDb } from "../../router/src/store.ts"
import type { Db } from "../../../services/common/src/db.ts"
import { canaryThreshold } from "./canaries.ts"
import { buildSwapBundle, loadRunScores, type AuditBundle, type RunScores } from "./evidence.ts"
import { LOW_BOND_MICRO, checkBond, fileMetering, fileSwap, fileThroughput, reconcileFilings, swapSignals } from "./file.ts"

const HOST = `0x${"aa".repeat(20)}` as Hex
const MODEL = keccak256(toBytes("model"))
const REF_A = `0x${"0a".repeat(20)}`
const REF_B = `0x${"0b".repeat(20)}`
const LEAF = keccak256(toBytes("leaf"))

const idOf = (i: number) => keccak256(toBytes(`req-${i}`))

function flaggedWeek(seed = 1) {
  for (let s = seed; s < seed + 500; s++) {
    const week = simulateWeek(mulberry32(s), 400, 0.25, PUBLISHED_BASELINE.delta)
    const read = scan(week, PUBLISHED_BASELINE)
    if (read.flagged) return { zs: week.map((row) => row.z), n: read.n }
  }
  throw new Error("no flagged week")
}

function honestWeek() {
  return simulateWeek(mulberry32(3), 400, 0, PUBLISHED_BASELINE.delta).map((row) => row.z)
}

type BundleOpts = { zs: number[]; first: number; replication?: "fresh" | "none" | "unflagged" | "same-ref" | "reused" | "host-as-ref"; canaryFails?: number; threshold?: number }

/** A bundle as `buildSwapBundle` writes it, then edited by each test. */
function bundleOf(opts: BundleOpts): AuditBundle {
  const { zs, first } = opts
  const reqIds = zs.map((_z, i) => idOf(i))
  const fresh = reqIds.slice(first)
  const kind = opts.replication ?? "fresh"
  const replicaZs = kind === "unflagged" ? fresh.map(() => 1) : fresh.map((_r, i) => zs[first + i]!)
  const replicaRef = kind === "same-ref" ? REF_A : kind === "host-as-ref" ? HOST : REF_B
  const replication = kind === "none" ? null : { primaryRef: REF_A, refHost: replicaRef, reqIds: kind === "reused" ? reqIds.slice(0, fresh.length) : fresh, zs: replicaZs }
  const signalled = new Set(kind === "none" || kind === "unflagged" ? [] : kind === "reused" ? reqIds.slice(0, fresh.length) : fresh)
  const failedIds = new Set(reqIds.slice(0, opts.canaryFails ?? 0))
  return {
    v: 1,
    host: HOST,
    modelDigest: MODEL,
    testId: TEST_ID,
    testVersion: TEST_VERSION,
    baseline: { ...PUBLISHED_BASELINE },
    samples: zs.map((z, i) => ({ reqId: reqIds[i]!, hour: 1, leaf: LEAF, proof: [], z, canaryFail: failedIds.has(reqIds[i]!), refAgrees: signalled.has(reqIds[i]!), meteringFlag: false })),
    attachments: {
      firstRun: first,
      scores: [],
      canaries: [...failedIds].map((reqId) => ({ reqId, promptId: "sum:1", deterministic: true, body: {}, output: "wrong", accepted: ["right"] })),
      buyerSamples: [],
      replication,
      canaryThreshold: opts.threshold ?? 0,
    },
  }
}

const swapBundle = () => {
  const { zs, n } = flaggedWeek()
  return bundleOf({ zs, first: n })
}

function factsFor(bundle: AuditBundle) {
  const result = score(bundle.samples, PUBLISHED_BASELINE)
  return { host: bundle.host, kind: KIND_SWAP, samplesRoot: evidenceRoot(bundle), sampleCount: bundle.samples.length, testId: testIdHash(TEST_ID), statistic: scaleStatistic(result.statistic), threshold: scaleStatistic(result.threshold) }
}

describe("the two-signal rule", () => {
  test("a flag with a fresh replication on a second reference passes, and a ruling agrees", () => {
    const bundle = swapBundle()
    expect(swapSignals(bundle)).toEqual({ sequential: true, canary: false, replication: true, reason: null })
    expect(decideRuling(bundle, factsFor(bundle), true).outcome).toBe(OUTCOME_SWAP)
  })

  test("a flag with canary failures past their threshold passes, and a ruling agrees", () => {
    const { zs, n } = flaggedWeek()
    const bundle = bundleOf({ zs, first: n, replication: "none", canaryFails: 30, threshold: 10 })
    expect(swapSignals(bundle)).toEqual({ sequential: true, canary: true, replication: false, reason: null })
    expect(decideRuling(bundle, factsFor(bundle), true).outcome).toBe(OUTCOME_SWAP)
  })

  test("a flag alone does not pass", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "none" })).reason).toBe("second_signal_missing")
  })

  test("canary failures under their threshold do not pass", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "none", canaryFails: 9, threshold: 10 })).reason).toBe("second_signal_missing")
  })

  test("both second signals without a flag do not pass", () => {
    const zs = honestWeek()
    const bundle = bundleOf({ zs, first: 200, canaryFails: 30, threshold: 10 })
    bundle.attachments.replication!.zs = Array.from({ length: 200 }, () => -6)
    expect(swapSignals(bundle).reason).toBe("test_not_flagged")
  })

  test("a replication that did not flag is no signal", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "unflagged" })).reason).toBe("second_signal_missing")
  })

  test("the same reference host cannot replicate itself", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "same-ref" })).replication).toBe(false)
  })

  test("the audited host cannot be its own reference", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "host-as-ref" })).replication).toBe(false)
  })

  test("a replication must read responses the flag never saw", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "reused" })).replication).toBe(false)
  })

  test("a replication under the sample minimum is no signal", () => {
    const { zs, n } = flaggedWeek()
    const bundle = bundleOf({ zs: zs.slice(0, n + 150), first: n })
    expect(swapSignals(bundle).replication).toBe(false)
  })

  test("a refAgrees mark with nothing behind it is refused as forged", () => {
    const { zs, n } = flaggedWeek()
    const bundle = bundleOf({ zs, first: n, replication: "none" })
    bundle.samples[0]!.refAgrees = true
    expect(swapSignals(bundle).reason).toBe("signal_not_supported_by_evidence")
  })

  test("a canaryFail mark that does not match its canary is refused as forged", () => {
    const { zs, n } = flaggedWeek()
    const bundle = bundleOf({ zs, first: n, replication: "none", canaryFails: 30, threshold: 10 })
    bundle.attachments.canaries[0]!.output = "right"
    expect(swapSignals(bundle).reason).toBe("signal_not_supported_by_evidence")
  })

  test("an open prompt's mismatch cannot count as a canary failure", () => {
    const { zs, n } = flaggedWeek()
    const bundle = bundleOf({ zs, first: n, replication: "none", canaryFails: 30, threshold: 10 })
    for (const canary of bundle.attachments.canaries) canary.deterministic = false
    expect(swapSignals(bundle).reason).toBe("signal_not_supported_by_evidence")
  })

  test("a softer baseline than the pinned one is refused", () => {
    const bundle = swapBundle()
    bundle.baseline = { ...PUBLISHED_BASELINE, logA: 0 }
    expect(swapSignals(bundle).reason).toBe("baseline_not_pinned")
  })

  test("a threshold of zero never counts", () => {
    const { zs, n } = flaggedWeek()
    expect(swapSignals(bundleOf({ zs, first: n, replication: "none", threshold: 0 })).canary).toBe(false)
  })

  test("across 2,000 simulated swap weeks with no second signal, none passes", () => {
    const rng = mulberry32(77)
    let flagged = 0
    for (let run = 0; run < 2_000; run++) {
      const week = simulateWeek(rng, 400, 0.1, PUBLISHED_BASELINE.delta)
      const read = scan(week, PUBLISHED_BASELINE)
      if (read.flagged) flagged++
      expect(swapSignals(bundleOf({ zs: week.map((row) => row.z), first: read.n, replication: "none" })).reason).not.toBeNull()
    }
    expect(flagged).toBeGreaterThan(1_900)
  })
})

type Sent = { functionName: string; args: readonly unknown[] }

const signerKey = roleAccount("settlerC")

/** Real gate and real database; the chain clients are stubs that record every write. Signing is real, so the bytes parse. */
function stubDeps(db: Db, opts: { balance?: bigint; revert?: boolean } = {}) {
  const writes: Sent[] = []
  const signed: Hex[] = []
  const broadcasts: Hex[] = []
  const chain = {
    nonce: 0,
    /** How many nonces the chain has used. Past a transaction's own, that transaction can never land. */
    taken: 0n,
    receipt: false,
    failBroadcast: null as string | null,
    failSimulate: (_evidence: { samplesRoot: Hex }) => false,
  }
  const reader = {
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "verifyLeaf" ? true : functionName === "balanceOf" ? (opts.balance ?? 5_000_000_000n) : 10n ** 12n),
    simulateContract: async (request: { args: [{ samplesRoot: Hex }] }) => {
      if (chain.failSimulate(request.args[0])) throw new Error("would revert")
      return { request }
    },
    getBlockNumber: async () => 100n,
    getContractEvents: async () => [],
    getTransactionCount: async () => chain.taken,
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!chain.receipt) throw new TransactionReceiptNotFoundError({ hash })
      return { status: "success", logs: [] }
    },
    waitForTransactionReceipt: async () => ({ status: opts.revert ? "reverted" : "success", logs: [] }),
  }
  const writer = {
    prepareTransactionRequest: async (request: { to: Hex; data: Hex }) => ({ to: request.to, data: request.data, type: "eip1559", chainId: 4663, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: chain.nonce++ }),
    signTransaction: async (request: never) => {
      const raw = await signerKey.signTransaction(request)
      signed.push(raw)
      return raw
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      broadcasts.push(serializedTransaction)
      if (chain.failBroadcast) {
        const message = chain.failBroadcast
        chain.failBroadcast = null
        throw new Error(message)
      }
      writes.push(decodeFunctionData({ abi: AuditCourtAbi, data: parseTransaction(serializedTransaction).data! }) as Sent)
      return keccak256(serializedTransaction)
    },
  }
  return { deps: { db, reader, writer, account: { address: `0x${"cc".repeat(20)}` }, contracts: { AuditCourt: `0x${"dd".repeat(20)}`, MockUSDG: `0x${"ee".repeat(20)}` }, metrics: new Metrics(), env: "local" } as never, writes, signed, broadcasts, chain }
}

async function seedRecords(db: Db, bundle: { samples: { reqId: string; leaf: string }[]; host: string }) {
  for (const sample of bundle.samples) {
    await db.query(
      `INSERT INTO shared.usage_records (req_id, hour, ts, payer, buyer_ref, host, model_digest, tokens_in, tokens_out, prompt_hash, output_hash, price_in, price_out, host_cost_micro, fee_micro, fee_bps, pay_mode, pay_ref, sheet_hash, router_sig, host_sig, leaf)
       VALUES ($1,1,3600,'0xbb','0x0',$2,'0x0',1,1,'0x0','0x0',1,1,1,1,400,0,'0x0','0x0','0x0','0x0',$3) ON CONFLICT DO NOTHING`,
      [sample.reqId, bundle.host, sample.leaf],
    )
  }
}

describe("filing", () => {
  let db: Db

  beforeEach(async () => {
    db = await openDb()
  })

  test("a supported swap goes out once, and the bundle is stored by its root", async () => {
    const bundle = swapBundle()
    await seedRecords(db, bundle)
    const { deps, writes } = stubDeps(db)
    const first = await fileSwap(deps, bundle, 7)
    expect(first).toMatchObject({ filed: true, root: evidenceRoot(bundle) })
    expect(writes.map((w) => w.functionName)).toEqual(["challenge"])
    const stored = await db.query<{ body: AuditBundle }>("SELECT body FROM shared.evidence_bundles WHERE samples_root = $1", [evidenceRoot(bundle)])
    expect(evidenceRoot(stored.rows[0]!.body)).toBe(evidenceRoot(bundle))
    expect(await fileSwap(deps, bundle, 7)).toEqual({ filed: false, reason: "already_filed" })
    expect(writes).toHaveLength(1)
  })

  test("a flag with no second signal writes nothing at all", async () => {
    const { zs, n } = flaggedWeek()
    const bundle = bundleOf({ zs, first: n, replication: "none" })
    await seedRecords(db, bundle)
    const { deps, writes } = stubDeps(db)
    expect(await fileSwap(deps, bundle, 7)).toEqual({ filed: false, reason: "second_signal_missing" })
    expect(writes).toHaveLength(0)
    expect((await db.query("SELECT 1 FROM serving.audit_filings")).rows).toHaveLength(0)
    expect((await db.query("SELECT 1 FROM shared.evidence_bundles")).rows).toHaveLength(0)
  })

  test("canary failures past the auditor's threshold but under a ruling's share are not filed", async () => {
    const { zs, n } = flaggedWeek()
    const bundle = bundleOf({ zs, first: n, replication: "none", canaryFails: 5, threshold: 4 })
    await seedRecords(db, bundle)
    const { deps, writes } = stubDeps(db)
    expect(await fileSwap(deps, bundle, 7)).toEqual({ filed: false, reason: "ruling_would_be_second_signal_missing" })
    expect(writes).toHaveLength(0)
  })

  test("the database itself refuses a swap row without both signals", async () => {
    const insert = (sequential: boolean, canary: boolean, replication: boolean) =>
      db.query(
        `INSERT INTO serving.audit_filings (id, host, model_digest, week, kind, samples_root, evidence, signal_sequential, signal_canary, signal_replication, status, from_block)
         VALUES ('x','0xh','0xm',1,0,'0xr','{}'::jsonb,$1,$2,$3,'prepared',0)`,
        [sequential, canary, replication],
      )
    await expect(insert(true, false, false)).rejects.toThrow("swap_needs_two_signals")
    await expect(insert(false, true, true)).rejects.toThrow("swap_needs_two_signals")
    await insert(true, false, true)
  })

  test("there is no way to file a kind 3 challenge", async () => {
    const statement = db.query(
      `INSERT INTO serving.audit_filings (id, host, model_digest, week, kind, samples_root, evidence, status, from_block) VALUES ('x','0xh','0xm',1,3,'0xr','{}'::jsonb,'prepared',0)`,
    )
    await expect(statement).rejects.toThrow()
    const exported = await import("./file.ts")
    expect(Object.keys(exported).filter((name) => /^file/.test(name)).sort()).toEqual(["fileMetering", "fileSwap", "fileThroughput"])
    expect(Object.keys(exported)).not.toContain("submit")
  })

  test("off a local chain, nothing files until a hardware calibration matches the pin", async () => {
    const bundle = swapBundle()
    await seedRecords(db, bundle)
    const { deps, writes } = stubDeps(db)
    ;(deps as { env: string }).env = "mainnet"
    expect(await fileSwap(deps, bundle, 7)).toEqual({ filed: false, reason: "not_calibrated" })
    await db.query("INSERT INTO serving.audit_calibrations (id, model_digest, source, ready, report) VALUES ('sim',$1,'simulation',false,$2::jsonb)", [MODEL, JSON.stringify({ delta: 2.5, logA: 5 })])
    expect(await fileSwap(deps, bundle, 7)).toEqual({ filed: false, reason: "not_calibrated" })
    await db.query("INSERT INTO serving.audit_calibrations (id, model_digest, source, ready, report) VALUES ('other',$1,'hardware',true,$2::jsonb)", [MODEL, JSON.stringify({ delta: 3, logA: 5 })])
    expect(await fileSwap(deps, bundle, 7)).toEqual({ filed: false, reason: "not_calibrated" })
    await db.query("INSERT INTO serving.audit_calibrations (id, model_digest, source, ready, report) VALUES ('real',$1,'hardware',true,$2::jsonb)", [MODEL, JSON.stringify({ delta: 2.5, logA: 5 })])
    expect((await fileSwap(deps, bundle, 7)).filed).toBe(true)
    expect(writes).toHaveLength(1)
  })

  test("a leaf that does not prove stops the filing", async () => {
    const bundle = swapBundle()
    const { deps, writes } = stubDeps(db)
    expect(await fileSwap(deps, bundle, 7)).toEqual({ filed: false, reason: "leaf_unproven" })
    expect(writes).toHaveLength(0)
  })

  test("a bond under one challenge stops the filing", async () => {
    const bundle = swapBundle()
    await seedRecords(db, bundle)
    const { deps, writes } = stubDeps(db, { balance: CHALLENGE_BOND - 1n })
    expect(await fileSwap(deps, bundle, 7)).toEqual({ filed: false, reason: "bond_too_low" })
    expect(writes).toHaveLength(0)
  })

  test("the low-bond alert fires under 1,000 USDG and clears at it", async () => {
    const low = stubDeps(db, { balance: LOW_BOND_MICRO - 1n })
    await checkBond(low.deps)
    expect((low.deps as { metrics: Metrics }).metrics.get("auditor_bond_low")).toBe(1)
    const fine = stubDeps(db, { balance: LOW_BOND_MICRO })
    await checkBond(fine.deps)
    expect((fine.deps as { metrics: Metrics }).metrics.get("auditor_bond_low")).toBe(0)
  })

  test("a revert is recorded and not retried as if it landed", async () => {
    const bundle = swapBundle()
    await seedRecords(db, bundle)
    const { deps } = stubDeps(db, { revert: true })
    expect(await fileSwap(deps, bundle, 7)).toEqual({ filed: false, reason: "reverted" })
    const rows = await db.query<{ status: string }>("SELECT status FROM serving.audit_filings")
    expect(rows.rows[0]!.status).toBe("failed")
  })
