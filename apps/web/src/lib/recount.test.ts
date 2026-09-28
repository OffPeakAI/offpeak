import { describe, expect, test } from "bun:test"
import { hostChatBody, outputHashOf, promptHashOf, type UsageRecordJson } from "@offpeak/shared"
import { readFileSync } from "node:fs"
import { readMaterial, recount, recountLines, type Published } from "./recount.ts"

const dir = new URL("../../../../packages/shared/fixtures/tokenizers/qwen2.5-0.5b-instruct/", import.meta.url).pathname
const manifest = JSON.parse(readFileSync(`${dir}manifest.json`, "utf8"))
const files = { "tokenizer.json": readFileSync(`${dir}tokenizer.json`, "utf8"), "tokenizer_config.json": readFileSync(`${dir}tokenizer_config.json`, "utf8") }
const digest = "0x9599ee65e52af1a4254555c5d515ea86484eff63776402469bc1c640636875c9"

const body = { model: "qwen", messages: [{ role: "user", content: "How many tokens is this?" }], max_tokens: 32 }
const output = "Not very many."
const published: Published = { context_length: 8192, tokenizer: { ...manifest, files } }

const record = (over: Partial<UsageRecordJson> = {}) =>
  ({ modelDigest: digest, promptHash: promptHashOf(hostChatBody(body, 32)), outputHash: outputHashOf(output, []), tokensIn: 34, tokensOut: 5, ...over }) as UsageRecordJson

describe("recount in the browser", () => {
  test("a pasted body and output recount to the record with the model's tokenizer", async () => {
    const report = await recount(record(), { prompt: body, output, finish: "stop" }, async () => published)
    expect(report).toMatchObject({ promptOk: true, outputOk: true, countsOk: true, tokenizer: "model" })
    expect(recountLines(report, record()).map((line) => line.tone)).toEqual(["ok", "ok", "ok"])
  })

  test("a record billing past the count fails that line", async () => {
    const billed = record({ tokensIn: 5_000 })
    const report = await recount(billed, { prompt: body, output, finish: "stop" }, async () => published)
    expect(report.countsOk).toBe(false)
    expect(recountLines(report, billed)[2]).toMatchObject({ label: "Tokens", tone: "fail" })
  })

  test("a tokenizer that does not hash to the record's model is refused", async () => {
    const tampered = { ...published, tokenizer: { ...manifest, files: { ...files, "tokenizer_config.json": "{}" } } }
    await expect(recount(record(), { prompt: body, output }, async () => tampered)).rejects.toThrow("does not match its pinned hash")
    await expect(recount(record({ modelDigest: `0x${"12".repeat(32)}` }), { prompt: body, output }, async () => published)).rejects.toThrow("does not match the model digest")
  })

  test("with no tokenizer published it says the counts were not checked", async () => {
    const report = await recount(record(), { prompt: body, output }, async () => ({ context_length: 8192, tokenizer: null }))
    expect(report.tokenizer).toBe("none")
    expect(report.countsOk).toBeNull()
    const tokens = recountLines(report, { tokensIn: 40, tokensOut: 10 }).find((row) => row.label === "Tokens")!
    expect(tokens.tone).toBe("wait")
    expect(tokens.detail).toContain("Not checked")
  })
})

describe("what the buyer pasted", () => {
  const pasted = { body: JSON.stringify(body), output, toolCalls: "", finish: "" }

  test("reads the body and leaves empty fields out", () => {
    expect(readMaterial(pasted)).toEqual({ prompt: body, output })
    expect(readMaterial({ ...pasted, toolCalls: '[{"id":"call_1"}]', finish: " stop " })).toEqual({ prompt: body, output, tool_calls: [{ id: "call_1" }], finish: "stop" })
  })

  test("says what is wrong", () => {
    expect(readMaterial({ ...pasted, body: "not json" })).toContain("request body")
    expect(readMaterial({ ...pasted, body: "[1]" })).toContain("request body")
    expect(readMaterial({ ...pasted, toolCalls: "{" })).toContain("Tool calls")
    expect(readMaterial({ ...pasted, toolCalls: "{}" })).toContain("Tool calls")
  })
})
