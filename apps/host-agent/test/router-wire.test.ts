import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LAUNCH_TOKENIZER, countChat, countInputs, countOutput, countText, parseRecord, recordToMessage, recoverTyped, domain, renderChat, usageTypes, type Hex } from "@offpeak/shared"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { Offpeak, type ChatResult } from "../../../packages/sdk/src/index.ts"
import { loadTokenizers } from "../../router/src/metering/tokenize.ts"
import { openDispute } from "../../router/src/offpeak/disputes.ts"
import { resignedOverbill } from "../../router/test/support/overbill.ts"
import { bootStack } from "../../router/test/support/stack.ts"
import { run, type CliDeps } from "../src/cli.ts"
import { EngineWatch } from "../src/health.ts"
import type { AgentTokenizer } from "../src/meter.ts"
import { createAgentApp } from "../src/proxy.ts"
import { SheetBook } from "../src/sheets.ts"
import { SignedLog } from "../src/signed-log.ts"
import { serveOnFreePort, startFakeVllm, type FakeReply } from "./support/fake-vllm.ts"
import { DIGEST, MODEL, fixtureDir, hostFolder, tokenizer } from "./support/harness.ts"

/** A model with no tokenizer on the router counts bytes on both sides, as the mock engine does. */
const byteTokenizer: AgentTokenizer = {
  render: (body) => renderChat(body.messages ?? [], body.tools),
  encode: (text) => Array.from({ length: countText(LAUNCH_TOKENIZER, text) }, (_, id) => id),
  decodeToken: (id) => String(id),
  countChat: (body) => countChat(LAUNCH_TOKENIZER, body.messages ?? [], body.tools),
  countOutput: (text, toolCalls) => countOutput(LAUNCH_TOKENIZER, text, toolCalls),
  countInputs: (inputs) => countInputs(LAUNCH_TOKENIZER, inputs),
}

const REPLY = "Served by the real agent."

let stops: (() => void)[] = []

async function wired(opts: { reply?: () => FakeReply; hold?: Promise<void>; tokenizer?: AgentTokenizer; modelDigest?: Hex } = {}) {
  const boot = await bootStack({ modelDigest: opts.modelDigest })
  const { stack } = boot
  const dataDir = mkdtempSync(join(tmpdir(), "offpeak-wire-"))
  const engine = startFakeVllm({ name: "ofm-8b", tokenizer: opts.tokenizer ?? byteTokenizer, reply: opts.reply ?? (() => ({ text: REPLY })), hold: opts.hold })
  stops.push(() => {
    engine.stop()
    rmSync(dataDir, { recursive: true, force: true })
  })
  const sheets = new SheetBook(join(dataDir, "sheets"), boot.host, stack.registry)
  const row = stack.sheets[0]!
  await sheets.save(row, row.sig)
  await sheets.load()
  const log = new SignedLog(join(dataDir, "signed"))
  await log.open()
  const model = { digest: boot.modelDigest, engine: engine.url, tokenizer: opts.tokenizer ?? byteTokenizer, nightJobs: false }
  const agent = createAgentApp({
    operator: roleAccount("host") as never,
    routerAddress: stack.router.address,
    usageLedger: stack.usageLedger,
    sheets,
    log,
    clock: stack.clock,
    imageDigest: boot.imageDigest,
    gpuClass: "h100-80g-sxm",
    models: [
      { ...model, name: "ofm-8b" },
      { ...model, name: "ofm-embed" },
    ],
    integrity: { failed: null },
    engines: new EngineWatch([{ name: "ofm-8b", engine: engine.url, vllmArgs: [] }]),
    auditor: null,
  })
  const { server, port } = serveOnFreePort((free) => Bun.serve({ port: free, hostname: "127.0.0.1", idleTimeout: 0, fetch: agent.fetch }))
  stops.push(() => server.stop(true))
  stack.hosts = { request: (_host, _endpoint, path, init) => fetch(`http://127.0.0.1:${port}${path}`, init as RequestInit) }
  const call = (path: string, body: unknown) =>
    boot.app.request(path, { method: "POST", headers: { authorization: `Bearer ${boot.key.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
  return { ...boot, engine, call }
}

const usageEvent = (text: string) => JSON.parse(/event: offpeak\.usage\ndata: (.+)/.exec(text)![1]!)

afterEach(() => {
  for (const stop of stops) stop()
  stops = []
})

describe("the real router against the real agent", () => {
  test("a stream ends in a record both sides signed", async () => {
    const { call, stack, engine, host } = await wired()
    const res = await call("/v1/chat/completions", { model: "ofm-8b", stream: true, messages: [{ role: "user", content: "hello agent" }] })
    const text = await res.text()
    expect(res.status).toBe(200)
    const envelope = usageEvent(text)
    const record = parseRecord(envelope.record)
    const typed = { domain: domain("OffpeakUsage", stack.usageLedger), types: usageTypes, primaryType: "UsageRecord" as const, message: recordToMessage(record) as never }
    expect((await recoverTyped(typed, envelope.hostSig as Hex)).toLowerCase()).toBe(host)
    expect(envelope.hostCounts).toEqual({ tokensIn: record.tokensIn, tokensOut: record.tokensOut })
    expect(engine.requests[0]!.body.stream_options).toEqual({ include_usage: true })
    expect((await stack.db.query("SELECT req_id FROM shared.usage_records")).rows).toHaveLength(1)
    expect((await stack.db.query("SELECT req_id FROM serving.metering_flags")).rows).toHaveLength(0)
  })

  test("a plain request bills the same way", async () => {
    const { call, stack } = await wired()
    const res = await call("/v1/chat/completions", { model: "ofm-8b", messages: [{ role: "user", content: "hello agent" }] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: { message: { content: string } }[]; offpeak_usage: { hostSig: string } }
    expect(body.choices[0]!.message.content).toBe(REPLY)
    expect(body.offpeak_usage.hostSig).toMatch(/^0x/)
    expect((await stack.db.query("SELECT req_id FROM shared.usage_records")).rows).toHaveLength(1)
  })

  test("tool calls cross the wire and meter alike", async () => {
    const toolCalls = [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"1"}' } }]
    const { call, stack } = await wired({ reply: () => ({ text: "", toolCalls }) })
    const res = await call("/v1/chat/completions", { model: "ofm-8b", stream: true, tools: [{ type: "function", function: { name: "lookup" } }], messages: [{ role: "user", content: "use a tool" }] })
    const envelope = usageEvent(await res.text())
    expect(envelope.hostCounts.tokensOut).toBe(parseRecord(envelope.record).tokensOut)
    expect((await stack.db.query("SELECT req_id FROM serving.metering_flags")).rows).toHaveLength(0)
  })

  test("a host that counts differently refuses, and the buyer is not billed", async () => {
    const tokenizer = { ...byteTokenizer, countOutput: (text: string, toolCalls?: unknown[] | null) => byteTokenizer.countOutput(text, toolCalls) + 50 }
    const { call, stack } = await wired({ tokenizer })
    const res = await call("/v1/chat/completions", { model: "ofm-8b", stream: true, messages: [{ role: "user", content: "hello agent" }] })
    const text = await res.text()
    expect(text).toContain("unbilled")
    expect(text).not.toContain("offpeak.usage")
    expect((await stack.db.query("SELECT req_id FROM shared.usage_records")).rows).toHaveLength(0)
    const flags = await stack.db.query<{ reason: string; host_counts: { tokensOut: number } }>("SELECT reason, host_counts FROM serving.metering_flags")
    expect(flags.rows[0]!.reason).toBe("counts")
    expect(flags.rows[0]!.host_counts.tokensOut).toBeGreaterThan(50)
  })

  test("a buyer who hangs up is billed for what went out, under the partial rule", async () => {
    const { call, stack, engine } = await wired({ hold: new Promise<void>(() => {}), reply: () => ({ text: "first piece of a long reply that never finishes" }) })
    const res = await call("/v1/chat/completions", { model: "ofm-8b", stream: true, messages: [{ role: "user", content: "hello agent" }] })
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    for (let i = 0; i < 200 && engine.state.cancelled === 0; i++) await Bun.sleep(5)
    expect(engine.state.cancelled).toBe(1)
    let rows: { tokens_out: number }[] = []
    for (let i = 0; i < 200 && rows.length === 0; i++) {
      rows = (await stack.db.query<{ tokens_out: number }>("SELECT tokens_out FROM shared.usage_records")).rows
      await Bun.sleep(5)
    }
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.tokens_out)).toBe(countText(LAUNCH_TOKENIZER, "first"))
    expect((await stack.db.query("SELECT req_id FROM serving.metering_flags")).rows).toHaveLength(0)
  })

  test("embeddings are signed with a zero output price", async () => {
    const { call, stack } = await wired()
    const res = await call("/v1/embeddings", { model: "ofm-embed", input: ["one", "two"] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown[]; offpeak_usage: { hostCounts: { tokensOut: number } } }
    expect(body.data).toHaveLength(2)
    expect(body.offpeak_usage.hostCounts.tokensOut).toBe(0)
    expect((await stack.db.query("SELECT req_id FROM shared.usage_records")).rows).toHaveLength(1)
  })
})

describe("with the model's real tokenizer on both sides", () => {
  loadTokenizers([{ name: "ofm-8b", digest: DIGEST, tokenizer: { manifest: `${fixtureDir}manifest.json`, dir: fixtureDir } }], false)
  const real = () => wired({ modelDigest: DIGEST, tokenizer })
  const prompt = { model: "ofm-8b", messages: [{ role: "user", content: "How many tokens is this sentence?" }] }

  test("a stream is signed on the same counts, end token included", async () => {
    const { call, stack } = await real()
    const res = await call("/v1/chat/completions", { ...prompt, stream: true })
    const envelope = usageEvent(await res.text())
    expect(envelope.record.tokensIn).toBe(tokenizer.countChat(prompt as never))
    expect(envelope.record.tokensOut).toBe(tokenizer.countOutput(REPLY, undefined, "stop"))
    expect(envelope.record.tokensOut).toBe(tokenizer.countText(REPLY) + 1)
    expect(envelope.hostCounts).toEqual({ tokensIn: envelope.record.tokensIn, tokensOut: envelope.record.tokensOut })
    expect((await stack.db.query("SELECT req_id FROM serving.metering_flags")).rows).toHaveLength(0)
  })

  test("a reply cut at max_tokens has no end token on either side", async () => {
    const { call } = await wired({ modelDigest: DIGEST, tokenizer, reply: () => ({ text: REPLY, finish: "length" }) })
    const res = await call("/v1/chat/completions", { ...prompt, stream: true })
    const envelope = usageEvent(await res.text())
    expect(envelope.record.tokensOut).toBe(tokenizer.countText(REPLY))
    expect(envelope.hostCounts.tokensOut).toBe(tokenizer.countText(REPLY))
  })

  test("embeddings and a tool call count alike on both sides", async () => {
    const toolCalls = [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"1"}' } }]
    const { call, stack } = await wired({ modelDigest: DIGEST, tokenizer, reply: () => ({ text: "", toolCalls }) })
    const tools = await call("/v1/chat/completions", { ...prompt, stream: true, tools: [{ type: "function", function: { name: "lookup", parameters: {} } }] })
    expect(usageEvent(await tools.text()).hostCounts.tokensOut).toBeGreaterThan(0)
    const embedded = await call("/v1/embeddings", { model: "ofm-embed", input: ["one two three"] })
    const { offpeak_usage: usage } = (await embedded.json()) as { offpeak_usage: { record: { tokensIn: number }; hostCounts: { tokensIn: number } } }
    expect(usage.record.tokensIn).toBe(tokenizer.countInputs(["one two three"]))
    expect(usage.hostCounts.tokensIn).toBe(usage.record.tokensIn)
    expect((await stack.db.query("SELECT req_id FROM serving.metering_flags")).rows).toHaveLength(0)
  })

  test("a router that counted bytes against a real host gets no signature", async () => {
    const { call, stack } = await wired({ tokenizer })
    const res = await call("/v1/chat/completions", { ...prompt, stream: true })
    expect(await res.text()).toContain("unbilled")
    const flags = await stack.db.query<{ reason: string }>("SELECT reason FROM serving.metering_flags")
    expect(flags.rows[0]!.reason).toBe("counts")
  })

  test("a buyer recounts through the SDK with the tokenizer the router publishes", async () => {
    const boot = await real()
    const res = await boot.app.request(`/v1/tokenizers/${DIGEST}`)
    expect(((await res.json()) as { context_length: number }).context_length).toBe(8192)
    const op = new Offpeak({ baseURL: "http://router.test", deployment: "local", apiKey: boot.key.token, fetch: ((input: RequestInfo | URL, init?: RequestInit) => boot.app.fetch(new Request(input, init))) as typeof fetch })
    const result = (await op.chat(prompt)) as ChatResult
    const report = await op.verifyUsage(result.envelope, { recount: { prompt, output: { text: result.text!, finish: result.finishReason } } })
    expect(report.reasons).toEqual([])
    expect(report.recount).toMatchObject({ tokenizer: "model", tokensIn: result.envelope.record.tokensIn, tokensOut: result.envelope.record.tokensOut })
  })

  test("the SDK refuses tokenizer files that do not match the record's model", async () => {
    const boot = await real()
    const tampered = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/v1/tokenizers/")
        ? boot.app
            .fetch(new Request(input, init))
            .then((res) => res.json() as Promise<{ context_length: number; tokenizer: { files: Record<string, string> } }>)
            .then((reply) => Response.json({ ...reply, tokenizer: { ...reply.tokenizer, files: { ...reply.tokenizer.files, "tokenizer_config.json": "{}" } } }))
        : boot.app.fetch(new Request(input, init))) as typeof fetch
    const op = new Offpeak({ baseURL: "http://router.test", deployment: "local", apiKey: boot.key.token, fetch: tampered })
    const result = (await op.chat(prompt)) as ChatResult
    await expect(op.verifyUsage(result.envelope, { recount: { prompt, output: result.text! } })).rejects.toMatchObject({ code: "bad_tokenizer" })
  })

  test("a dispute recounts with the same tokenizer, and refunds what the record overbilled", async () => {
    const boot = await real()
    const res = await boot.call("/v1/chat/completions", prompt)
    const { offpeak_usage: usage, choices } = (await res.json()) as { offpeak_usage: { record: { reqId: string } }; choices: { message: { content: string }; finish_reason: string }[] }
    const opened = await openDispute(boot.stack, boot.buyer, { req_ids: [usage.record.reqId], reason: "recount", material: { prompt, output: choices[0]!.message.content, finish: choices[0]!.finish_reason } })
    expect(opened).toMatchObject({ outcome: "rejected", checks: [{ reasons: [] }] })
    // Under the byte count, so only the model's own tokenizer can see the overbill.
    await resignedOverbill(boot, usage.record.reqId, tokenizer.countText(REPLY) + 12)
    const recounted = await openDispute(boot.stack, boot.buyer, { req_ids: [usage.record.reqId], reason: "recount", material: { prompt, output: choices[0]!.message.content, finish: choices[0]!.finish_reason } })
    expect(recounted).toMatchObject({ outcome: "upheld", checks: [{ reasons: ["tokens_overcounted"] }] })
  })
})

describe("offpeak-host against the real router", () => {
  async function routerOnPort(boot: Awaited<ReturnType<typeof bootStack>>) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const port = 36_000 + Math.floor(Math.random() * 1000)
      try {
        const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: boot.app.fetch })
        stops.push(() => server.stop(true))
        return port
      } catch (err) {
        if ((err as { code?: string }).code !== "EADDRINUSE") throw err
      }
    }
    throw new Error("no free port in 36000-36999")
  }

  test("price-sheet set signs, posts and lands, and the router's refusal reaches the host", async () => {
    const boot = await bootStack()
    const port = await routerOnPort(boot)
    const folder = hostFolder({ modelLines: ['    vllmArgs: ["--max-model-len=8192", "--dtype=auto"]'] })
    stops.push(() => rmSync(folder.root, { recursive: true, force: true }))
    const lines: string[] = []
    const deps = { env: { ...folder.env, OFFPEAK_PUBLIC_BASE_URL: `http://127.0.0.1:${port}` }, print: (line: string) => lines.push(line), clock: boot.stack.clock } as unknown as CliDeps
    const file = join(folder.root, "sheet.json")
    const write = (nonce: number) => writeFileSync(file, JSON.stringify({ model: MODEL, baseIn: Array(168).fill(200_000), baseOut: Array(168).fill("800000"), floorIn: 100_000, floorOut: "400000", validFrom: boot.stack.clock() + 7200, nonce }))
    write(2)
    await run(["price-sheet", "set", "--file", file], deps)
    expect(lines.at(-1)).toContain("in force from")
    const stored = await boot.stack.db.query<{ host: string; model_digest: string }>("SELECT host, model_digest FROM serving.price_sheets")
    expect(stored.rows).toEqual([{ host: boot.host, model_digest: folder.digest }])
    expect(boot.stack.sheets.at(-1)!.nonce).toBe(2n)
    expect(boot.stack.sheets.at(-1)!.baseIn[0]).toBe(200_000n)
    await expect(run(["price-sheet", "set", "--file", file], deps)).rejects.toThrow("nonce_not_increasing")
  })
})
