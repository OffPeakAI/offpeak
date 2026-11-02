import { bearerMatches, type Db, type Metrics } from "@offpeak/common"
import { Hono } from "hono"
import type { Hex } from "viem"
import type { CaptureQueue } from "./capture.ts"
import { acceptSettle, type RelayBatcher } from "./settle.ts"
import { ReadCache, verifyPayment, type PaymentPayload, type VerifyBody, type VerifyDeps } from "./verify.ts"

const NETWORK = "eip155:4663"

export type FacilitatorDeps = {
  verify: VerifyDeps
  db: Db
  batcher: RelayBatcher
  captures: CaptureQueue
  internalToken: string
  metrics: Metrics
}

export function facilitatorApp(deps: FacilitatorDeps) {
  const app = new Hono()
  const cache = new ReadCache(deps.verify.reader)
  const authorized = (header: string | undefined) => bearerMatches(header, deps.internalToken)

  app.get("/x402/supported", (c) =>
    c.json({ kinds: ["channel", "upto", "exact"].map((scheme) => ({ scheme, network: NETWORK })) }),
  )

  app.post("/x402/verify", async (c) => {
    if (!authorized(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401)
    const started = performance.now()
    const result = await verifyPayment(deps.verify, cache, (await c.req.json()) as VerifyBody)
    deps.metrics.set("x402_verify_ms", performance.now() - started)
    return c.json(result)
  })

  app.post("/x402/settle", async (c) => {
    if (!authorized(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401)
    const body = (await c.req.json()) as { paymentPayload: PaymentPayload; mode: "authorize" | "exact" }
    return c.json(await acceptSettle(deps.db, deps.batcher, body.paymentPayload, body.mode))
  })

  app.post("/x402/capture", async (c) => {
    if (!authorized(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401)
    const body = (await c.req.json()) as { reqId: Hex; actual: string }
    await deps.captures.add(body.reqId, BigInt(body.actual))
    return c.json({ queued: true })
  })

  app.get("/x402/status/:reqId", async (c) => {
    const reqId = c.req.param("reqId").toLowerCase()
    const rows = await deps.db.query<{ status: string; tx_hash: string | null; reason: string | null }>(
      "SELECT status, tx_hash, reason FROM chain.x402_claims WHERE req_id = $1",
      [reqId],
    )
    const row = rows.rows[0]
    return c.json({ reqId, status: row?.status ?? "none", txHash: row?.tx_hash ?? null, reason: row?.reason ?? null })
  })

  app.get("/metrics", (c) => c.text(deps.metrics.render()))
  return app
}
