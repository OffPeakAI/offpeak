import { describe, expect, test } from "bun:test"
import { channelAuthHeader, type UsageEnvelope } from "@offpeak/shared"
import { addChannel, ask, bootRouter, buyerAccount, chainView, channelRow, client, costOf, inProcess, until } from "./support.ts"
import { OffpeakError, type ChatResult, type ChatStream } from "../src/index.ts"

const USDG = 1_000_000n
const chatPath = "/v1/chat/completions"

/** Sends every request to the router and lets a test rewrite what comes back. */
function rewriting(app: Parameters<typeof inProcess>[0], rewrite: (res: Response, url: string) => Promise<Response>) {
  const send = inProcess(app)
  return (async (input: RequestInfo | URL, init?: RequestInit) => rewrite(await send(input, init), String(input))) as typeof fetch
}

describe("channel flow against the router", () => {
  test("a chat pays from the channel and its voucher reaches the router", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const op = client(booted)
    await op.channels.attach(id)
    const result = (await op.chat(ask("first call"))) as ChatResult
    expect(result.envelope.record.payMode).toBe(3)
    expect(result.envelope.record.payRef).toBe(id)
    const report = await op.verifyUsage(result.envelope, { payer: buyerAccount.address })
    expect(report.ok).toBe(true)
    expect(await channelRow(booted, id)).toEqual({ seq: 1n, cumulative: costOf(result.envelope) })
    const snapshot = op.channels.snapshot()!
    expect(snapshot.signed).toBe(costOf(result.envelope))
    expect(snapshot.refused).toBeNull()
  })

  test("debt from before an attach waits for you to take it on", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const first = client(booted, { channel: { autoVoucher: false } })
    await first.channels.attach(id)
    const result = (await first.chat(ask("left unvouchered"))) as ChatResult
    expect(await channelRow(booted, id)).toBeNull()
    const later = client(booted)
    const snapshot = await later.channels.attach(id)
    expect(snapshot.signed).toBe(0n)
    expect(snapshot.unsigned).toEqual([costOf(result.envelope)])
    expect(await later.channels.voucher()).toBeNull()
    expect((await later.channels.voucher(costOf(result.envelope)))?.cumulative).toBe(costOf(result.envelope))
    expect(await channelRow(booted, id)).toEqual({ seq: 1n, cumulative: costOf(result.envelope) })
  })

  test("sixty calls, json and streamed, add up to the signed total", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 50n * USDG)
    const op = client(booted)
    await op.channels.attach(id)
    let spent = 0n
    for (let i = 0; i < 60; i++) {
      const params = ask(`call ${i}`)
      let envelope: UsageEnvelope
      if (i % 2 === 0) envelope = ((await op.chat(params)) as ChatResult).envelope
      else {
        const stream = (await op.chat({ ...params, stream: true })) as ChatStream
        let text = ""
        for await (const chunk of stream) text += (chunk as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? ""
        const final = await stream.final()
        envelope = final.envelope
        expect(final.text).toBe(text)
      }
      spent += costOf(envelope)
      expect(await channelRow(booted, id)).toEqual({ seq: BigInt(i + 1), cumulative: spent })
    }
    const payments = await booted.stack.db.query<{ amount_micro: string }>("SELECT amount_micro FROM shared.agent_payments WHERE kind = 'channel'")
    expect(payments.rows.length).toBe(60)
    expect(payments.rows.reduce((sum, row) => sum + BigInt(row.amount_micro), 0n)).toBe(spent)
    const view = await (await booted.app.request(`/v1/channels/${id}`)).json()
    expect(view.owed).toBe(spent.toString())
  })

  test("the openai client pays the same way and sees only chat chunks", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const op = client(booted)
    await op.channels.attach(id)
    const done = await op.openai.chat.completions.create(ask("through openai"))
    expect(done.choices[0]?.message.content).toBeTruthy()
    const stream = await op.openai.chat.completions.create({ ...ask("streamed through openai"), stream: true })
    const ids: string[] = []
    for await (const chunk of stream) {
      expect(Array.isArray(chunk.choices)).toBe(true)
      ids.push(chunk.id)
    }
    const streamed = op.usageRecord(ids[0]!)!
    expect(streamed.record.payMode).toBe(3)
    expect((await op.verifyUsage(streamed)).ok).toBe(true)
    const first = op.usageRecord(done.id)!
    expect(await channelRow(booted, id)).toEqual({ seq: 2n, cumulative: costOf(first) + costOf(streamed) })
  })

  test("a request that fails after a successful one leaves the books as they were", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const op = client(booted)
    await op.channels.attach(id)
    const first = (await op.chat(ask("fine"))) as ChatResult
    await expect(op.chat({ model: "no-such-model", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "model_not_found", status: 404 })
    const second = (await op.chat(ask("fine again"))) as ChatResult
    expect(await channelRow(booted, id)).toEqual({ seq: 2n, cumulative: costOf(first.envelope) + costOf(second.envelope) })
  })

  test("parallel calls finish out of order and still settle on one voucher total", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 50n * USDG)
    const op = client(booted)
    await op.channels.attach(id)
    const results = (await Promise.all(Array.from({ length: 8 }, (_, i) => op.chat(ask(`parallel ${i}`))))) as ChatResult[]
    const spent = results.reduce((sum, row) => sum + costOf(row.envelope), 0n)
    await op.channels.voucher()
    expect((await channelRow(booted, id))?.cumulative).toBe(spent)
    expect(op.channels.snapshot()?.refused).toBeNull()
  })

  test("a voucher that could not be posted goes with the next request", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    let dropVoucher = true
    const send = inProcess(booted.app)
    const op = client(booted, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/voucher") && dropVoucher) throw new Error("connection lost")
        return send(input, init)
      }) as typeof fetch,
    })
    await op.channels.attach(id)
    const first = (await op.chat(ask("voucher lost"))) as ChatResult
    expect(await channelRow(booted, id)).toBeNull()
    dropVoucher = false
    const second = (await op.chat(ask("voucher rides along"))) as ChatResult
    const row = await channelRow(booted, id)
    expect(row?.cumulative).toBe(costOf(first.envelope) + costOf(second.envelope))
    expect(row?.seq).toBe(2n)
  })

  test("a client that also holds an API key does not send it on channel calls", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const seen: Headers[] = []
    const send = inProcess(booted.app)
    const op = client(booted, {
      apiKey: booted.key.token,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers))
        return send(input, init)
      }) as typeof fetch,
    })
    await op.channels.attach(id)
    await op.chat(ask("channel, not key"))
    await op.openai.chat.completions.create(ask("openai, not key"))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.some((headers) => headers.has("authorization"))).toBe(false)
  })

  test("attaching over a channel in use is refused, so nothing unsent is lost", async () => {
    const booted = await bootRouter()
    const op = client(booted)
    await op.channels.attach(addChannel(booted, 5n * USDG))
    await expect(op.channels.attach(addChannel(booted, 5n * USDG))).rejects.toMatchObject({ code: "channel_active" })
  })

  test("a restarted client picks up the sequence", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const before = client(booted)
    await before.channels.attach(id)
    const first = (await before.chat(ask("before restart"))) as ChatResult
    const { seq, signed } = before.channels.snapshot()!
    const after = client(booted)
    await after.channels.attach(id, { seq, cumulative: signed })
    const second = (await after.chat(ask("after restart"))) as ChatResult
    expect(await channelRow(booted, id)).toEqual({ seq: 2n, cumulative: costOf(first.envelope) + costOf(second.envelope) })
  })
})

describe("payer proof on every request", () => {
  test("each request signs a fresh nonce over its own body", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const seen: { auth: string; body: string }[] = []
    const send = inProcess(booted.app)
    const op = client(booted, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("x-offpeak-channel-auth")
        if (String(input).endsWith(chatPath)) {
          expect(auth).toBeTruthy()
          seen.push({ auth: auth!, body: String(init?.body) })
        }
        return send(input, init)
      }) as typeof fetch,
    })
    await op.channels.attach(id)
    await op.chat(ask("same words"))
    await op.chat(ask("same words"))
    expect(seen.length).toBe(2)
    const proofs = seen.map((row) => JSON.parse(Buffer.from(row.auth, "base64url").toString()) as { ts: number; nonce: string; sig: string })
    expect(proofs[0]!.nonce).not.toBe(proofs[1]!.nonce)
    expect(proofs[0]!.sig).not.toBe(proofs[1]!.sig)
    const replay = (auth: string, body: string) =>
      booted.app.request(chatPath, { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": auth }, body })
    const replayed = await replay(seen[0]!.auth, seen[0]!.body)
    expect(replayed.status).toBe(401)
    expect(((await replayed.json()) as { error: { code: string } }).error.code).toBe("bad_channel_auth")
  })
