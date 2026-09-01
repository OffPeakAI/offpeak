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
