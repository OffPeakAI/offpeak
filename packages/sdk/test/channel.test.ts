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

  test("the router refuses a proof with the wrong body, an old time, or another signer", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const body = JSON.stringify(ask("real body"))
    const post = async (auth: string, sent = body) =>
      (await booted.app.request(chatPath, { method: "POST", headers: { "content-type": "application/json", "x-offpeak-channel": id, "x-offpeak-channel-auth": auth }, body: sent })).status
    const now = booted.stack.clock()
    expect(await post(await channelAuthHeader(buyerAccount, { channelId: id, ts: now, body }), JSON.stringify(ask("other body")))).toBe(401)
    expect(await post(await channelAuthHeader(buyerAccount, { channelId: id, ts: now - 120, body }))).toBe(401)
    const { roleAccount } = await import("../../shared/src/test-keys.ts")
    expect(await post(await channelAuthHeader(roleAccount("host"), { channelId: id, ts: now, body }))).toBe(401)
    expect(await post(await channelAuthHeader(buyerAccount, { channelId: id, ts: now, body }))).toBe(200)
  })

  test("a wallet that does not own the channel is refused", async () => {
    const booted = await bootRouter()
    const { roleAccount } = await import("../../shared/src/test-keys.ts")
    const id = addChannel(booted, 5n * USDG, roleAccount("host").address)
    const op = client(booted)
    await expect(op.channels.attach(id)).rejects.toMatchObject({ code: "not_your_channel" })
    const bare = client(booted, { publicClient: { readContract: async () => ({ ...booted.indexer.channels.get(id)!, payer: buyerAccount.address }) } as never })
    await bare.channels.attach(id)
    await expect(bare.chat(ask("not mine"))).rejects.toMatchObject({ code: "bad_channel_auth", status: 401 })
    expect(await channelRow(booted, id)).toBeNull()
  })
})

describe("spend limits", () => {
  test("a client that stops signing is stopped at the credit limit, and a voucher lets it carry on", async () => {
    const booted = await bootRouter()
    const deposit = 2_000n
    const limit = deposit / 10n
    const id = addChannel(booted, deposit)
    const op = client(booted, { channel: { autoVoucher: false } })
    await op.channels.attach(id)
    let spent = 0n
    let stopped: OffpeakError | null = null
    for (let i = 0; i < 500 && !stopped; i++) {
      try {
        spent += costOf(((await op.chat(ask(`unsigned ${i}`))) as ChatResult).envelope)
      } catch (err) {
        stopped = err as OffpeakError
      }
    }
    expect(stopped?.code).toBe("credit_limit")
    expect(stopped?.status).toBe(402)
    expect(spent).toBeGreaterThan(0n)
    expect(spent).toBeLessThanOrEqual(limit)
    expect(await channelRow(booted, id)).toBeNull()
    const receipt = await op.channels.voucher()
    expect(receipt?.cumulative).toBe(spent)
    expect(receipt?.delivered).toBe(true)
    expect((await channelRow(booted, id))?.cumulative).toBe(spent)
    const resumed = (await op.chat(ask("signed again"))) as ChatResult
    expect(resumed.envelope.record.payMode).toBe(3)
  }, 30_000)

  test("spend stops at the deposit with vouchers flowing", async () => {
    const booted = await bootRouter()
    const deposit = 200n
    const id = addChannel(booted, deposit)
    const op = client(booted)
    await op.channels.attach(id)
    let spent = 0n
    let stopped: OffpeakError | null = null
    for (let i = 0; i < 200 && !stopped; i++) {
      try {
        spent += costOf(((await op.chat(ask(`spend ${i}`))) as ChatResult).envelope)
      } catch (err) {
        stopped = err as OffpeakError
      }
    }
    expect(stopped?.code).toBe("deposit_exhausted")
    expect(spent).toBeLessThanOrEqual(deposit)
    expect((await channelRow(booted, id))?.cumulative).toBe(spent)
  }, 30_000)

  test("a closing channel takes no new requests", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const op = client(booted)
    await op.channels.attach(id)
    await op.chat(ask("before close"))
    booted.indexer.emit({ type: "CloseRequested", channelId: id, challengeEndsAt: booted.stack.clock() + 7200 })
    await expect(op.chat(ask("after close"))).rejects.toMatchObject({ code: "channel_not_open", status: 402 })
  })
})

describe("the client does not sign on the router's word", () => {
  /** A router that claims a debt nobody can check, and notes every voucher it is sent. */
  function claiming(app: Parameters<typeof inProcess>[0], id: string, claim: { owed?: bigint; cumulative?: bigint; deposit?: bigint }) {
    const vouchers: bigint[] = []
    const send = inProcess(app)
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/voucher")) vouchers.push(BigInt(JSON.parse(String(init?.body)).cumulative))
      const res = await send(input, init)
      const owed = res.headers.get("x-offpeak-channel-owed")
      if (owed && claim.owed) {
        const headers = new Headers(res.headers)
        headers.set("x-offpeak-channel-owed", String(BigInt(owed) + claim.owed))
        return new Response(res.body, { status: res.status, headers })
      }
      if (!url.endsWith(`/v1/channels/${id}`)) return res
      const view = (await res.json()) as Record<string, unknown>
      return Response.json({ ...view, ...Object.fromEntries(Object.entries(claim).map(([key, value]) => [key, String(value)])) })
    }) as typeof fetch
    return { vouchers, fetcher }
  }

  test("a claimed debt from before the attach gets no voucher, even after a failed request", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 600n * USDG)
    const { vouchers, fetcher } = claiming(booted.app, id, { owed: 500n * USDG })
    const op = client(booted, { fetch: fetcher })
    const snapshot = await op.channels.attach(id)
    expect(snapshot.signed).toBe(0n)
    expect(snapshot.verified).toBe(0n)
    expect(snapshot.unsigned).toEqual([500n * USDG])
    await expect(op.chat({ model: "no-such-model", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "model_not_found" })
    await op.chat(ask("a real one"))
    expect(vouchers).toEqual([])
    expect(op.channels.snapshot()?.signed).toBe(0n)
    expect(op.channels.snapshot()?.refused).toContain("above")
  })

  test("a claimed cumulative is not a starting point either", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 600n * USDG)
    const { vouchers, fetcher } = claiming(booted.app, id, { cumulative: 500n * USDG })
    const op = client(booted, { fetch: fetcher })
    expect((await op.channels.attach(id)).signed).toBe(0n)
    await op.chat(ask("a real one"))
    expect(vouchers).toHaveLength(1)
    expect(vouchers[0]!).toBeLessThan(USDG)
  })

  test("the deposit and expiry come from the chain, not the router", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const { fetcher } = claiming(booted.app, id, { deposit: 900n * USDG })
    const op = client(booted, { fetch: fetcher })
    expect((await op.channels.attach(id)).deposit).toBe(5n * USDG)
  })

  test("what you say you signed still counts", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 600n * USDG)
    const { fetcher } = claiming(booted.app, id, { owed: 500n * USDG })
    const op = client(booted, { fetch: fetcher })
    expect((await op.channels.attach(id, { seq: 7n, cumulative: 500n * USDG })).signed).toBe(500n * USDG)
  })

  test("attaching with no chain access is refused rather than taking the router's word", async () => {
    const booted = await bootRouter()
    await expect(client(booted, { publicClient: undefined }).channels.attach(addChannel(booted, USDG))).rejects.toMatchObject({ code: "no_rpc" })
  })

  test("a record from a host the registry never heard of pays for nothing", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const chain = chainView(booted)
    const op = client(booted, {
      publicClient: { readContract: (args: { functionName: string }) => (args.functionName === "channelView" ? chain.readContract(args as never) : args.functionName === "hostView" ? Promise.resolve({ status: 0 }) : Promise.resolve([])) } as never,
    })
    await op.channels.attach(id)
    const result = (await op.chat(ask("from an invented host"))) as ChatResult
    expect(op.channels.snapshot()?.signed).toBe(0n)
    expect(op.channels.snapshot()?.refused).toContain("host_not_registered")
    expect(await channelRow(booted, id)).toBeNull()
    const report = await op.verifyUsage(result.envelope)
    expect(report).toMatchObject({ ok: false, hostRegistered: false, hostOk: true })
    expect(report.reasons).toEqual(["host_not_registered"])
  })

  test("a host registered without this model does not pass", async () => {
    const booted = await bootRouter()
    const chain = chainView(booted)
    const op = client(booted, {
      apiKey: booted.key.token,
      publicClient: { readContract: (args: { functionName: string }) => (args.functionName === "modelsOf" ? Promise.resolve([`0x${"12".repeat(32)}`]) : chain.readContract(args as never)) } as never,
    })
    const result = (await op.chat(ask("another model"))) as ChatResult
    expect((await op.verifyUsage(result.envelope)).reasons).toEqual(["host_not_registered"])
  })

  test("an RPC that cannot answer is not a pass", async () => {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token, publicClient: { readContract: () => Promise.reject(new Error("rpc down")) } as never })
    const result = (await op.chat(ask("rpc down"))) as ChatResult
    expect((await op.verifyUsage(result.envelope)).reasons).toEqual(["registry_unreadable"])
  })

  test("with no RPC the report says the registry went unchecked", async () => {
    const booted = await bootRouter()
    const op = client(booted, { apiKey: booted.key.token, publicClient: undefined })
    const result = (await op.chat(ask("no rpc"))) as ChatResult
    expect(await op.verifyUsage(result.envelope)).toMatchObject({ ok: true, notChecked: ["host_registry"] })
  })

  describe("max price", () => {
    const cap = { inPerM: 1n, outPerM: 1n }

    /** A router that drops the cap, so the record comes back above it. */
    function ignoringCap(app: Parameters<typeof inProcess>[0]) {
      const send = inProcess(app)
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        headers.delete("x-offpeak-max-price")
        return send(input, { ...init, headers })
      }) as typeof fetch
    }

    test("a record above the cap fails the call, and names the request to dispute", async () => {
      const booted = await bootRouter()
      const op = client(booted, { apiKey: booted.key.token, fetch: ignoringCap(booted.app) })
      await expect(op.chat(ask("over the cap"), { maxPrice: cap })).rejects.toMatchObject({ code: "over_max_price" })
      expect(op.recentUsage()).toHaveLength(1)
    })

    test("a stream above the cap fails when it ends", async () => {
      const booted = await bootRouter()
      const op = client(booted, { apiKey: booted.key.token, fetch: ignoringCap(booted.app) })
      const stream = (await op.chat({ ...ask("over the cap"), stream: true }, { maxPrice: cap })) as ChatStream
      await expect(stream.final()).rejects.toMatchObject({ code: "over_max_price" })
    })

    test("a record above the cap gets no voucher", async () => {
      const booted = await bootRouter()
      const id = addChannel(booted, 5n * USDG)
      const op = client(booted, { fetch: ignoringCap(booted.app) })
      await op.channels.attach(id)
      await expect(op.chat(ask("over the cap"), { maxPrice: cap })).rejects.toMatchObject({ code: "over_max_price" })
      expect(op.channels.snapshot()?.signed).toBe(0n)
      expect(op.channels.snapshot()?.refused).toContain("max price")
      expect(await channelRow(booted, id)).toBeNull()
    })

    test("a record at the cap passes, whatever its rounding", async () => {
      const booted = await bootRouter()
      const op = client(booted, { apiKey: booted.key.token })
      const plain = (await op.chat(ask("find the price"))) as ChatResult
      const { priceIn, priceOut } = plain.envelope.record
      const atCap = { inPerM: (priceIn * 104n + 99n) / 100n, outPerM: (priceOut * 104n + 99n) / 100n }
      expect(((await op.chat(ask("at the cap"), { maxPrice: atCap })) as ChatResult).envelope.record.payMode).toBe(0)
      expect((await op.verifyUsage(plain.envelope, { maxPrice: atCap })).maxPriceOk).toBe(true)
      expect((await op.verifyUsage(plain.envelope, { maxPrice: cap })).reasons).toContain("max_price")
    })
  })

  test("an owed figure above the usage records gets no voucher", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const op = client(booted, {
      fetch: rewriting(booted.app, async (res, url) => {
        if (!url.endsWith(chatPath) || !res.ok) return res
        const headers = new Headers(res.headers)
        headers.set("x-offpeak-channel-owed", (BigInt(headers.get("x-offpeak-channel-owed")!) + 500_000n).toString())
        return new Response(res.body, { status: res.status, headers })
      }),
    })
    await op.channels.attach(id)
    await op.chat(ask("inflated"))
    const snapshot = op.channels.snapshot()!
    expect(snapshot.signed).toBe(0n)
    expect(snapshot.refused).toContain("above")
    expect(await channelRow(booted, id)).toBeNull()
  })

  test("a record that fails verification gets no voucher", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const op = client(booted, {
      fetch: rewriting(booted.app, async (res, url) => {
        if (!url.endsWith(chatPath) || !res.ok) return res
        const body = (await res.json()) as { offpeak_usage: { record: { feeMicro: string } } }
        body.offpeak_usage.record.feeMicro = (BigInt(body.offpeak_usage.record.feeMicro) + 1n).toString()
        return Response.json(body, { status: res.status, headers: res.headers })
      }),
    })
    await op.channels.attach(id)
    await op.chat(ask("forged"))
    const snapshot = op.channels.snapshot()!
    expect(snapshot.signed).toBe(0n)
    expect(snapshot.refused).toContain("Usage record failed")
    expect(await channelRow(booted, id)).toBeNull()
  })

  test("one record cannot pay for two responses", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    let kept: unknown = null
    const op = client(booted, {
      fetch: rewriting(booted.app, async (res, url) => {
        if (!url.endsWith(chatPath) || !res.ok) return res
        const body = (await res.json()) as { offpeak_usage: unknown }
        kept ??= body.offpeak_usage
        return Response.json({ ...body, offpeak_usage: kept }, { status: res.status, headers: res.headers })
      }),
    })
    await op.channels.attach(id)
    const first = (await op.chat(ask("once"))) as ChatResult
    await op.chat(ask("twice"))
    const snapshot = op.channels.snapshot()!
    expect(snapshot.signed).toBe(costOf(first.envelope))
    expect(snapshot.refused).toContain("reported twice")
  })

  test("a record from outside the channel cannot pay for it", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const prepaid = client(booted, { apiKey: booted.key.token })
    const outside = (await prepaid.chat(ask("prepaid"))) as ChatResult
    const op = client(booted, {
      fetch: rewriting(booted.app, async (res, url) => {
        if (!url.endsWith(chatPath) || !res.ok) return res
        const body = (await res.json()) as Record<string, unknown>
        return Response.json({ ...body, offpeak_usage: (outside.completion as { offpeak_usage: unknown }).offpeak_usage }, { status: res.status, headers: res.headers })
      }),
    })
    await op.channels.attach(id)
    await op.chat(ask("swapped"))
    expect(op.channels.snapshot()?.signed).toBe(0n)
  })

  test("a record for another buyer cannot pay for it", async () => {
    const booted = await bootRouter()
    const { roleAccount } = await import("../../shared/src/test-keys.ts")
    const other = roleAccount("host")
    const theirs = addChannel(booted, 5n * USDG, other.address)
    const mine = addChannel(booted, 5n * USDG)
    const stranger = client(booted, { wallet: other })
    await stranger.channels.attach(theirs)
    const foreign = (await stranger.chat(ask("not yours"))) as ChatResult
    const op = client(booted, {
      fetch: rewriting(booted.app, async (res, url) => {
        if (!url.endsWith(chatPath) || !res.ok) return res
        const body = (await res.json()) as Record<string, unknown>
        return Response.json({ ...body, offpeak_usage: (foreign.completion as { offpeak_usage: unknown }).offpeak_usage }, { status: res.status, headers: res.headers })
      }),
    })
    await op.channels.attach(mine)
    await op.chat(ask("swapped wallet"))
    const snapshot = op.channels.snapshot()!
    expect(snapshot.signed).toBe(0n)
    expect(snapshot.refused).toContain("buyer_ref")
  })

  test("a stopped stream is billed without a record, and only you can accept that figure", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const op = client(booted)
    await op.channels.attach(id)
    const stream = (await op.chat({ ...ask("longform please", 300), stream: true })) as ChatStream
    for await (const _ of stream) break
    await until(async () => {
      const view = await (await booted.app.request(`/v1/channels/${id}`)).json()
      return BigInt(view.owed) > 0n
    }, "the partial bill")
    const next = (await op.chat(ask("after the stop"))) as ChatResult
    const snapshot = op.channels.snapshot()!
    expect(snapshot.signed).toBe(0n)
    expect(snapshot.refused).toContain("above")
    const owed = snapshot.unsigned[0]!
    expect(owed).toBeGreaterThan(costOf(next.envelope))
    const receipt = await op.channels.voucher(owed)
    expect(receipt?.delivered).toBe(true)
    expect((await channelRow(booted, id))?.cumulative).toBe(owed)
    expect(op.channels.snapshot()?.refused).toBeNull()
    await op.chat(ask("signing again"))
    expect(op.channels.snapshot()?.signed).toBeGreaterThan(owed)
  })

  test("the router refuses a voucher that is not on a boundary it reported", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const op = client(booted)
    await op.channels.attach(id)
    const first = (await op.chat(ask("boundary"))) as ChatResult
    const verified = op.channels.snapshot()!.verified
    await expect(op.channels.voucher(costOf(first.envelope) + 500_000n)).rejects.toMatchObject({ code: "bad_voucher" })
    const snapshot = op.channels.snapshot()!
    expect(snapshot.signed).toBe(costOf(first.envelope))
    expect(snapshot.refused).toContain("refused")
    expect(snapshot.verified).toBe(verified)
    expect(snapshot.unsigned).toEqual([])
  })

  test("a refused voucher does not block the next request or leave headroom for the router", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    let inflate = false
    const op = client(booted, {
      fetch: rewriting(booted.app, async (res, url) => {
        if (!inflate || !url.endsWith(chatPath) || !res.ok) return res
        const headers = new Headers(res.headers)
        headers.set("x-offpeak-channel-owed", (BigInt(headers.get("x-offpeak-channel-owed")!) + 400_000n).toString())
        return new Response(res.body, { status: res.status, headers })
      }),
    })
    await op.channels.attach(id)
    const first = (await op.chat(ask("boundary"))) as ChatResult
    await expect(op.channels.voucher(costOf(first.envelope) + 500_000n)).rejects.toMatchObject({ code: "bad_voucher" })
    const second = (await op.chat(ask("still served"))) as ChatResult
    const spent = costOf(first.envelope) + costOf(second.envelope)
    expect(await channelRow(booted, id)).toMatchObject({ cumulative: spent })
    inflate = true
    await op.chat(ask("inflated after a refusal"))
    expect(op.channels.snapshot()?.signed).toBe(spent)
  })

  test("a voucher past the deposit is never signed", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 2n * USDG)
    const op = client(booted)
    await op.channels.attach(id)
    await expect(op.channels.voucher(2n * USDG + 1n)).rejects.toMatchObject({ code: "bad_voucher" })
    expect(op.channels.snapshot()?.seq).toBe(0n)
  })
})

describe("setup errors", () => {
  test("a channel needs a wallet", async () => {
    const booted = await bootRouter()
    const op = client(booted, { wallet: undefined, apiKey: booted.key.token })
    await expect(op.channels.attach(addChannel(booted, USDG))).rejects.toMatchObject({ code: "no_wallet" })
  })

  test("nothing is signed against an unpublished deployment", async () => {
    const booted = await bootRouter()
    const op = client(booted, { deployment: "4663" })
    await expect(op.channels.attach(addChannel(booted, USDG))).rejects.toMatchObject({ code: "not_deployed" })
  })

  test("a channel with no status open cannot be attached", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, USDG)
    booted.indexer.channels.get(id)!.status = 2
    await expect(client(booted).channels.attach(id)).rejects.toMatchObject({ code: "channel_not_open" })
  })
})
