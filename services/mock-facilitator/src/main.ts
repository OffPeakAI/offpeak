import { Hono } from "hono"
import { MockFacilitator } from "./state.ts"

export function facilitatorApp(fac: MockFacilitator, internalToken: string) {
  const app = new Hono()
  app.get("/x402/supported", (c) =>
    c.json({
      kinds: [
        { scheme: "channel", network: "eip155:4663" },
        { scheme: "upto", network: "eip155:4663" },
        { scheme: "exact", network: "eip155:4663" },
      ],
    }),
  )
  app.post("/x402/verify", async (c) => c.json(await fac.verify(await c.req.json())))
  app.post("/x402/settle", async (c) => c.json(fac.settle(await c.req.json())))
  app.post("/x402/capture", async (c) => {
    if (c.req.header("authorization") !== `Bearer ${internalToken}`) return c.json({ error: "unauthorized" }, 401)
    const body = await c.req.json()
    return c.json(fac.capture(body.reqId, BigInt(body.actual)))
  })
  app.get("/x402/status/:reqId", (c) => c.json({ reqId: c.req.param("reqId") }))
  return app
}

export async function startMockFacilitator() {
  const { MockIndexer } = await import("../../mock-indexer/src/state.ts")
  const idx = new MockIndexer()
  const fac = new MockFacilitator((msg) => idx.emit(msg))
  const port = Number(process.env.OFFPEAK_FACILITATOR_PORT ?? 8789)
  Bun.serve({ port, fetch: facilitatorApp(fac, process.env.OFFPEAK_INTERNAL_TOKEN ?? "local-test-token-0123456789abcdef").fetch })
  console.log(`mock facilitator on ${port}`)
}

if (import.meta.main) await startMockFacilitator()
