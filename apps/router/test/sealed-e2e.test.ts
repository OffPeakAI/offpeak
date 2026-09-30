import { afterEach, describe, expect, test } from "bun:test"
import { Offpeak } from "../../../packages/sdk/src/index.ts"
import { sealedRig, MODEL, TRUST_ROUTER, type RigOptions } from "./support/sealed-rig.ts"

const BASE = "http://router.test"

let stops: (() => void)[] = []

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
})

async function rig(opts?: RigOptions) {
  const booted = await sealedRig(opts)
  stops.push(booted.stop)
  const sent: { url: string; body: Uint8Array | null }[] = []
  const fetchVia = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    sent.push({ url: request.url, body: init?.body ? new Uint8Array(await request.clone().arrayBuffer()) : null })
    return booted.app.fetch(request)
  }) as typeof fetch
  const op = new Offpeak({ baseURL: BASE, apiKey: booted.key.token, deployment: "local", router: booted.stack.router.address, fetch: fetchVia, sealed: TRUST_ROUTER })
  return { ...booted, op, sent }
}

const ask = (content: string, extra: Record<string, unknown> = {}) => ({ model: MODEL, messages: [{ role: "user", content }], max_tokens: 64, ...extra })

const dump = async (stack: Awaited<ReturnType<typeof rig>>["stack"]) => {
  const tables = await stack.db.query<{ schemaname: string; tablename: string }>("SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('shared','serving')")
  const rows: string[] = []
  for (const { schemaname, tablename } of tables.rows) {
    const found = await stack.db.query(`SELECT * FROM ${schemaname}.${tablename}`)
    rows.push(JSON.stringify(found.rows, (_key, value) => (typeof value === "bigint" ? value.toString() : value)))
  }
  return rows.join("\n")
}

describe("sealed end to end", () => {
  test("SDK, router and agent: the reply decrypts and the record is sealed and verifies", async () => {
    const { op, stack, engine, buyer, host } = await rig()
    const hosts = await op.sealed.hosts(MODEL)
    expect(hosts.map((row) => row.host)).toEqual([host as never])
    const result = await op.sealed.chat(ask("hello sealed host"))
    expect(result.text).toBe("Served in the sealed VM.")
    expect(result.envelope.sealed).toBe(true)
    expect(engine.requests[0]!.body.messages[0].content).toBe("hello sealed host")
    const report = await op.verifyUsage(result.envelope, { payer: buyer })
    expect(report.reasons).toEqual([])
    const stored = await stack.db.query<{ sealed: boolean; prompt_hash: string; output_hash: string; tokens_in: number }>("SELECT sealed, prompt_hash, output_hash, tokens_in FROM shared.usage_records")
    expect(stored.rows[0]).toMatchObject({ sealed: true, prompt_hash: result.envelope.record.promptHash, output_hash: result.envelope.record.outputHash })
    const meta = await stack.db.query<{ sealed: boolean }>("SELECT sealed FROM serving.requests")
    expect(meta.rows[0]!.sealed).toBe(true)
    expect(op.usageRecord(result.envelope.record.reqId)?.leaf).toBe(result.envelope.leaf)
  })

  test("a stream arrives in chunks, ends in a record, and op.chat routes sealed requests the same way", async () => {
    const { op } = await rig()
    const stream = await op.sealed.chat({ ...ask("stream it"), stream: true })
    let chunks = 0
    for await (const chunk of stream) chunks += chunk ? 1 : 0
    expect(chunks).toBeGreaterThan(1)
    expect(stream.text).toBe("Served in the sealed VM.")
    expect((await stream.final()).envelope.sealed).toBe(true)
    const direct = await op.chat(ask("through chat"), { sealed: true })
    expect(direct.text).toBe("Served in the sealed VM.")
  })

  test("canary: no plaintext reaches router logs, the database, or the bytes the router handled", async () => {
    const canary = "CANARY-7f3a-sealed-plaintext-marker"
    const reply = `The answer is ${canary}-output`
    const logged: string[] = []
    const hooks = (["log", "info", "warn", "error", "debug"] as const).map((level) => {
      const original = console[level]
      console[level] = (...args: unknown[]) => void logged.push(args.map(String).join(" "))
      return () => (console[level] = original)
    })
    const relayed: Uint8Array[] = []
    const { op, stack, sent, engine, result } = await (async () => {
      try {
        const booted = await rig({ reply: () => ({ text: reply }) })
        const hosts = booted.stack.hosts
        booted.stack.hosts = {
          request: async (host, endpoint, path, init) => {
            if (init.body instanceof Uint8Array) relayed.push(init.body)
            const res = await hosts.request(host, endpoint, path, init)
            relayed.push(new Uint8Array(await res.clone().arrayBuffer()))
            return res
          },
        }
        return { ...booted, result: await booted.op.sealed.chat(ask(`secret prompt ${canary}-input`)) }
      } finally {
        for (const restore of hooks) restore()
      }
    })()
    // The positive controls: the canary really was in play on both sides of the VM boundary.
    expect(result.text).toContain(canary)
    expect(JSON.stringify(engine.requests[0]!.body)).toContain(canary)
    const needles = [canary, Buffer.from(canary).toString("hex"), Buffer.from(canary).toString("base64"), Buffer.from(canary).toString("base64url")]
    const haystacks = [logged.join("\n"), stack.log.join("\n"), await dump(stack), ...sent.flatMap((row) => (row.body ? [Buffer.from(row.body).toString("latin1"), row.url] : [row.url])), ...relayed.map((bytes) => Buffer.from(bytes).toString("latin1"))]
    expect(relayed.length).toBeGreaterThan(0)
    for (const haystack of haystacks) for (const needle of needles) expect(haystack.includes(needle)).toBe(false)
    // The grep can see: the same canary in the clear would be found.
    expect([`x${canary}x`].some((text) => needles.some((needle) => text.includes(needle)))).toBe(true)
  })

  test("a prompt the engine rejects does not come back to the router in its error text", async () => {
    const { op, stack } = await rig({ failWith: 400 })
    const seen: string[] = []
    const hosts = stack.hosts
    stack.hosts = {
      request: async (host, endpoint, path, init) => {
        const res = await hosts.request(host, endpoint, path, init)
        seen.push(await res.clone().text())
        return res
      },
    }
    await expect(op.sealed.chat(ask("rejected canary prompt"))).rejects.toMatchObject({ code: "engine_refused" })
    expect(seen.join("")).not.toContain("rejected canary prompt")
    expect(seen.join("")).not.toContain("engine failed")
  })

  test("a refused request frees its hold", async () => {
    const { op, stack, buyer } = await rig({ failWith: 500 })
    await expect(op.sealed.chat(ask("fails"))).rejects.toThrow()
    expect(await stack.ledger.committed(buyer, 0n)).toBe(0n)
  })

  test("sealed requests stay at 501 while the flag is off, with copy that says so", async () => {
    const { stack, key, app, host } = await rig()
    stack.flags.sealed = false
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/offpeak-hpke", "x-offpeak-model": MODEL, "x-offpeak-max-tokens": "8", "x-offpeak-sealed-host": host },
      body: new Uint8Array(64),
    })
    expect(res.status).toBe(501)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("not switched on yet")
  })
})
