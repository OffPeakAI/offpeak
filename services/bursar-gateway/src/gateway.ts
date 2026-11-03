import { createHash } from "node:crypto"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { capabilityId, hashRequest, requestCommit, requestDocument } from "@bursar/core"
import type { Db } from "@offpeak/common"
import { z } from "zod"
import type { Address, Hex } from "viem"
const address = z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((x) => x.toLowerCase() as Address),
  hash = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((x) => x.toLowerCase() as Hex)
const payment = z.object({
  payload: z.object({
    lock: z.object({ escrow: address, id: z.string().regex(/^[1-9]\d{0,77}$/), mandate: address, transaction: hash, inputCommit: hash }),
    binding: z.object({ requestHash: z.string().regex(/^[a-f0-9]{64}$/), salt: hash }),
  }),
})
const chat = z.strictObject({
  model: z.string().min(1),
  messages: z
    .array(z.strictObject({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(8000) }))
    .min(1)
    .max(30),
  max_tokens: z.number().int().min(1).max(512).default(512),
  stream: z.literal(false).optional(),
})
export type Lock = {
  payer: string
  payee: string
  amount: bigint
  deadline: bigint
  status: number
  inputCommit: string
  capabilityId: string
  outputCommit?: string
}
export type Ports = {
  readLock: (id: bigint) => Promise<Lock>
  isMandate: (account: Address) => Promise<boolean>
  lockedIn: (tx: Hex, id: bigint) => Promise<boolean>
  release: (id: bigint, output: unknown) => Promise<string | null>
  complete: (body: z.output<typeof chat>, cap: bigint) => Promise<unknown>
}
export type Config = {
  origin: string
  merchant: Address
  escrow: Address
  asset: Address
  priceMicro: bigint
  models: readonly string[]
  capability: string
}
export const gatewaySql = `CREATE SCHEMA IF NOT EXISTS gateway; CREATE TABLE IF NOT EXISTS gateway.jobs(id text PRIMARY KEY, credential_hash text NOT NULL, status text NOT NULL, output jsonb, release_tx text, created_at timestamptz NOT NULL DEFAULT now());`
const sha = (s: string) => createHash("sha256").update(s).digest("hex"),
  same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
type Job = { credential_hash: string; status: string; output: unknown; release_tx: string | null }

/** A fixed-price merchant route. The mandate pays the merchant; the merchant funds its own inference. */
export function createGateway(
  config: Config,
  db: Db,
  ports: Ports,
  clock: () => number | Promise<number> = () => Math.floor(Date.now() / 1000),
) {
  const origin = new URL(config.origin)
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    config.priceMicro <= 0n ||
    !config.models.length
  )
    throw Error("Invalid gateway configuration")
  const requirements = {
    scheme: "escrow",
    network: "eip155:4663",
    asset: config.asset,
    payTo: config.merchant,
    maxAmountRequired: config.priceMicro.toString(),
    maxTimeoutSeconds: 180,
    extra: { capability: config.capability, escrow: config.escrow },
  }
  const app = new Hono()
  app.onError(() =>
    Response.json(
      {
        error: {
          code: "gateway_unavailable",
          message: "Gateway could not complete the request. Reuse the same payment proof to check its state.",
        },
      },
      { status: 503 },
    ),
  )
  app.get("/health", (c) => c.json({ ok: true }))
  app.get("/v1/models", (c) => c.json({ object: "list", data: config.models.map((id) => ({ id, object: "model" })) }))
  app.post("/v1/chat/completions", bodyLimit({ maxSize: 128 * 1024 }), async (c) => {
    const raw = await c.req.text()
    let input: unknown
    try {
      input = JSON.parse(raw)
    } catch {
      return c.json({ error: { code: "bad_json", message: "Send a JSON body." } }, 400)
    }
    const parsed = chat.safeParse(input)
    if (!parsed.success || !config.models.includes(parsed.data.model))
      return c.json(
        { error: { code: "bad_request", message: "Choose an allowed model and a non-streaming text request of up to 512 output tokens." } },
        400,
      )
    const cap = c.req.header("x-offpeak-max-charge")
    if (!cap || !/^\d{1,18}$/.test(cap) || BigInt(cap) < config.priceMicro)
      return c.json({ error: { code: "charge_above_cap", message: "The fixed task price exceeds your cap." } }, 429)
    const challenge = () =>
      Response.json(
        {
          x402Version: 1,
          error: "Payment required",
          accepts: [requirements],
          description: "Fixed-price text task; this is not metered OffPeak billing.",
        },
        { status: 402, headers: { "Cache-Control": "no-store" } },
      )
    const header = c.req.header("x-payment") ?? c.req.header("payment-signature")
    if (!header) return challenge()
    if (header.length > 32768) return challenge()
    let proof: z.infer<typeof payment>
    try {
      proof = payment.parse(JSON.parse(Buffer.from(header, "base64").toString()))
    } catch {
      return challenge()
    }
    const ref = proof.payload.lock,
      binding = proof.payload.binding
    if (!same(ref.escrow, config.escrow) || binding.requestHash !== hashRequest(raw)) return challenge()
    const commit = requestCommit(requestDocument({ method: "POST", url: `${origin.origin}/v1/chat/completions`, binding }))
    if (!same(commit, ref.inputCommit)) return challenge()
    const id = `${config.escrow.toLowerCase()}:${ref.id}`,
      credentialHash = sha(header),
      saved = (await db.query<Job>("SELECT * FROM gateway.jobs WHERE id=$1", [id])).rows[0]
    if (saved && saved.credential_hash !== credentialHash) return challenge()
    const answer = (job: Job) =>
      Response.json(job.output, {
        headers: {
          "Cache-Control": "no-store",
          "X-Payment-Response": Buffer.from(
            JSON.stringify({ success: true, network: "eip155:4663", transaction: job.release_tx, payer: ref.mandate }),
          ).toString("base64"),
        },
      })
    if (saved?.status === "released") return answer(saved)
    if (saved?.status === "running" || saved?.status === "failed")
      return c.json(
        {
          error: {
            code: "job_not_retriable",
            message:
              "This payment already started a task. No second task will be charged. An unreleased lock can be reclaimed after its deadline.",
          },
        },
        409,
      )
    const lock = await ports.readLock(BigInt(ref.id))
    if (
      !same(lock.payer, ref.mandate) ||
      !same(lock.payee, config.merchant) ||
      lock.amount !== config.priceMicro ||
      !same(lock.inputCommit, commit) ||
      !same(lock.capabilityId, capabilityId(config.capability))
    )
      return challenge()
    if (
      !saved &&
      (lock.status !== 1 ||
        lock.deadline <= BigInt((await clock()) + 300) ||
        !(await ports.isMandate(ref.mandate)) ||
        !(await ports.lockedIn(ref.transaction, BigInt(ref.id))))
    )
      return challenge()
    if (!saved) {
      const inserted = await db.query(
        `INSERT INTO gateway.jobs(id,credential_hash,status) VALUES ($1,$2,'running') ON CONFLICT DO NOTHING RETURNING id`,
        [id, credentialHash],
      )
      if (!inserted.rows.length) return c.json({ error: { code: "in_progress", message: "This task is already running." } }, 409)
      try {
        const output = await ports.complete(parsed.data, config.priceMicro)
        await db.query("UPDATE gateway.jobs SET status='served',output=$2::jsonb WHERE id=$1", [id, JSON.stringify(output)])
      } catch {
        await db.query("UPDATE gateway.jobs SET status='failed' WHERE id=$1", [id])
        return c.json(
          { error: { code: "task_failed", message: "No escrow release was requested. Reclaim the lock after its deadline." } },
          502,
        )
      }
    }
    return db.transaction(async (txDb) => {
      const job = (await txDb.query<Job>("SELECT * FROM gateway.jobs WHERE id=$1 FOR UPDATE", [id])).rows[0]!
      if (job.status === "released") return answer(job)
      // Persisted output survives a release failure. Retries settle the same task, never run it again.
      const tx = await ports.release(BigInt(ref.id), job.output)
      await txDb.query("UPDATE gateway.jobs SET status='released',release_tx=$2 WHERE id=$1", [id, tx])
      return answer({ ...job, status: "released", release_tx: tx })
    })
  })
  return app
}
