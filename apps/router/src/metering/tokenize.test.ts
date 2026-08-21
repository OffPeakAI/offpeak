import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LAUNCH_TOKENIZER, manifestDigest, readManifest, type Hex } from "@offpeak/shared"
import { countChat, countInputs, countOutput, loadTokenizers, tokenizerFor } from "./tokenize.ts"

const dir = new URL("../../../../packages/shared/fixtures/tokenizers/qwen2.5-0.5b-instruct/", import.meta.url).pathname
const manifestPath = `${dir}manifest.json`
const digest = manifestDigest(readManifest(manifestPath))
const golden = JSON.parse(readFileSync(`${dir}golden.json`, "utf8")) as { chat: { name: string; ids: number[] }[]; text: { text: string; ids: number[] }[] }
const cases = JSON.parse(readFileSync(`${dir}cases.json`, "utf8")) as { chat: { messages: never[]; tools?: unknown }[] }

describe("router token counts", () => {
  loadTokenizers([{ name: "real", digest, tokenizer: { manifest: manifestPath, dir } }], true)

  test("a model with a manifest counts as the published tokenizer does", () => {
    cases.chat.forEach((row, index) => expect(countChat({ digest }, row)).toBe(golden.chat[index]!.ids.length))
    const text = golden.text[0]!
    expect(countOutput({ digest }, text.text, undefined, "stop")).toBe(text.ids.length + 1)
    expect(countOutput({ digest }, text.text, undefined, "length")).toBe(text.ids.length)
    expect(countInputs({ digest }, [text.text])).toBe(text.ids.length)
  })

  test("a model without one stays on the byte tokenizer outside production", () => {
    const other = `0x${"12".repeat(32)}` as Hex
    loadTokenizers([{ name: "mock", digest: other }], false)
    expect(tokenizerFor({ digest: other })).toBe(LAUNCH_TOKENIZER)
    expect(countChat({ digest: other }, { messages: [{ role: "user", content: "hi" }] })).toBe(9)
  })

  test("production needs a tokenizer for every model", () => {
    expect(() => loadTokenizers([{ name: "mock", digest: `0x${"12".repeat(32)}` }], true)).toThrow("no tokenizer for model mock")
  })

  test("a manifest for another digest is refused", () => {
    expect(() => loadTokenizers([{ name: "wrong", digest: `0x${"34".repeat(32)}`, tokenizer: { manifest: manifestPath, dir } }], false)).toThrow("does not match the digest")
  })

  test("a tokenizer file that moved off its pin is refused", () => {
    const copy = mkdtempSync(join(tmpdir(), "offpeak-tokenizer-"))
    writeFileSync(join(copy, "tokenizer.json"), "{}")
    writeFileSync(join(copy, "tokenizer_config.json"), "{}")
    expect(() => loadTokenizers([{ name: "real", digest, tokenizer: { manifest: manifestPath, dir: copy } }], false)).toThrow("does not match its pinned hash")
    rmSync(copy, { recursive: true, force: true })
  })
})
