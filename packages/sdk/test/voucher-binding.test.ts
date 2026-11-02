import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buyerRefOf, domain, feeMicro, hostChatBody, hostCostMicro, leafFor, loadModelTokenizer, manifestDigest, outputHashOf, outputLimit, promptHashOf, readManifest, recordToMessage, serializeEnvelope, signTyped, usageTypes, type Hex, type UsageRecord } from "../../shared/src/index.ts"
import { roleAccount } from "../../shared/src/test-keys.ts"
import { fileChannelStore, type ChatResult, type ChatStream } from "../src/index.ts"
import { addChannel, ask, bootRouter, buyerAccount, channelRow, client, costOf, inProcess, type Booted } from "./support.ts"

const USDG = 1_000_000n
const dir = mkdtempSync(join(tmpdir(), "offpeak-vouchers-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Reply = { envelope: unknown; owed: bigint; text?: string; toolCalls?: unknown[] }

/** A router that answers chats with whatever `reply` gives it, while the rest goes to the real one. */
function compromised(booted: Booted, reply: () => Reply, stream = false) {
  const send = inProcess(booted.app)
  const vouchers: { seq: string; cumulative: string }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/v1/chat/completions")) {
      const { envelope, owed, text = "hi", toolCalls } = reply()
      if (!stream) return Response.json({ id: "x", choices: [{ message: { content: text, tool_calls: toolCalls }, finish_reason: "stop" }], offpeak_usage: envelope }, { headers: { "x-offpeak-channel-owed": owed.toString() } })
      const deltas = (toolCalls ?? []).map((call, index) => ({ index, ...(call as object) }))
      const sse = [`data: ${JSON.stringify({ id: "x", choices: [{ delta: { content: text, tool_calls: deltas }, finish_reason: "stop" }] })}\n\n`, `event: offpeak.channel\ndata: ${JSON.stringify({ owed: owed.toString() })}\n\n`, `event: offpeak.usage\ndata: ${JSON.stringify(envelope)}\n\n`, "data: [DONE]\n\n"]
      return new Response(sse.join(""), { headers: { "content-type": "text/event-stream" } })
    }
    if (url.endsWith("/voucher")) {
      vouchers.push(JSON.parse(String(init!.body)))
      return Response.json({ ok: true })
    }
    return send(input, init)
  }) as typeof fetch
  return { fetcher, vouchers }
}

const hashesFor = (body: Record<string, unknown>, text: string, toolCalls: unknown[] = []) => ({ promptHash: promptHashOf(hostChatBody(body, outputLimit(body.max_tokens))), outputHash: outputHashOf(text, toolCalls) })

/** A record both a router key and a registered host key signed, so only its contents can give it away. */
async function forged(booted: Booted, id: Hex, over: Partial<UsageRecord>, signer: Parameters<typeof signTyped>[0] = roleAccount("host") as never) {
  const reqId = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as Hex
  const [priceIn, priceOut] = [104_000n, 416_000n]
  const tokensOut = over.tokensOut ?? 2
  const host = hostCostMicro(10, tokensOut, priceIn, priceOut)
  const record: UsageRecord = { reqId, buyerRef: buyerRefOf(buyerAccount.address, reqId), host: booted.host as Hex, modelDigest: booted.modelDigest, tokensIn: 10, tokensOut, promptHash: `0x${"11".repeat(32)}`, outputHash: `0x${"22".repeat(32)}`, priceIn, priceOut, hostCostMicro: host, feeMicro: feeMicro(host, 400), payMode: 3, payRef: id, ts: booted.stack.clock(), sheetHash: booted.stack.sheets[0]!.sheetHash as Hex, ...over }
  const typed = { domain: domain("OffpeakUsage", booted.stack.usageLedger), types: usageTypes, primaryType: "UsageRecord" as const, message: recordToMessage(record) as never }
  const routerSig = await signTyped(booted.stack.router, typed)
  const hostSig = await signTyped(signer, typed)
  return { env: serializeEnvelope({ v: 1, record, routerSig, hostSig, leaf: leafFor(record, routerSig, hostSig), hostCounts: { tokensIn: 10, tokensOut }, sealed: false, proofUrl: "/x" }), total: record.hostCostMicro + record.feeMicro }
}

async function run(booted: Booted, id: Hex, body: ReturnType<typeof ask>, over: Partial<UsageRecord>) {
  const { env, total } = await forged(booted, id, over)
  const { fetcher, vouchers } = compromised(booted, () => ({ envelope: env, owed: total }))
  const op = client(booted, { fetch: fetcher })
  await op.channels.attach(id)
  await op.chat(body)
  await Bun.sleep(20)
  return { vouchers, snapshot: op.channels.snapshot()!, total }
}

describe("a voucher answers one request", () => {
  test("a record for a prompt nobody sent gets no voucher, whatever its signatures", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const { vouchers, snapshot } = await run(booted, id, ask("short question", 8), { tokensOut: 11_000_000 })
    expect(vouchers).toEqual([])
    expect(snapshot.refused).toContain("prompt_hash")
    expect(snapshot.signed).toBe(0n)
  })

  test("a record for an output that never arrived gets no voucher", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const body = ask("short question", 8)
    const { vouchers, snapshot } = await run(booted, id, body, { promptHash: hashesFor(body, "hi").promptHash })
    expect(vouchers).toEqual([])
    expect(snapshot.refused).toContain("output_hash")
  })

  test("a record past max_tokens gets no voucher, with both hashes right", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const body = ask("short question", 8)
    const { vouchers, snapshot } = await run(booted, id, body, { ...hashesFor(body, "hi"), tokensOut: 11_000_000 })
    expect(vouchers).toEqual([])
    expect(snapshot.refused).toContain("11000000 output tokens on a limit of 8")
  })

  test("a record dated before the request gets no voucher", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const body = ask("short question", 8)
    const { vouchers, snapshot } = await run(booted, id, body, { ...hashesFor(body, "hi"), ts: booted.stack.clock() - 3_600 })
    expect(vouchers).toEqual([])
    expect(snapshot.refused).toContain("dated outside")
  })

  test("a record dated after the request gets no voucher", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const body = ask("short question", 8)
    const { vouchers, snapshot } = await run(booted, id, body, { ...hashesFor(body, "hi"), ts: booted.stack.clock() + 3_600 })
    expect(vouchers).toEqual([])
    expect(snapshot.refused).toContain("dated outside")
  })

  test("a record that holds up all the way gets its voucher", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const body = ask("short question", 8)
    const { vouchers, snapshot, total } = await run(booted, id, body, hashesFor(body, "hi"))
    expect(snapshot.refused).toBeNull()
    expect(BigInt(vouchers.at(-1)!.cumulative)).toBe(total)
  })

  test("a streamed record is held to the text and tool calls that came down the stream", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const body = ask("use a tool", 8)
    const toolCalls = [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }]
    const good = await forged(booted, id, hashesFor(body, "hi", toolCalls))
    const { fetcher, vouchers } = compromised(booted, () => ({ envelope: good.env, owed: good.total, toolCalls }), true)
    const op = client(booted, { fetch: fetcher })
    await op.channels.attach(id)
    await ((await op.chat({ ...body, stream: true })) as ChatStream).final()
    await Bun.sleep(20)
    expect(op.channels.snapshot()!.refused).toBeNull()
    expect(BigInt(vouchers.at(-1)!.cumulative)).toBe(good.total)
  })

  test("a record cannot claim the sealed flag to skip the recount", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const { env, total } = await forged(booted, id, {})
    const { fetcher, vouchers } = compromised(booted, () => ({ envelope: { ...env, sealed: true }, owed: total }))
    const op = client(booted, { fetch: fetcher })
    await op.channels.attach(id)
    await op.chat(ask("short question", 8))
    await Bun.sleep(20)
    expect(vouchers).toEqual([])
    expect(op.channels.snapshot()!.refused).toContain("recount_sealed")
  })

  test("a record the registered host did not sign gets no voucher", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const body = ask("short question", 8)
    const { env, total } = await forged(booted, id, hashesFor(body, "hi"), roleAccount("buyer") as never)
    const { fetcher, vouchers } = compromised(booted, () => ({ envelope: env, owed: total }))
    const op = client(booted, { fetch: fetcher })
    await op.channels.attach(id)
    await op.chat(body)
    await Bun.sleep(20)
    expect(vouchers).toEqual([])
    expect(op.channels.snapshot()!.refused).toContain("host_sig")
    expect(await channelRow(booted, id)).toBeNull()
  })

  test("real calls on a real router still pay, json and streamed", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const op = client(booted)
    await op.channels.attach(id)
    const first = (await op.chat(ask("one"))) as ChatResult
    const second = await ((await op.chat({ ...ask("two"), stream: true })) as ChatStream).final()
    await Bun.sleep(20)
    expect(op.channels.snapshot()!.refused).toBeNull()
    expect(await channelRow(booted, id)).toEqual({ seq: 2n, cumulative: costOf(first.envelope) + costOf(second.envelope) })
  })
})

describe("a router that withholds the tokenizer", () => {
  const TOKENS_IN = 40_000_000
  /** Signed by router and host, hashes right, one output token, and 40M input tokens on a 2-word question. */
  async function withheld(booted: Booted, id: Hex, body: ReturnType<typeof ask>, tokensIn: number) {
    const host = hostCostMicro(tokensIn, 1, 104_000n, 416_000n)
    const { env, total } = await forged(booted, id, { ...hashesFor(body, "hi"), tokensIn, tokensOut: 1, hostCostMicro: host, feeMicro: feeMicro(host, 400) })
    const { fetcher, vouchers } = compromised(booted, () => ({ envelope: env, owed: total }))
    const blind = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/v1/tokenizers/") ? Response.json({ context_length: 8192, tokenizer: null }) : fetcher(input, init))) as typeof fetch
    return { blind, vouchers, total }
  }

  async function paid(payUncounted: boolean, tokensIn: number) {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const body = ask("short question", 8)
    const { blind, vouchers, total } = await withheld(booted, id, body, tokensIn)
    const op = client(booted, { fetch: blind, channel: { payUncounted } })
    await op.channels.attach(id)
    await op.chat(body, { maxPrice: { inPerM: 200_000n, outPerM: 800_000n } })
    await Bun.sleep(20)
    return { vouchers, total, refused: op.channels.snapshot()!.refused }
  }

  test("gets no voucher for the 4.33 USDG forgery", async () => {
    const { vouchers, total, refused } = await paid(false, TOKENS_IN)
    expect(total).toBeGreaterThan(4n * USDG)
    expect(vouchers).toEqual([])
    expect(refused).toContain("token_count_not_checked")
  })

  test("gets no voucher for an honest record either, unless the caller opts out", async () => {
    const { vouchers, refused } = await paid(false, 10)
    expect(vouchers).toEqual([])
    expect(refused).toContain("token_count_not_checked")
  })

  test("an honest record pays with no opt-out once the tokenizer is published", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const dir = new URL("../../shared/fixtures/tokenizers/qwen2.5-0.5b-instruct/", import.meta.url).pathname
    const manifest = readManifest(`${dir}manifest.json`)
    const modelDigest = manifestDigest(manifest) as Hex
    booted.indexer.hosts.get(booted.host.toLowerCase() as Hex)!.models.push({ digest: modelDigest } as never)
    const files = Object.fromEntries(["tokenizer.json", "tokenizer_config.json"].map((path) => [path, readFileSync(join(dir, path), "utf8")]))
    const body = ask("short question", 8)
    const tokensIn = loadModelTokenizer(manifest, dir).countChat(body as never)
    const host = hostCostMicro(tokensIn, 1, 104_000n, 416_000n)
    const { env, total } = await forged(booted, id, { ...hashesFor(body, "hi"), modelDigest, tokensIn, tokensOut: 1, hostCostMicro: host, feeMicro: feeMicro(host, 400) })
    const { fetcher, vouchers } = compromised(booted, () => ({ envelope: env, owed: total }))
    const published = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/v1/tokenizers/") ? Response.json({ context_length: 8192, tokenizer: { ...manifest, files } }) : fetcher(input, init))) as typeof fetch
    const op = client(booted, { fetch: published, channel: { payUncounted: false } })
    await op.channels.attach(id)
    await op.chat(body)
    await Bun.sleep(20)
    expect(op.channels.snapshot()!.refused).toBeNull()
    expect(BigInt(vouchers.at(-1)!.cumulative)).toBe(total)
  })

  test("the opt-out still pays an honest record", async () => {
    const { vouchers, total, refused } = await paid(true, 10)
    expect(refused).toBeNull()
    expect(BigInt(vouchers.at(-1)!.cumulative)).toBe(total)
  })

  test("the opt-out does not pay for more than the body could hold", async () => {
    const { vouchers, refused } = await paid(true, TOKENS_IN)
    expect(vouchers).toEqual([])
    expect(refused).toContain(`${TOKENS_IN} input tokens`)
  })
})

describe("a record is paid for once", () => {
  const replayed = async (booted: Booted, id: Hex, path: string) => {
    const store = fileChannelStore(path)
    const before = client(booted, { channel: { id, store } })
    await before.channels.attach(id)
    const body = ask("the same question", 8)
    const real = (await before.chat(body)) as ChatResult
    const cost = costOf(real.envelope)
    const raw = serializeEnvelope(real.envelope)
    const { fetcher, vouchers } = compromised(booted, () => ({ envelope: raw, owed: 2n * cost, text: real.text! }))
    const after = client(booted, { fetch: fetcher, channel: { id, store: fileChannelStore(path) } })
    await after.chat(body)
    await Bun.sleep(20)
    return { after, vouchers, real }
  }

  test("after a restart the same record, on the same body, is refused", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const { after, vouchers } = await replayed(booted, id, join(dir, "replay.json"))
    expect(vouchers).toEqual([])
    expect(after.channels.snapshot()!.refused).toContain("reported twice")
  })

  test("the ids are on disk", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    const path = join(dir, "ids.json")
    const { real } = await replayed(booted, id, path)
    expect(JSON.parse(readFileSync(path, "utf8")).counted).toEqual([real.envelope.record.reqId])
  })

  test("inside one process the replay is refused", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5n * USDG)
    let raw: unknown = null
    let owed = 0n
    let text = ""
    const live = inProcess(booted.app)
    const vouchers: unknown[] = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (raw && String(input).endsWith("/v1/chat/completions")) return Response.json({ id: "x", choices: [{ message: { content: text }, finish_reason: "stop" }], offpeak_usage: raw }, { headers: { "x-offpeak-channel-owed": owed.toString() } })
      if (String(input).endsWith("/voucher")) vouchers.push(init!.body)
      return live(input, init)
    }) as typeof fetch
    const op = client(booted, { fetch: fetcher })
    await op.channels.attach(id)
    const body = ask("a real call")
    const real = (await op.chat(body)) as ChatResult
    const before = vouchers.length
    raw = serializeEnvelope(real.envelope)
    owed = 2n * costOf(real.envelope)
    text = real.text!
    await op.chat(body)
    await Bun.sleep(20)
    expect(vouchers.length).toBe(before)
    expect(op.channels.snapshot()!.refused).toContain("reported twice")
  })
})
