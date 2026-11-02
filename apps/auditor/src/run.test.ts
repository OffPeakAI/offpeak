import { beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mulberry32, simulateWeek, PUBLISHED_BASELINE } from "@offpeak/audit-tests"
import { keccakUtf8, outputHashOf, promptHashOf, weekIndex, type Hex } from "@offpeak/shared"
import { keccak256, toBytes } from "viem"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import type { Db } from "../../../services/common/src/db.ts"
import { Metrics } from "../../../services/common/src/metrics.ts"
import { noteForAudit } from "../../router/src/audit/capture.ts"
import { openDb } from "../../router/src/store.ts"
import { bootStack } from "../../router/test/support/stack.ts"
import type { AuditDeps } from "./deps.ts"
import { advanceFlagged, runMetering, runSequential, runThroughput, scorePending, syncOutcomes, uncalibratedHosts, weekStartOf } from "./run.ts"
import { MAX_SCORE_ATTEMPTS, SAMPLE_TTL_S, storeSample } from "./sample.ts"
import { baselineId } from "./score.ts"

const HOST = `0x${"aa".repeat(20)}` as Hex
const MODEL = keccak256(toBytes("model"))
const NOW = 1_800_000_000
const WEEK = weekIndex(NOW)
const START = weekStartOf(WEEK)
const KEK = randomBytes(32)
const WALLET = "0xabab000000000000000000000000000000000001"
const LOGPROBS = { logprobs: [{ logprob: -1 }, { logprob: -2 }, { logprob: -3 }] }

function hostView(over: object = {}) {
  return { operator: HOST, status: 2, gpuClass: "0xgpu", imageDigest: "0ximage", models: [{ digest: MODEL, maxTps: 100 }], ...over }
}

function deps(db: Db, over: Partial<AuditDeps> = {}): AuditDeps {
  return {
    env: "local",
    db,
    chain: { host: async () => hostView(), hostList: async () => [hostView()], proof: async () => null } as never,
    fetcher: async () => Response.json(LOGPROBS),
    account: roleAccount("settlerC") as never,
    reader: {} as never,
    writer: {} as never,
    contracts: {},
    metrics: new Metrics(),
    kek: KEK,
    routerUrl: "http://router.local",
    indexerUrl: "http://indexer.local",
    internalToken: "token",
    accounts: [],
    corpus: null,
    models: [{ name: "ofm-8b", digest: MODEL }],
    enqueueCanary: async () => undefined,
    fileThroughput: false,
    rng: mulberry32(1),
    clock: () => NOW,
    ...over,
  }
}

async function insertRecord(db: Db, reqId: string, fields: { ts: number; promptHash?: string; outputHash?: string; host?: string; tokensOut?: number }) {
  await db.query(
    `INSERT INTO shared.usage_records (req_id, hour, ts, payer, buyer_ref, host, model_digest, tokens_in, tokens_out, prompt_hash, output_hash, price_in, price_out, host_cost_micro, fee_micro, fee_bps, pay_mode, pay_ref, sheet_hash, router_sig, host_sig, leaf)
     VALUES ($1,$2,$3,'0xbb','0x0',$4,$5,1,$6,$7,$8,1,1,1,1,400,0,'0x0','0x0','0x0','0x0',$9)`,
    [reqId, Math.floor(fields.ts / 3600), fields.ts, fields.host ?? HOST, MODEL, fields.tokensOut ?? 16, fields.promptHash ?? "0x0", fields.outputHash ?? "0x0", keccakUtf8(`leaf-${reqId}`)],
  )
}

async function reference(db: Db, host = "0xref", attested = true) {
  await db.query("INSERT INTO serving.audit_reference_hosts (host, model_digest, endpoint, gpu_class, image_digest, attested) VALUES ($1,$2,'http://ref','0xgpu','0ximage',$3)", [host, MODEL, attested])
}

async function baseline(db: Db) {
  await db.query("INSERT INTO serving.audit_baselines (model_digest, gpu_class, image_digest, temp_bucket, len_bucket, mu, sigma, n, version) VALUES ($1,'0xgpu','0ximage','(0.5,1]','<=64',-1,1,500,'v1')", [MODEL])
}

async function insertScores(db: Db, zs: readonly number[], fromTs = START + 100) {
  for (const [i, z] of zs.entries()) {
    await db.query("INSERT INTO serving.audit_scores (req_id, host, model_digest, bucket, ll_mean, z, ref_host, source, ts) VALUES ($1,$2,$3,'b',$4,$4,'0xref','canary',$5)", [keccakUtf8(`score-${i}-${fromTs}`), HOST, MODEL, z, fromTs + i])
  }
}

const flaggedZs = () => simulateWeek(mulberry32(1), 260, 0.3, PUBLISHED_BASELINE.delta).map((row) => row.z)

let db: Db

beforeEach(async () => {
  db = await openDb()
  await db.query("INSERT INTO serving.accounts (id, wallet, audit_opt_in) VALUES ('acct',$1,true)", [WALLET])
})

const content = { messages: [{ role: "user", content: "a private question" }], temperature: 0.7 }

async function storedSample(reqId: string, over: { output?: string; promptHash?: string } = {}) {
  const text = over.output ?? "w1 w2 w3"
  await insertRecord(db, reqId, { ts: NOW - 60, promptHash: over.promptHash ?? promptHashOf(content), outputHash: outputHashOf(text, []) })
  await storeSample(db, KEK, { reqId, host: HOST, modelDigest: MODEL, accountId: "acct", body: content, text, toolCalls: [], ts: NOW - 60 })
}

describe("scoring", () => {
  test("a sample is scored once, by a reference host, then waits for retention", async () => {
    await reference(db)
    await baseline(db)
    let calls = 0
    const d = deps(db, { fetcher: async () => (calls++, Response.json(LOGPROBS)) })
    await storedSample("0x1")
    expect(await scorePending(d)).toEqual({ samples: 1, canaries: 0 })
    expect(await scorePending(d)).toEqual({ samples: 0, canaries: 0 })
    expect(calls).toBe(1)
    const rows = await db.query<{ z: number; ref_host: string; source: string; bucket: string }>("SELECT z, ref_host, source, bucket FROM serving.audit_scores")
    expect(rows.rows[0]).toMatchObject({ ref_host: "0xref", source: "sample" })
    expect(Number(rows.rows[0]!.z)).toBe(-1)
  })

  test("a host never scores its own output", async () => {
    await reference(db, HOST)
    await storedSample("0x1")
    const d = deps(db)
    expect((await scorePending(d)).samples).toBe(0)
    expect(d.metrics.get("auditor_no_reference")).toBe(1)
    expect((await db.query("SELECT 1 FROM serving.audit_scores")).rows).toHaveLength(0)
  })

  test("a body that does not hash to its signed record is dropped, not scored", async () => {
    await reference(db)
    await storedSample("0x1", { promptHash: keccakUtf8("something else") })
    const d = deps(db)
    await scorePending(d)
    expect((await db.query("SELECT 1 FROM serving.audit_scores")).rows).toHaveLength(0)
    expect(d.metrics.get("auditor_sample_hash_mismatch")).toBe(1)
  })

  test("an expired body is not scored", async () => {
    await reference(db)
    await storedSample("0x1")
    expect((await scorePending(deps(db, { clock: () => NOW - 60 + SAMPLE_TTL_S + 1 }))).samples).toBe(0)
  })

  test("a reference host's failure leaves the sample to retry, after a wait", async () => {
    await reference(db)
    await storedSample("0x1")
    expect((await scorePending(deps(db, { fetcher: async () => new Response("no", { status: 500 }) }))).samples).toBe(0)
    expect((await scorePending(deps(db))).samples).toBe(0)
    expect((await scorePending(deps(db, { clock: () => NOW + 61 }))).samples).toBe(1)
  })

  async function canaryRun(id: string, host: string, ts: number, output = "w1 w2") {
    await db.query(
      `INSERT INTO serving.canary_runs (id, host, expected, output, req_id, model_digest, prompt_id, body, wallet, tokens_out, ts)
       VALUES ($1,$2,'[]'::jsonb,$3,$1,$4,'p',$5::jsonb,$6,2,$7)`,
      [id, host, output, MODEL, JSON.stringify(content), WALLET, ts],
    )
  }

  test("one reference-host 400 costs that response, not the pass", async () => {
    await reference(db)
    await canaryRun("0xfull", HOST, NOW - 10, "fills-the-context")
    await canaryRun("0xfine", HOST, NOW - 5)
    await storedSample("0x1")
    const d = deps(db, { fetcher: async (_url, init) => (String(init.body).includes("fills-the-context") ? new Response("too long", { status: 400 }) : Response.json(LOGPROBS)) })
    expect(await scorePending(d)).toEqual({ samples: 1, canaries: 1 })
    const scored = await db.query<{ req_id: string }>("SELECT req_id FROM serving.audit_scores ORDER BY req_id")
    expect(scored.rows.map((row) => row.req_id)).toEqual(["0x1", "0xfine"])
  })

  test("a row stops being tried at its attempt limit, and says so", async () => {
    await reference(db)
    await canaryRun("0xfull", HOST, NOW - 10)
    let calls = 0
    let now = NOW
    const d = deps(db, { clock: () => now, fetcher: async () => (calls++, new Response("too long", { status: 400 })) })
    for (let pass = 0; pass < MAX_SCORE_ATTEMPTS + 5; pass++) {
      await scorePending(d)
      now += 2 * 86_400
    }
    expect(calls).toBe(MAX_SCORE_ATTEMPTS)
    expect(d.metrics.get("auditor_score_gave_up")).toBe(1)
  })

  test("two hundred canaries nobody can score do not hold up newer ones", async () => {
    await reference(db)
    for (let i = 0; i < 200; i++) await canaryRun(`0xstuck${i}`, "0xnoreference", NOW - 1_000 + i)
    await canaryRun("0xnew", HOST, NOW)
    const noRef = { host: async (host: string) => (host === HOST ? hostView() : hostView({ gpuClass: "0xother" })), hostList: async () => [hostView()], proof: async () => null }
    const d = deps(db, { chain: noRef as never })
    expect((await scorePending(d)).canaries).toBe(0)
    expect((await scorePending(deps(db, { chain: noRef as never, clock: () => NOW + 61 }))).canaries).toBe(1)
    expect((await db.query<{ req_id: string }>("SELECT req_id FROM serving.audit_scores")).rows.map((row) => row.req_id)).toEqual(["0xnew"])
  })

  test("a sample that keeps failing cannot keep newer samples out", async () => {
    await reference(db)
    await storedSample("0x1", { output: "fills-the-context" })
    await storedSample("0x2")
    const d = deps(db, { fetcher: async (_url, init) => (String(init.body).includes("fills-the-context") ? new Response("no", { status: 400 }) : Response.json(LOGPROBS)) })
    expect((await scorePending(d)).samples).toBe(1)
    const rows = await db.query<{ req_id: string; score_attempts: number }>("SELECT req_id, score_attempts FROM serving.audit_samples ORDER BY req_id")
    expect(rows.rows).toEqual([{ req_id: "0x1", score_attempts: 1 }, { req_id: "0x2", score_attempts: 0 }])
  })

  test("a request with parameters calibration never saw is not scored, so it cannot move z", async () => {
    await reference(db)
    await baseline(db)
    await db.query(
      `INSERT INTO serving.canary_runs (id, host, expected, output, req_id, model_digest, prompt_id, body, wallet, tokens_out, ts)
       VALUES ('c1',$1,'[]'::jsonb,'w1 w2','0xc1',$2,'p',$3::jsonb,$4,2,$5)`,
      [HOST, MODEL, JSON.stringify({ ...content, presence_penalty: 2 }), WALLET, NOW],
    )
    let calls = 0
    const d = deps(db, { fetcher: async () => (calls++, Response.json(LOGPROBS)) })
    await scorePending(d)
    expect(calls).toBe(0)
    expect((await db.query("SELECT 1 FROM serving.audit_scores")).rows).toHaveLength(0)
    expect((await db.query<{ scored: boolean }>("SELECT scored_at IS NOT NULL AS scored FROM serving.canary_runs")).rows[0]!.scored).toBe(true)
    expect(d.metrics.get("auditor_uncalibrated_params")).toBe(1)
  })

  test("canaries are scored the same way, with their own source", async () => {
    await reference(db)
    await db.query(
      `INSERT INTO serving.canary_runs (id, host, expected, output, req_id, model_digest, prompt_id, body, wallet, tokens_out, ts)
       VALUES ('c1',$1,'[]'::jsonb,'w1 w2','0xc1',$2,'p',$3::jsonb,$4,2,$5)`,
      [HOST, MODEL, JSON.stringify(content), WALLET, NOW],
    )
    expect((await scorePending(deps(db))).canaries).toBe(1)
    const rows = await db.query<{ source: string }>("SELECT source FROM serving.audit_scores")
    expect(rows.rows[0]!.source).toBe("canary")
  })

  test("a host missing from the chain view is skipped", async () => {
    await reference(db)
    await storedSample("0x1")
    expect((await scorePending(deps(db, { chain: { host: async () => null, hostList: async () => [], proof: async () => null } as never }))).samples).toBe(0)
  })
})

describe("the weekly run", () => {
  test("too few samples never flags, whatever they look like", async () => {
    await insertScores(db, Array.from({ length: 199 }, () => -8))
    expect(await runSequential(deps(db, { clock: () => START + 5_000 }))).toEqual({ pairs: 1, flagged: 0 })
  })

  test("a crossing raises the canary rate for a week and stays recorded", async () => {
    await insertScores(db, flaggedZs())
    const clock = () => START + 5_000
    expect(await runSequential(deps(db, { clock }))).toMatchObject({ flagged: 1 })
    const first = await db.query<{ state: string; boost_until: string; stopped_at: number; llr: number }>("SELECT state, boost_until, stopped_at, llr FROM serving.audit_runs")
    expect(first.rows[0]!.state).toBe("flagged")
    expect(Number(first.rows[0]!.boost_until)).toBe(clock() + 604_800)
    await insertScores(db, Array.from({ length: 400 }, () => 1), START + 6_000)
    await runSequential(deps(db, { clock: () => START + 7_000 }))
    const later = await db.query<{ flagged: boolean; stopped_at: number; state: string }>("SELECT flagged, stopped_at, state FROM serving.audit_runs")
    expect(later.rows[0]).toMatchObject({ flagged: true, state: "flagged", stopped_at: first.rows[0]!.stopped_at })
  })

  test("a score landing late cannot pass as a response the flag never read", async () => {
    await reference(db, "0xref")
    await reference(db, "0xsecond")
    await baseline(db)
    await insertScores(db, flaggedZs())
    await runSequential(deps(db, { clock: () => START + 5_000 }))
    const stopped = Number((await db.query<{ stopped_ts: string }>("SELECT stopped_ts FROM serving.audit_runs")).rows[0]!.stopped_ts)
    const canary = async (reqId: string, ts: number, output: string) => {
      await db.query("INSERT INTO serving.audit_scores (req_id, host, model_digest, bucket, ll_mean, z, ref_host, source, ts) VALUES ($1,$2,$3,'b',-9,-9,'0xref','canary',$4)", [reqId, HOST, MODEL, ts])
      await db.query("INSERT INTO serving.canary_runs (id, host, expected, output, req_id, model_digest, prompt_id, body, wallet, tokens_out, ts) VALUES ($1,$2,'[]'::jsonb,$3,$1,$4,'p',$5::jsonb,$6,2,$7)", [reqId, HOST, output, MODEL, JSON.stringify(content), WALLET, ts])
    }
    await canary("0xlate", stopped - 5, "late-reply")
    await canary("0xfresh", stopped + 5_000, "fresh-reply")
    const key = baselineId({ modelDigest: MODEL, gpuClass: "0xgpu", imageDigest: "0ximage", tempBucket: "(0.5,1]", lenBucket: "<=64" })
    await db.query("UPDATE serving.audit_scores SET bucket = $1", [key])
    const replicated: string[] = []
    const d = deps(db, { clock: () => START + 20_000, fetcher: async (_url, init) => (replicated.push(String(init.body)), Response.json(LOGPROBS)) })
    await advanceFlagged(d)
    expect(replicated.join()).toContain("fresh-reply")
    expect(replicated.join()).not.toContain("late-reply")
  })

  test("a second reference host's failure costs that response, not the run", async () => {
    await reference(db, "0xref")
    await reference(db, "0xsecond")
    await baseline(db)
    await insertScores(db, flaggedZs())
    await runSequential(deps(db, { clock: () => START + 5_000 }))
    const stopped = Number((await db.query<{ stopped_ts: string }>("SELECT stopped_ts FROM serving.audit_runs")).rows[0]!.stopped_ts)
    const key = baselineId({ modelDigest: MODEL, gpuClass: "0xgpu", imageDigest: "0ximage", tempBucket: "(0.5,1]", lenBucket: "<=64" })
    for (const [i, output] of ["refused-reply", "good-reply"].entries()) {
      const reqId = `0xfresh${i}`
      await db.query("INSERT INTO serving.audit_scores (req_id, host, model_digest, bucket, ll_mean, z, ref_host, source, ts) VALUES ($1,$2,$3,$4,-9,-9,'0xref','canary',$5)", [reqId, HOST, MODEL, key, stopped + 100 + i])
      await db.query("INSERT INTO serving.canary_runs (id, host, expected, output, req_id, model_digest, prompt_id, body, wallet, tokens_out, ts) VALUES ($1,$2,'[]'::jsonb,$3,$1,$4,'p',$5::jsonb,$6,2,$7)", [reqId, HOST, output, MODEL, JSON.stringify(content), WALLET, stopped + 100 + i])
    }
    const d = deps(db, { clock: () => START + 20_000, fetcher: async (_url, init) => (String(init.body).includes("refused-reply") ? new Response("too long", { status: 400 }) : Response.json(LOGPROBS)) })
    await advanceFlagged(d)
    expect((await db.query<{ req_id: string }>("SELECT req_id FROM serving.audit_replications")).rows.map((row) => row.req_id)).toEqual(["0xfresh1"])
  })

  test("one run that cannot move does not stop the next", async () => {
    await insertScores(db, flaggedZs())
    await runSequential(deps(db, { clock: () => START + 5_000 }))
    const other = `0x${"bb".repeat(20)}`
    await db.query("UPDATE serving.audit_runs SET stopped_ts = $1", [START + 5_000])
    await db.query("INSERT INTO serving.audit_runs (host, model_digest, week, n, llr, threshold, flagged, stopped_ts, boost_until, state) VALUES ($1,$2,$3,200,9,5,true,$4,$5,'flagged')", [other, MODEL, WEEK, START, START + 10_000])
    const d = deps(db, { clock: () => START + 20_000, chain: { host: async () => hostView(), hostList: async () => [hostView()], proof: async () => null } as never })
    expect(await advanceFlagged(d)).toContainEqual({ host: other, result: "no_second_signal" })
  })

  test("an honest week is open and unflagged", async () => {
    await insertScores(db, simulateWeek(mulberry32(2), 300, 0, 2.5).map((row) => row.z))
    await runSequential(deps(db, { clock: () => START + 5_000 }))
    const rows = await db.query<{ state: string; flagged: boolean; n: number }>("SELECT state, flagged, n FROM serving.audit_runs")
    expect(rows.rows[0]).toEqual({ state: "open", flagged: false, n: 300 })
  })

  test("a flag with no second signal by the end of the boost closes, and nothing is filed", async () => {
    await insertScores(db, flaggedZs())
    await runSequential(deps(db, { clock: () => START + 5_000 }))
    const expired = deps(db, { clock: () => START + 5_000 + 604_801 })
    expect(await advanceFlagged(expired)).toEqual([{ host: HOST, result: "no_second_signal" }])
    expect((await db.query<{ state: string }>("SELECT state FROM serving.audit_runs")).rows[0]!.state).toBe("cleared")
    expect((await db.query("SELECT 1 FROM serving.audit_filings")).rows).toHaveLength(0)
    expect(await advanceFlagged(expired)).toEqual([])
  })

  test("a run waits while its proofs are not settled, and files nothing", async () => {
    await reference(db)
    await insertScores(db, flaggedZs())
    await runSequential(deps(db, { clock: () => START + 5_000 }))
    expect(await advanceFlagged(deps(db, { clock: () => START + 20_000 }))).toEqual([{ host: HOST, result: "test_not_flagged" }])
    expect((await db.query<{ state: string }>("SELECT state FROM serving.audit_runs")).rows[0]!.state).toBe("flagged")
  })
})

describe("metering", () => {
  const week = WEEK - 1
  const weekStart = weekStartOf(week)

  async function flag(reqId: string, reason: string, at: number) {
    await db.query("INSERT INTO serving.metering_flags (req_id, host, router_counts, host_counts, reason, created_at) VALUES ($1,$2,'{}'::jsonb,'{}'::jsonb,$3,to_timestamp($4))", [reqId, HOST, reason, at])
  }

  test("a burst inside one hour is not sustained", async () => {
    for (let i = 0; i < 100; i++) {
      await insertRecord(db, `0x${i}`, { ts: weekStart + i })
      if (i < 30) await flag(`0x${i}`, "counts", weekStart + i)
    }
    expect(await runMetering(deps(db), week)).toEqual([])
  })

  test("flags from the router's own side never count against a host", async () => {
    for (let i = 0; i < 100; i++) {
      await insertRecord(db, `0x${i}`, { ts: weekStart + i * 3_600 })
      await flag(`0x${i}`, i % 2 ? "bill_failed" : "over_hold", weekStart + i * 3_600)
    }
    expect(await runMetering(deps(db), week)).toEqual([])
  })

  test("a low share across many hours is not sustained", async () => {
    for (let i = 0; i < 1_000; i++) await insertRecord(db, keccakUtf8(`r${i}`), { ts: weekStart + i })
    for (let i = 0; i < 30; i++) await flag(keccakUtf8(`r${i}`), "counts", weekStart + i * 3_600)
    expect(await runMetering(deps(db), week)).toEqual([])
  })

  test("refused signatures have no record to prove, so they alert instead of filing", async () => {
    for (let i = 0; i < 30; i++) await flag(`0xrefused${i}`, "sign_refused", weekStart + i * 3_600)
    const d = deps(db)
    expect(await runMetering(d, week)).toEqual([])
    expect(d.metrics.get("auditor_metering_unprovable")).toBe(30)
  })

  test("sustained flags go to filing with a random draw of the host's records", async () => {
    const proofs: string[] = []
    for (let i = 0; i < 500; i++) {
      await insertRecord(db, keccakUtf8(`r${i}`), { ts: weekStart + i * 600 })
      if (i < 60) await flag(keccakUtf8(`r${i}`), "counts", weekStart + i * 600)
    }
    const d = deps(db, {
      chain: {
        proof: async (reqId: string) => (proofs.push(reqId), { hour: 1, leaf: keccakUtf8(`leaf-${reqId}`), proof: [], root: "0x0", txHash: "0x0" }),
      } as never,
      reader: { readContract: async () => false } as never,
      contracts: { UsageLedger: `0x${"11".repeat(20)}`, AuditCourt: `0x${"22".repeat(20)}`, MockUSDG: `0x${"33".repeat(20)}` },
    })
    expect(await runMetering(d, week)).toEqual([{ host: HOST, result: "leaf_unproven" }])
    expect(new Set(proofs).size).toBe(400)
    const flaggedDrawn = proofs.filter((reqId) => Array.from({ length: 60 }, (_, i) => keccakUtf8(`r${i}`)).includes(reqId as Hex)).length
    expect(flaggedDrawn).toBeGreaterThan(30)
    expect(flaggedDrawn).toBeLessThan(60)
  })
})

describe("throughput", () => {
  test("is off unless an operator turns it on", async () => {
    expect(await runThroughput(deps(db, { contracts: { WindowMarket: `0x${"44".repeat(20)}` } }))).toEqual([])
  })

  async function disputed(perf: { below: number; good: number }) {
    for (let i = 0; i < perf.below + perf.good; i++) {
      await db.query("INSERT INTO shared.window_perf (window_id, ts, tokens_per_s, demanded) VALUES (7,to_timestamp($1),$2,true)", [NOW + i * 60, i < perf.below ? 1 : 500])
    }
    return deps(db, {
      fileThroughput: true,
      contracts: { WindowMarket: `0x${"44".repeat(20)}`, UsageLedger: `0x${"11".repeat(20)}` },
      chain: { proof: async () => null } as never,
      reader: {
        getBlockNumber: async () => 10n,
        getContractEvents: async () => [{ args: { id: 7n } }],
        readContract: async () => ({ host: HOST, modelDigest: MODEL, minTps: 100, t1: BigInt(NOW + 3_600) }),
      } as never,
    })
  }

  test("a Window the auditor's own measure says passed is left alone", async () => {
    expect(await runThroughput(await disputed({ below: 10, good: 90 }))).toEqual([])
  })

  test("a Window with too few demanded minutes is left alone, whatever their share", async () => {
    expect(await runThroughput(await disputed({ below: 3, good: 1 }))).toEqual([])
  })

  test("a dispute of a Window that did fail goes towards filing", async () => {
    const d = await disputed({ below: 30, good: 70 })
    ;(d.reader as unknown as { readContract: (args: { functionName: string }) => Promise<unknown> }).readContract = async ({ functionName }) => (functionName === "windowView" ? { host: HOST, modelDigest: MODEL, minTps: 100, t1: BigInt(NOW + 3_600) } : 0n)
    d.contracts.MockUSDG = `0x${"33".repeat(20)}`
    expect(await runThroughput(d)).toEqual([{ windowId: "7", result: "bond_too_low" }])
  })
})

describe("outcomes and coverage", () => {
  test("finished challenges feed the false-flag proxy", async () => {
    await db.query(`INSERT INTO serving.audit_filings (id, host, model_digest, week, kind, samples_root, evidence, signal_sequential, signal_replication, status, challenge_id, from_block) VALUES ('a','0xh','0xm',1,0,'0xr','{}'::jsonb,true,true,'filed','5',0)`)
    const fetcher = async () => Response.json({ head: {}, data: [{ id: 5, state: "finalized", outcome: 0, slash_bps: 0 }, { id: 6, state: "filed", outcome: null, slash_bps: null }] })
    expect(await syncOutcomes({ db, fetcher, indexerUrl: "http://i", internalToken: "t" })).toBe(1)
    expect((await db.query<{ outcome: string }>("SELECT outcome FROM serving.audit_filings")).rows[0]!.outcome).toBe("cleared")
  })

  test("a host on an uncalibrated image or class is named", async () => {
    const d = deps(db)
    expect(await uncalibratedHosts(d)).toEqual([[MODEL, "0xgpu", "0ximage"].join("|")])
    await baseline(db)
    expect(await uncalibratedHosts(d)).toEqual([])
  })
})

describe("router capture", () => {
  const body = { model: "ofm-8b", messages: [{ role: "user", content: "the-private-canary-string" }], temperature: 0.7, max_tokens: 8 }

  test("the router call stores opted-in bodies at the sampled rate and never logs one", async () => {
    const booted = await bootStack()
    process.env.OFFPEAK_AUDIT_SAMPLE_KEK = KEK.toString("hex")
    const logged: string[] = []
    const realError = console.error
    const realLog = console.log
    console.error = (...args: unknown[]) => void logged.push(args.join(" "))
    console.log = (...args: unknown[]) => void logged.push(args.join(" "))
    try {
      await booted.stack.db.query("INSERT INTO serving.accounts (id, wallet, audit_opt_in) VALUES ('opted',$1,true)", [WALLET])
      const input = { reqId: "0x0", host: HOST, modelDigest: MODEL, accountId: "opted", body, text: "reply", toolCalls: [], ts: booted.stack.clock() }
      const runs = 5_000
      await Promise.all(Array.from({ length: runs }, (_, i) => noteForAudit(booted.stack, { ...input, reqId: keccakUtf8(`n${i}`) })))
      const stored = await booted.stack.db.query<{ n: string }>("SELECT count(*) AS n FROM serving.audit_samples")
      const expected = runs * 0.02
      expect(Math.abs(Number(stored.rows[0]!.n) - expected)).toBeLessThan(5 * Math.sqrt(expected))
      expect(logged.join("\n")).not.toContain("the-private-canary-string")
    } finally {
      console.error = realError
      console.log = realLog
      delete process.env.OFFPEAK_AUDIT_SAMPLE_KEK
    }
  })

  test("a buyer who did not opt in leaves no body however many requests they send", async () => {
    const booted = await bootStack()
    process.env.OFFPEAK_AUDIT_SAMPLE_KEK = KEK.toString("hex")
    try {
      const account = booted.key.accountId
      await Promise.all(Array.from({ length: 1_000 }, (_, i) => noteForAudit(booted.stack, { reqId: keccakUtf8(`m${i}`), host: HOST, modelDigest: MODEL, accountId: account, body, text: "reply", toolCalls: [], ts: booted.stack.clock() })))
      expect((await booted.stack.db.query("SELECT 1 FROM serving.audit_samples")).rows).toHaveLength(0)
    } finally {
      delete process.env.OFFPEAK_AUDIT_SAMPLE_KEK
    }
  })

  test("without a KEK nothing is stored, and the request still succeeds", async () => {
    const booted = await bootStack()
    await booted.stack.db.query("UPDATE serving.accounts SET audit_opt_in = true")
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    expect(res.status).toBe(200)
    expect((await booted.stack.db.query("SELECT 1 FROM serving.audit_samples")).rows).toHaveLength(0)
  })

  test("a database failure in capture cannot fail the request", async () => {
    const booted = await bootStack()
    process.env.OFFPEAK_AUDIT_SAMPLE_KEK = "ab".repeat(32)
    const realError = console.error
    console.error = () => undefined
    const realQuery = booted.stack.db.query
    try {
      booted.stack.db.query = ((sql: string, params?: unknown[]) => (sql.includes("audit_opt_in FROM serving.accounts WHERE id") ? Promise.reject(new Error("down")) : realQuery(sql, params))) as never
      await noteForAudit(booted.stack, { reqId: "0x1", host: HOST, modelDigest: MODEL, accountId: "x", body, text: "r", toolCalls: [], ts: booted.stack.clock() })
    } finally {
      console.error = realError
      delete process.env.OFFPEAK_AUDIT_SAMPLE_KEK
    }
  })

  test("request shapes are counted with no content in them", async () => {
    const booted = await bootStack()
    booted.stack.setClock(booted.stack.clock())
    for (let i = 0; i < 3; i++) await noteForAudit(booted.stack, { reqId: `0x${i}`, host: HOST, modelDigest: MODEL, accountId: null, body, text: "r", toolCalls: [], ts: booted.stack.clock() })
    booted.stack.setClock(booted.stack.clock() + 120)
    await noteForAudit(booted.stack, { reqId: "0x9", host: HOST, modelDigest: MODEL, accountId: null, body, text: "r", toolCalls: [], ts: booted.stack.clock() })
    const rows = await booted.stack.db.query<{ shape: string; n: string }>("SELECT shape, n FROM serving.audit_traffic")
    expect(Number(rows.rows[0]!.n)).toBe(4)
    expect(rows.rows[0]!.shape).not.toContain("private")
  })
})
