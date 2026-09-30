import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { join } from "node:path"
import { Hono } from "hono"
import { channelAuthHeader, domain, hourIndex, manifestDigest, promptHashOf, readManifest, voucherTypes, type ChannelChain } from "@offpeak/shared"
import { hashTypedData, keccak256, toBytes, type Hex } from "viem"
import { openSample, type SampleRow } from "../../auditor/src/sample.ts"
import * as sample from "../../auditor/src/sample.ts"
import { sheetFromJson, sheetToJson, sheetTypedData } from "../../host-agent/src/sheets.ts"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { sameSecret } from "../src/http.ts"
import { loadTokenizers } from "../src/metering/tokenize.ts"
import { dueNightSlots, runBatch } from "../src/openai/batches.ts"
import { RedisCounters, rebuildSpend } from "../src/pay/redis-holds.ts"
import { WindowPerf, sweepWindows } from "../src/pay/window-perf.ts"
import { pendingKey } from "../src/pay/window.ts"
import { bootStack } from "./support/stack.ts"
import { uptoHeader } from "./support/upto.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const buyerKey = roleAccount("buyer")
const WINDOW = "7"
const MINUTE = 60

const prepaid = (booted: Booted, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${booted.key.token}`, "content-type": "application/json", ...extra })
const chatBody = (content: string, extra: object = {}) => JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content }], max_tokens: 8, ...extra })
const chat = (booted: Booted, body: string, headers: Record<string, string> = prepaid(booted)) => booted.app.request("/v1/chat/completions", { method: "POST", headers, body })
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code
const records = (booted: Booted) => booted.stack.db.query<{ req_id: string; tokens_in: number; tokens_out: number; prompt_hash: Hex; price_in: string }>("SELECT req_id, tokens_in, tokens_out, prompt_hash, price_in FROM shared.usage_records")
const flags = async (booted: Booted) => (await booted.stack.db.query<{ reason: string }>("SELECT reason FROM serving.metering_flags")).rows.map((row) => row.reason)
const held = (booted: Booted) => booted.stack.ledger.committed(booted.buyer, 0n)

/** Numbers `JSON.parse` turns into Infinity, which `JSON.stringify` then sends on as null. */
const overflowing = (extra = '"x":1e999') => `{"model":"ofm-8b","messages":[{"role":"user","content":"hi"}],"max_tokens":8,"stream":true,${extra}}`

/** Stands in front of the real host. `chat` answers its chat route, and it counts the requests that got there. */
function wrapHost(booted: Booted, chatRoute: (c: { req: { raw: Request } }) => Response | Promise<Response>) {
  const real = booted.hostApps.get(booted.host)!
  const seen = { chats: 0 }
  const app = new Hono()
  app.post("/offpeak/v1/chat/completions", (c) => {
    seen.chats += 1
    return chatRoute(c)
  })
  app.all("*", async (c) => real.request(c.req.path, { method: c.req.method, headers: c.req.raw.headers, body: c.req.method === "POST" ? await c.req.text() : undefined }))
  booted.hostApps.set(booted.host, app)
  return seen
}

const refusing = (booted: Booted, status: number) => wrapHost(booted, () => Response.json({ error: { message: "no", type: "invalid_request", code: "bad_request" } }, { status }))

/** Counts chats, and passes them on to the real host. */
function countChats(booted: Booted) {
  const real = booted.hostApps.get(booted.host)!
  return wrapHost(booted, async (c) => real.request("/offpeak/v1/chat/completions", { method: "POST", headers: c.req.raw.headers, body: await c.req.raw.text() }))
}

function holdWindow(booted: Booted) {
  const now = booted.stack.clock()
  booted.indexer.windows.set(WINDOW, { id: 7n, host: booted.host as Hex, modelDigest: booted.modelDigest, t0: BigInt(now - 10), t1: BigInt(now + 7200), minTps: 1, units: 10n, hostPricePerUnit: 1n, buyerPricePerUnit: 1n, failed: false } as never)
  booted.indexer.holders.set(`7:${booted.buyer}`, { balance: 10n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 1n })
}

const pending = (booted: Booted) => booted.stack.counters.get(pendingKey(7n, booted.buyer, hourIndex(booted.stack.clock())))
const demandedMinutes = async (booted: Booted) => (await booted.stack.db.query("SELECT 1 FROM shared.window_perf WHERE demanded")).rows.length

async function sweepPast(booted: Booted) {
  for (let i = 0; i < 3; i++) {
    booted.stack.setClock(booted.stack.clock() + MINUTE)
    await sweepWindows(booted.stack)
  }
}

function openChannel(booted: Booted, id: Hex, deposit = 50_000_000n) {
  const row: ChannelChain = { payer: booted.buyer as Hex, deposit, claimed: 0n, lastSeq: 0n, expiry: BigInt(booted.stack.clock() + 86_400), challengeEndsAt: 0n, status: 1, closeRequested: false }
  booted.indexer.channels.set(id, row)
  return row
}

const channelChat = async (booted: Booted, id: Hex, body: string) =>
  chat(booted, body, { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": await channelAuthHeader(buyerKey, { channelId: id, ts: booted.stack.clock(), body }) })

const uptoChat = async (booted: Booted, seed: string, body: string) => chat(booted, body, { "content-type": "application/json", "payment-signature": await uptoHeader(booted.stack, buyerKey, keccak256(toBytes(seed))) })

afterEach(() => {
  mock.restore()
})

describe("a body that cannot be hashed", () => {
  test("is refused before payment in every pay mode, so no host serves it", async () => {
    const booted = await bootStack()
    const seen = countChats(booted)
    const verify = spyOn(booted.stack.facilitator, "verify")
    holdWindow(booted)
    const channel = keccak256(toBytes("free-stream"))
    openChannel(booted, channel)
    const body = overflowing()
    const answers = [
      await chat(booted, body),
      await chat(booted, body, prepaid(booted, { "x-offpeak-window": WINDOW })),
      await channelChat(booted, channel, body),
      await uptoChat(booted, "free-stream", body),
    ]
    for (const res of answers) {
      expect(res.status).toBe(400)
      expect(await errorCode(res)).toBe("bad_body")
    }
    expect(seen.chats).toBe(0)
    expect(verify).not.toHaveBeenCalled()
    expect(await held(booted)).toBe(0n)
    expect(await pending(booted)).toBe(0n)
    expect((await booted.stack.db.query("SELECT 1 FROM serving.channel_reservations")).rows.length).toBe(0)
  })

  test("is refused wherever the number sits, and the same reply goes out for one a template cannot render", async () => {
    const booted = await bootStack()
    expect((await chat(booted, overflowing('"tools":[{"type":"function","function":{"name":"f","parameters":{"max":-1e999}}}]'))).status).toBe(400)
    const manifestPath = join(import.meta.dir, "../../../packages/shared/fixtures/tokenizers/qwen2.5-0.5b-instruct/manifest.json")
    const digest = manifestDigest(readManifest(manifestPath))
    const real = await bootStack({ modelDigest: digest })
    loadTokenizers([{ name: "ofm-8b", digest, tokenizer: { manifest: manifestPath, dir: join(manifestPath, "..") } }], false)
    const seen = countChats(real)
    const res = await chat(real, JSON.stringify({ model: "ofm-8b", max_tokens: 8, stream: true, messages: [{ role: "assistant", content: "x", tool_calls: [null] }] }))
    expect(res.status).toBe(400)
    expect(seen.chats).toBe(0)
  })
})

describe("a bill that throws after the host served", () => {
  test("keeps the hold, flags the request and says it went unbilled", async () => {
    const booted = await bootStack()
    const realRequest = booted.stack.hosts.request
    booted.stack.hosts.request = async (host, endpoint, path, init) => {
      if (path === "/offpeak/v1/sign") throw new Error("link down")
      return realRequest(host, endpoint, path, init)
    }
    const text = await (await chat(booted, chatBody("hello", { stream: true }))).text()
    expect(text).toContain("unbilled")
    expect((await records(booted)).rows.length).toBe(0)
    expect(await flags(booted)).toEqual(["bill_failed"])
    expect(await held(booted)).toBeGreaterThan(0n)
  })

  test("a host that refuses to sign still releases, as 3.4 has it", async () => {
    const booted = await bootStack()
    const real = booted.hostApps.get(booted.host)!
    const refuser = new Hono()
    refuser.post("/offpeak/v1/sign", (c) => c.json({ refused: true, reason: "counts", hostCounts: {} }, 409))
    refuser.all("*", async (c) => real.request(c.req.path, { method: c.req.method, headers: c.req.raw.headers, body: await c.req.text() }))
    booted.hostApps.set(booted.host, refuser)
    expect(await (await chat(booted, chatBody("hello", { stream: true }))).text()).toContain("unbilled")
    expect(await held(booted)).toBe(0n)
    expect(await flags(booted)).toEqual(["counts"])
  })
})

describe("host health", () => {
  test("a message with no role is refused at the door", async () => {
    const booted = await bootStack()
    const seen = countChats(booted)
    for (const message of [{ content: "hi" }, { role: "wizard", content: "hi" }, { role: 5, content: "hi" }, null]) {
      const res = await chat(booted, JSON.stringify({ model: "ofm-8b", messages: [message] }))
      expect(res.status).toBe(400)
      expect(await errorCode(res)).toBe("bad_messages")
    }
    expect(seen.chats).toBe(0)
  })
