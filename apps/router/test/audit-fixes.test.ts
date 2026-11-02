import { describe, expect, test } from "bun:test"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { bootStack } from "./support/stack.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const chatBody = (content: string, extra: object = {}) => JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content }], max_tokens: 8, ...extra })
const chat = (booted: Booted, body = chatBody("hello")) => booted.app.request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" }, body })
const records = (booted: Booted) => booted.stack.db.query<{ req_id: string }>("SELECT req_id FROM shared.usage_records")
const flags = async (booted: Booted) => (await booted.stack.db.query<{ reason: string }>("SELECT reason FROM serving.metering_flags")).rows.map((row) => row.reason)

/** Rewrites what the host answers on one path, and leaves the rest alone. */
function rewriteReply(booted: Booted, path: string, rewrite: (body: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const inner = booted.stack.hosts.request
  booted.stack.hosts = {
    request: async (host, endpoint, target, init) => {
      const res = await inner(host, endpoint, target, init)
      if (target !== path || !res.ok) return res
      return Response.json(await rewrite((await res.json()) as Record<string, unknown>))
    },
  }
}

describe("the host's signature on a record", () => {
  test("a signature from another key leaves no record, and the hold goes back", async () => {
    const booted = await bootStack()
    rewriteReply(booted, "/offpeak/v1/sign", async (body) => ({ ...body, hostSig: await roleAccount("settlerB").signMessage({ message: "not a usage record" }) }))
    const res = await chat(booted)
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unbilled")
    expect((await records(booted)).rows.length).toBe(0)
    expect(await flags(booted)).toEqual(["bad_host_sig"])
    expect(await booted.stack.ledger.committed(booted.buyer, 0n)).toBe(0n)
  })

  test("a signature that cannot be read is refused the same way", async () => {
    const booted = await bootStack()
    rewriteReply(booted, "/offpeak/v1/sign", async (body) => ({ ...body, hostSig: "0xjunk" }))
    expect((await chat(booted)).status).toBe(502)
    expect((await records(booted)).rows.length).toBe(0)
    expect(await flags(booted)).toEqual(["bad_host_sig"])
  })

  test("the host's own signature is stored", async () => {
    const booted = await bootStack()
    expect((await chat(booted)).status).toBe(200)
    expect((await records(booted)).rows.length).toBe(1)
    expect(await flags(booted)).toEqual([])
  })
})
