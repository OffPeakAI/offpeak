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
