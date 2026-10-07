import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { keccak256, toBytes, type Hex } from "viem"
import { LiveChain } from "../src/chainview/live.ts"
import { sweepCaptures } from "../src/pay/captures.ts"
import { acceptVoucher, noteChannel, readChannel, reserveChannel } from "../src/pay/channel-store.ts"
import { channelAuthHeader, domain, voucherTypes, type ChannelChain } from "@offpeak/shared"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { bootStack } from "./support/stack.ts"

const buyerKey = roleAccount("buyer")
const chatBody = (content: string, extra: object = {}) => JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content }], max_tokens: 8, ...extra })
const prepaid = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "content-type": "application/json", ...extra })

function openChannel(booted: Awaited<ReturnType<typeof bootStack>>, id: Hex, deposit = 50_000_000n) {
  const row: ChannelChain = {
    payer: booted.buyer as Hex,
    deposit,
    claimed: 0n,
    lastSeq: 0n,
    expiry: BigInt(booted.stack.clock() + 86_400),
    challengeEndsAt: 0n,
    status: 1,
    closeRequested: false,
  }
  booted.indexer.channels.set(id, row)
  return row
}

const usageRows = (booted: Awaited<ReturnType<typeof bootStack>>) =>
  booted.stack.db.query<{ pay_mode: number; price_in: string; tokens_out: number; host_cost_micro: string; fee_micro: string }>("SELECT * FROM shared.usage_records ORDER BY ts")

describe("Window fallback", () => {
  test("a non-holder falling back pays the prepaid price, in a prepaid record", async () => {
    const booted = await bootStack()
    booted.indexer.windows.set("7", { id: 7n, host: booted.host as Hex, modelDigest: booted.modelDigest, t0: 0n, t1: BigInt(booted.stack.clock() + 3600), minTps: 1, units: 10n, hostPricePerUnit: 1n, buyerPricePerUnit: 1n, failed: false } as never)
    const refused = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token, { "x-offpeak-window": "7" }), body: chatBody("window") })
    expect(refused.status).toBe(402)
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token, { "x-offpeak-window": "7", "x-offpeak-window-fallback": "prepaid" }), body: chatBody("window") })
    expect(res.status).toBe(200)
    const rows = await usageRows(booted)
    expect(rows.rows.length).toBe(1)
    expect(rows.rows[0]!.pay_mode).toBe(0)
    expect(BigInt(rows.rows[0]!.price_in)).toBeGreaterThan(0n)
  })
})

describe("channel requests", () => {
  const id = keccak256(toBytes("review-channel"))

  test("a channel id alone spends nothing", async () => {
    const booted = await bootStack()
    openChannel(booted, id)
    const body = chatBody("steal")
    const bare = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id }, body })
    expect(bare.status).toBe(401)
    const wrong = await channelAuthHeader(roleAccount("host"), { channelId: id, ts: booted.stack.clock(), body })
    expect((await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": wrong }, body })).status).toBe(401)
    const stale = await channelAuthHeader(buyerKey, { channelId: id, ts: booted.stack.clock() - 120, body })
    expect((await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": stale }, body })).status).toBe(401)
    const otherBody = await channelAuthHeader(buyerKey, { channelId: id, ts: booted.stack.clock(), body: chatBody("different") })
    expect((await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": otherBody }, body })).status).toBe(401)
    const good = await channelAuthHeader(buyerKey, { channelId: id, ts: booted.stack.clock(), body })
    const send = () => booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": good }, body })
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(401)
  })

  test("a stale voucher from a retry does not fail the request", async () => {
    const booted = await bootStack()
    openChannel(booted, id)
    const body = chatBody("retry")
    const proof = async (text: string) => channelAuthHeader(buyerKey, { channelId: id, ts: booted.stack.clock(), body: text })
    const first = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": await proof(body) }, body })
    const owed = BigInt(first.headers.get("x-offpeak-channel-owed")!)
    const sig = await buyerKey.signTypedData({ domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId: id, seq: 1n, cumulative: owed } })
    const voucher = Buffer.from(JSON.stringify({ seq: "1", cumulative: owed.toString(), sig })).toString("base64url")
    for (const text of [chatBody("one"), chatBody("two")]) {
      const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-voucher": voucher, "x-offpeak-channel-auth": await proof(text) }, body: text })
      expect(res.status).toBe(200)
    }
  })

  test("owed never includes another request's reservation, and a dead request's reservation expires", async () => {
    const booted = await bootStack()
    const row = openChannel(booted, id, 2_000_000n)
    const { db } = booted.stack
    const now = booted.stack.clock()
    const held = await reserveChannel(db, row, id, 100_000n, now)
    const mine = await reserveChannel(db, row, id, 50_000n, now)
    if (!held.ok || !mine.ok) throw new Error("not admitted")
    const owed = await db.transaction((tx) => noteChannel(tx, row.payer, id, mine.reservationId, 7n, "0xaa"))
    expect(owed).toBe(7n)
    expect((await reserveChannel(db, row, id, 150_000n, now)).ok).toBe(false)
    expect((await reserveChannel(db, row, id, 150_000n, now + 901)).ok).toBe(true)
  })

  test("a voucher cannot lower what is owed, and only what it covers leaves pending", async () => {
    const booted = await bootStack()
    const row = openChannel(booted, id)
    const { db } = booted.stack
    const now = booted.stack.clock()
    const serve = async (reqId: string, amount: bigint) => {
      const reserved = await reserveChannel(db, row, id, amount, now)
      if (!reserved.ok) throw new Error("not admitted")
      return db.transaction((tx) => noteChannel(tx, row.payer, id, reserved.reservationId, amount, reqId))
    }
    const low = await serve("0xa", 19n)
    const high = await serve("0xb", 38n)
    const sig = async (seq: bigint, cumulative: bigint) =>
      buyerKey.signTypedData({ domain: domain("OffpeakChannel", booted.stack.channelManager), types: voucherTypes, primaryType: "Voucher", message: { channelId: id, seq, cumulative } })
    expect(await acceptVoucher(db, row, id, { seq: 1n, cumulative: low, sig: await sig(1n, low) })).toBe("ok")
    expect((await readChannel(db, id)).pending).toEqual(["0xb"])
    const covered = await db.query<{ req_ids: string[] }>("SELECT req_ids FROM serving.owed_boundaries WHERE channel_id = $1", [id])
    expect(covered.rows.map((r) => r.req_ids)).toEqual([["0xb"]])
    expect(await acceptVoucher(db, row, id, { seq: 2n, cumulative: high, sig: await sig(2n, high) })).toBe("ok")
    expect(await acceptVoucher(db, row, id, { seq: 3n, cumulative: low, sig: await sig(3n, low) })).toBe("stale")
    expect(await acceptVoucher(db, row, id, { seq: 3n, cumulative: high + 1n, sig: await sig(3n, high + 1n) })).toBe("bad_boundary")
    const paid = await db.query<{ amount_micro: string; req_ids: string[] }>("SELECT amount_micro, req_ids FROM shared.agent_payments WHERE channel_id = $1 ORDER BY voucher_seq", [id])
    expect(paid.rows.map((r) => [BigInt(r.amount_micro), r.req_ids])).toEqual([
      [19n, ["0xa"]],
      [38n, ["0xb"]],
    ])
    expect((await readChannel(db, id)).cumulative).toBe(high)
    await db.query("INSERT INTO serving.owed_boundaries (channel_id, cumulative, req_ids) VALUES ($1,$2,'{0xa}')", [id, low.toString()])
    expect(await acceptVoucher(db, row, id, { seq: 4n, cumulative: low, sig: await sig(4n, low) })).toBe("stale")
  })
})

describe("upto", () => {
  async function payment(booted: Awaited<ReturnType<typeof bootStack>>, reqId: Hex) {
    const { uptoHeader } = await import("./support/upto.ts")
    return uptoHeader(booted.stack, buyerKey, reqId)
  }

  test("a non-streaming reply waits for authorization, and a failure is neither returned nor billed", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 5
    const reqId = keccak256(toBytes("short-fail"))
    booted.facilitator.failReqIds.add(reqId)
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "payment-signature": await payment(booted, reqId) }, body: chatBody("hi") })
    expect(res.status).toBe(402)
    expect(await res.text()).not.toContain("honest")
    expect((await usageRows(booted)).rows.length).toBe(0)
    expect(booted.facilitator.captured.length).toBe(0)
  })

  test("a short stream is not billed when authorization fails", async () => {
    const booted = await bootStack()
    booted.facilitator.delayMs = 5
    const reqId = keccak256(toBytes("short-stream-fail"))
    booted.facilitator.failReqIds.add(reqId)
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "payment-signature": await payment(booted, reqId) }, body: chatBody("hi", { stream: true }) })
    const text = await res.text()
    expect(text).toContain("authorize_failed")
    expect(text).not.toContain("offpeak.usage")
    expect((await usageRows(booted)).rows.length).toBe(0)
  })
})

describe("billing", () => {
  test("a cancelled stream bills what came through", async () => {
    const booted = await bootStack()
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token), body: chatBody("longform", { stream: true, max_tokens: 800 }) })
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    for (let i = 0; i < 100 && (await usageRows(booted)).rows.length === 0; i++) await Bun.sleep(10)
    const rows = await usageRows(booted)
    expect(rows.rows.length).toBe(1)
    expect(rows.rows[0]!.tokens_out).toBeGreaterThan(0)
  })

  test("streamed JSON mode that fails to parse is still billed", async () => {
    const booted = await bootStack()
    const hostApp = new Hono()
    const real = booted.hostApps.get(booted.host)!
    hostApp.post("/offpeak/v1/chat/completions", async (c) => {
      const res = await real.request("/offpeak/v1/chat/completions", { method: "POST", headers: c.req.raw.headers, body: await c.req.text() })
      const text = (await res.text()).replaceAll('{\\"ok\\":true}', "{oops")
      return new Response(text, { headers: { "content-type": "text/event-stream" } })
    })
    hostApp.post("/offpeak/v1/sign", async (c) => real.request("/offpeak/v1/sign", { method: "POST", headers: c.req.raw.headers, body: JSON.stringify({ ...(await c.req.json()), partial: true }) }))
    booted.hostApps.set(booted.host, hostApp)
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token), body: chatBody("json", { stream: true, response_format: { type: "json_object" } }) })
    const text = await res.text()
    expect(text).toContain("bad_json")
    expect(text).toContain("offpeak.usage")
    expect((await usageRows(booted)).rows.length).toBe(1)
  })

  test("the host receives the limit the hold was priced on", async () => {
    const booted = await bootStack()
    let seen: { max_tokens?: number; max_completion_tokens?: number; stream?: boolean } = {}
    const real = booted.hostApps.get(booted.host)!
    const spy = new Hono()
    spy.all("*", async (c) => {
      const raw = c.req.method === "POST" ? await c.req.text() : undefined
      if (c.req.path.endsWith("/chat/completions")) seen = JSON.parse(raw!)
      return real.request(c.req.path, { method: c.req.method, headers: c.req.raw.headers, body: raw })
    })
    booted.hostApps.set(booted.host, spy)
    await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token), body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "x" }], max_tokens: 1, max_completion_tokens: 100_000 }) })
    expect(seen.max_tokens).toBe(4096)
    expect(seen.max_completion_tokens).toBeUndefined()
    const bad = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token), body: chatBody("x", { max_tokens: -5 }) })
    expect(bad.status).toBe(400)
  })

  test("a capture that fails after the record commits is finished by the sweep", async () => {
    const booted = await bootStack()
    const realCapture = booted.stack.ledger.capture.bind(booted.stack.ledger)
    let down = true
    booted.stack.ledger.capture = async (...args) => {
      if (down) throw new Error("redis down")
      return realCapture(...args)
    }
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token), body: chatBody("capture") })
    expect(res.status).toBe(200)
    expect((await usageRows(booted)).rows.length).toBe(1)
    const waiting = () => booted.stack.db.query("SELECT 1 FROM serving.pending_captures")
    expect((await waiting()).rows.length).toBe(1)
    down = false
    await booted.stack.db.query("UPDATE serving.pending_captures SET created_at = now() - interval '1 minute'")
    await sweepCaptures(booted.stack)
    expect((await waiting()).rows.length).toBe(0)
  })
})

describe("edges from the second review", () => {
  test("a multi-byte prompt is held on bytes, so its reply is billed", async () => {
    const booted = await bootStack()
    const body = JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "语".repeat(2000) }], max_tokens: 8, stream: true })
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token), body })
    expect(await res.text()).toContain("offpeak.usage")
    expect((await usageRows(booted)).rows.length).toBe(1)
  })

  test("output past the hold bills what fits, and the record equals the charge", async () => {
    const booted = await bootStack()
    const real = booted.stack.ledger.admit.bind(booted.stack.ledger)
    const captures: bigint[] = []
    booted.stack.ledger.admit = real
    const capture = booted.stack.ledger.capture.bind(booted.stack.ledger)
    booted.stack.ledger.capture = async (wallet, holdId, actual, hour) => {
      captures.push(actual)
      return capture(wallet, holdId, actual, hour)
    }
    const spy = new Hono()
    const host = booted.hostApps.get(booted.host)!
    spy.all("*", async (c) => {
      const raw = c.req.method === "POST" ? await c.req.text() : undefined
      if (!c.req.path.endsWith("/chat/completions")) return host.request(c.req.path, { method: c.req.method, headers: c.req.raw.headers, body: raw })
      const asked = JSON.parse(raw!) as { max_tokens: number }
      return host.request(c.req.path, { method: "POST", headers: c.req.raw.headers, body: JSON.stringify({ ...JSON.parse(raw!), max_tokens: asked.max_tokens * 100 }) })
    })
    booted.hostApps.set(booted.host, spy)
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token), body: chatBody("longform", { max_tokens: 1 }) })
    await res.text()
    const rows = await usageRows(booted)
    expect(rows.rows.length).toBe(1)
    expect(rows.rows[0]!.tokens_out).toBe(1)
    expect(captures[0]).toBe(BigInt(rows.rows[0]!.host_cost_micro) + BigInt(rows.rows[0]!.fee_micro))
  })

  test("work after the commit cannot fail a billed request or release its hold twice", async () => {
    const booted = await bootStack()
    booted.indexer.windows.set("9", { id: 9n, host: booted.host as Hex, modelDigest: booted.modelDigest, t0: 0n, t1: BigInt(booted.stack.clock() + 3600), minTps: 1, units: 10n, hostPricePerUnit: 1n, buyerPricePerUnit: 1n, failed: false } as never)
    booted.indexer.holders.set(`9:${booted.buyer}`, { balance: 10n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 1n })
    await booted.stack.db.exec("ALTER TABLE shared.window_perf RENAME TO window_perf_gone")
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token, { "x-offpeak-window": "9" }), body: chatBody("draw") })
    expect(res.status).toBe(200)
    expect((await usageRows(booted)).rows.length).toBe(1)
  })

  test("a bad price header reserves nothing from a Window", async () => {
    const booted = await bootStack()
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token, { "x-offpeak-window": "9", "x-offpeak-max-price": "nonsense" }), body: chatBody("x") })
    expect(res.status).toBe(400)
  })

  test("exact is refused on chat", async () => {
    const booted = await bootStack()
    const { uptoHeader } = await import("./support/upto.ts")
    const header = JSON.parse(await uptoHeader(booted.stack, buyerKey, keccak256(toBytes("exact-chat"))))
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "payment-signature": JSON.stringify({ ...header, scheme: "exact" }) }, body: chatBody("x") })
    expect(res.status).toBe(400)
  })

  test("a falling-back Window keeps the buyer's audit discount", async () => {
    const booted = await bootStack()
    await booted.stack.db.query("UPDATE serving.accounts SET audit_opt_in = true")
    const { feeBpsFor } = await import("@offpeak/shared")
    const payer = await (await import("../src/pipeline.ts")).auth(booted.stack, new Request("http://router/", { headers: prepaid(booted.key.token, { "x-offpeak-window": "1" }) }))
    expect((payer as { prepaidFeeBps: number }).prepaidFeeBps).toBe(feeBpsFor({ auditOptIn: true }))
  })

  test("content parts are counted, and anything but text is refused", async () => {
    const booted = await bootStack()
    const parts = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token), body: JSON.stringify({ model: "ofm-8b", max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(1000) }] }] }) })
    expect(parts.status).toBe(200)
    expect(((await parts.json()) as { usage: { prompt_tokens: number } }).usage.prompt_tokens).toBeGreaterThan(1000)
    const image = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token), body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: [{ type: "image_url" }] }] }) })
    expect(image.status).toBe(400)
    const nulled = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token), body: chatBody("x", { max_tokens: null }) })
    expect(nulled.status).toBe(200)
  })

  test("one failing capture does not stop the sweep", async () => {
    const booted = await bootStack()
    const { queueCapture } = await import("../src/pay/captures.ts")
    await queueCapture(booted.stack.db, { reqId: "a", kind: "upto", wallet: "0xa", holdId: "0x1", hour: 1, amount: 1n })
    await queueCapture(booted.stack.db, { reqId: "b", kind: "prepaid", wallet: "0xb", holdId: "h", hour: 1, amount: 1n })
    await booted.stack.db.query("UPDATE serving.pending_captures SET created_at = now() - interval '1 minute'")
    booted.stack.facilitator.capture = async () => {
      throw new Error("facilitator down")
    }
    await sweepCaptures(booted.stack)
    const left = await booted.stack.db.query<{ req_id: string }>("SELECT req_id FROM serving.pending_captures")
    expect(left.rows.map((row) => row.req_id)).toEqual(["a"])
  })

  test("embeddings queue their capture too", async () => {
    const booted = await bootStack()
    booted.stack.ledger.capture = async () => {
      throw new Error("redis down")
    }
    const res = await booted.app.request("/v1/embeddings", { method: "POST", headers: prepaid(booted.key.token), body: JSON.stringify({ model: "ofm-embed", input: "hello" }) })
    expect(res.status).toBe(200)
    expect((await booted.stack.db.query("SELECT 1 FROM serving.pending_captures")).rows.length).toBe(1)
  })
})

describe("routing", () => {
  test("an under-bonded active host gets no traffic", async () => {
    const booted = await bootStack()
    booted.indexer.hosts.get(booted.host)!.routable = false
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token), body: chatBody("x") })
    expect(res.status).toBe(503)
  })

  test("an empty stream fails over before billing", async () => {
    const booted = await bootStack({ secondHost: true })
    const empty = new Hono()
    empty.post("/offpeak/v1/chat/completions", () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }))
    const cheapest = booted.host
    booted.hostApps.set(cheapest, empty)
    const res = await booted.app.request("/v1/chat/completions", { method: "POST", headers: prepaid(booted.key.token), body: chatBody("x") })
    expect(res.status).toBe(200)
    expect(res.headers.get("x-offpeak-host")).not.toBe(cheapest)
  })
})

describe("account routes", () => {
  test("disputes and tRPC need a session, and a key needs one too", async () => {
    const booted = await bootStack()
    expect((await booted.app.request("/v1/disputes", { method: "POST", body: JSON.stringify({ wallet: booted.buyer, req_ids: [], reason: "x" }) })).status).toBe(401)
    expect((await booted.app.request("/v1/keys", { method: "POST" })).status).toBe(401)
    expect((await booted.app.request("/trpc/usage.recent")).status).toBe(401)
    await booted.stack.db.query("INSERT INTO serving.siwe_sessions (id, wallet, nonce, expires_at) VALUES ('sess_test', $1, '', to_timestamp($2))", [booted.buyer, booted.stack.clock() + 60])
    const signedIn = { headers: { authorization: "Bearer sess_test" } }
    expect((await booted.app.request("/trpc/usage.recent", signedIn)).status).toBe(200)
    expect((await booted.app.request("/v1/keys", { method: "POST", ...signedIn })).status).toBe(200)
  })

  test("another account cannot read a file", async () => {
    const booted = await bootStack()
    const upload = await booted.app.request("/v1/files", { method: "POST", headers: prepaid(booted.key.token), body: JSON.stringify({ purpose: "batch", content: "secret" }) })
    const { id } = await upload.json()
    const { issueKey } = await import("../src/pipeline.ts")
    const other = await issueKey(booted.stack, "0x000000000000000000000000000000000000dead")
    expect((await booted.app.request(`/v1/files/${id}/content`, { headers: prepaid(other.token) })).status).toBe(404)
  })
})

describe("the live chain view", () => {
  const silent = { url: "http://127.0.0.1:1", token: "t", endpointOf: () => undefined }

  function viewing(buyer: object, extra: Partial<ConstructorParameters<typeof LiveChain>[0]> = {}) {
    const live = new LiveChain({ ...silent, ...extra })
    ;(live as unknown as { get: () => Promise<object> }).get = async () => buyer
    return live
  }

  const clean = { balance: "10", hourlyCap: "5", dailyCap: "5", servable: true, usagePaused: false, withdrawRequestedAt: "0", capsEffectiveAfterHour: "0" }

  test("a withdraw push beats the lagging indexer, and a cancel undoes it", async () => {
    const live = viewing(clean)
    live.push({ type: "WithdrawAllRequested", buyer: "0xAB", requestedAt: "5", dueAt: "9" })
    expect((await live.buyer("0xab", 0)).reason).toBe("withdraw_requested")
    live.push({ type: "WithdrawAllCancelled", buyer: "0xab" })
    expect((await live.buyer("0xab", 0)).servable).toBe(true)
  })

  test("a caps push applies before the indexer has it, and a pause reaches every buyer", async () => {
    const live = viewing(clean)
    live.push({ type: "CapsChangeRequested", buyer: "0xab", hourlyCap: "1", dailyCap: "2", effectiveAfterHour: "99" })
    const lowered = await live.buyer("0xab", 0)
    expect(lowered.pendingHourlyCap).toBe(1n)
    expect(lowered.capsEffectiveAfterHour).toBe(99n)
    live.push({ type: "Paused", usagePaused: true })
    expect((await live.buyer("0xcd", 0)).reason).toBe("paused")
    live.push({ type: "Paused", usagePaused: false })
    expect((await live.buyer("0xcd", 0)).servable).toBe(true)
  })

  test("a reorg drops what a vanished transaction tightened", async () => {
    const live = viewing(clean)
    live.push({ type: "WithdrawAllRequested", buyer: "0xab", requestedAt: "5", dueAt: "9", block: 5 })
    live.push({ type: "Reorg", fromBlock: 1 })
    expect((await live.buyer("0xab", 0)).servable).toBe(true)
  })

  test("only a later block can undo a tightening, and a reorg above it leaves it alone", async () => {
    const live = viewing(clean)
    live.push({ type: "WithdrawAllRequested", buyer: "0xab", requestedAt: "5", dueAt: "9", block: 110 })
    live.push({ type: "WithdrawAllCancelled", buyer: "0xab", block: 100 })
    expect((await live.buyer("0xab", 0)).reason).toBe("withdraw_requested")
    live.push({ type: "Reorg", fromBlock: 120 })
    expect((await live.buyer("0xab", 0)).reason).toBe("withdraw_requested")
    live.push({ type: "WithdrawAllCancelled", buyer: "0xab", block: 111 })
    expect((await live.buyer("0xab", 0)).servable).toBe(true)
  })

  test("a second lowering wins over an older pending change", async () => {
    const live = viewing({ ...clean, pendingHourlyCap: "500", pendingDailyCap: "500", capsEffectiveAfterHour: "7" })
    live.push({ type: "CapsChangeRequested", buyer: "0xab", hourlyCap: "10", dailyCap: "20", effectiveAfterHour: "9", block: 5 })
    const view = await live.buyer("0xab", 0)
    expect(view.pendingHourlyCap).toBe(10n)
    expect(view.capsEffectiveAfterHour).toBe(9n)
  })

  test("a stored endpoint that disagrees with the chain is never routed to", async () => {
    const row = { operator: "0xh", status: 2, models: [], endpointHash: keccak256(toBytes("https://real.example")) }
    const stored: Record<string, string> = { "0xh": "https://evil.example" }
    const live = viewing([row], { endpointOf: (host) => stored[host] })
    expect((await live.hostList())[0]!.endpoint).toBe("")
    stored["0xh"] = "https://real.example"
    live.resync()
    expect((await live.hostList())[0]!.endpoint).toBe("https://real.example")
  })
})

