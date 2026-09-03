import { Hono } from "hono"
import { MockIndexer } from "./state.ts"

function wire(data: unknown, idx: MockIndexer) {
  return { head: idx.head, data }
}

function send(c: { body: (b: string, s: number, h: Record<string, string>) => Response }, status: number, body: unknown) {
  const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
  return c.body(json, status, { "content-type": "application/json" })
}

export function indexerApp(idx: MockIndexer) {
  const app = new Hono()
  app.use("/idx/*", async (c, next) => {
    const token = process.env.OFFPEAK_INTERNAL_TOKEN
    if (token && c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401)
    await next()
  })
  app.get("/idx/v1/buyers/:addr", (c) => send(c, 200, wire(idx.buyerNow(c.req.param("addr"), idx.head.blockTs), idx)))
  app.get("/idx/v1/hosts", (c) => send(c, 200, wire([...idx.hosts.values()], idx)))
  app.get("/idx/v1/hosts/:addr", (c) => {
    const host = idx.hosts.get(c.req.param("addr").toLowerCase())
    if (!host) return c.json({ error: "not_found" }, 404)
    return send(c, 200, wire(host, idx))
  })
  app.get("/idx/v1/channels/:id", (c) => send(c, 200, wire(idx.channels.get(c.req.param("id").toLowerCase()) ?? null, idx)))
  app.get("/idx/v1/escrows/:reqId", (c) =>
    c.json(wire(idx.escrows.get(c.req.param("reqId")) ?? { status: "none", maxAmount: "0", captured: "0" }, idx)),
  )
  app.get("/idx/v1/windows/:id", (c) => c.json(wire(idx.windows.get(c.req.param("id")) ?? null, idx)))
  app.get("/idx/v1/windows/:id/holders/:addr", (c) =>
    c.json(wire(idx.holders.get(`${c.req.param("id")}:${c.req.param("addr").toLowerCase()}`) ?? null, idx)),
  )
  app.get("/idx/v1/settlements/:hour", (c) => c.json(wire(idx.settlements.get(c.req.param("hour")) ?? null, idx)))
  app.get("/idx/v1/usage/:reqId/proof", (c) => {
    const proof = idx.proofs.get(c.req.param("reqId"))
    if (!proof) return c.json({ error: "not_found" }, 404)
    return c.json(wire(proof, idx))
  })
  app.get("/idx/v1/challenges", (c) => {
    const host = c.req.query("host")?.toLowerCase()
    return c.json(wire(idx.challenges.filter((row) => !host || row.host === host), idx))
  })
  app.get("/idx/v1/ofpk/:addr", (c) =>
    c.json(wire(idx.ofpk.get(c.req.param("addr").toLowerCase()) ?? { tier: 0, feeDiscountBps: 0, earlyAccess: false }, idx)),
  )
  app.get("/public/v1/stats/hosts", (c) =>
    c.json(
      wire(
        [...idx.hosts.values()].map((h) => ({ host: h.operator, bond: h.bondUsdg.toString(), status: h.status, strikes: h.strikes, revenue30d: "0" })),
        idx,
      ),
    ),
  )
  app.post("/mock/emit", async (c) => {
    const body = await c.req.json()
    idx.emit(body)
    return c.json({ ok: true })
  })
  app.post("/mock/buyers/:addr", async (c) => {
    idx.setBuyer(c.req.param("addr"), await c.req.json())
    return send(c, 200, wire(idx.buyerNow(c.req.param("addr"), idx.head.blockTs), idx))
  })
  return app
}
