import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { Template } from "@huggingface/jinja"
import { LAUNCH_TOKENIZER, ModelTokenizer, countChat, countInputs, countOutput, countText, detectContentFormat, modelTokenizerFrom, renderChat, type ChatMessage } from "./tokenizer.ts"
import { loadModelTokenizer, manifestDigest, modelManifestSchema, readManifest } from "./model-manifest.ts"
import { tokenizerFromFiles } from "./recount.ts"

const dir = new URL("../fixtures/tokenizers/qwen2.5-0.5b-instruct/", import.meta.url).pathname
const manifest = readManifest(`${dir}manifest.json`)
const tokenizer = loadModelTokenizer(manifest, dir)

type Case = { name: string; messages: ChatMessage[]; tools?: unknown[] }
type Turn = { name: string; text: string; toolCalls: unknown[] }
const cases = JSON.parse(readFileSync(`${dir}cases.json`, "utf8")) as { chat: Case[]; text: string[]; toolTurns: Turn[] }
// Written by gen-golden.py with the Rust tokenizer and transformers' apply_chat_template, not by this code.
const golden = JSON.parse(readFileSync(`${dir}golden.json`, "utf8")) as {
  chat: { name: string; rendered: string; ids: number[] }[]
  text: { text: string; ids: number[]; idsWithSpecial: number[] }[]
  toolTurns: { name: string; turn: string; ids: number[] }[]
}

describe("how content reaches a template", () => {
  const format = (template: string) => detectContentFormat(new Template(template))
  const tokenizerJson = JSON.parse(readFileSync(`${dir}tokenizer.json`, "utf8"))
  const parts: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }]
  const looping = "{% for m in messages %}{% for p in m['content'] %}<{{ p.text }}>{% endfor %}{% endfor %}"
  const plain = "{% for m in messages %}<{{ m['content'] }}>{% endfor %}"

  test("is read from the template, the way vLLM reads it", () => {
    expect(format(plain)).toBe("string")
    expect(format(looping)).toBe("openai")
    expect(format("{% for m in messages %}{% for p in m.content %}{{ p.text }}{% endfor %}{% endfor %}")).toBe("openai")
    expect(format("{% for m in messages %}{% set c = m.content %}{% for p in c %}{{ p.text }}{% endfor %}{% endfor %}")).toBe("openai")
    expect(format("{% for m in messages %}{% for p in m.content if p.type == 'text' %}{{ p.text }}{% endfor %}{% endfor %}")).toBe("openai")
  })

  test("the fixture's pinned template takes strings, as its manifest says", () => {
    expect(manifest.contentFormat).toBe("string")
    expect(tokenizer.countChat({ messages: parts })).toBe(tokenizer.countChat({ messages: [{ role: "user", content: "one\ntwo" }] }))
  })

  test("a router and a host counting the same template cannot disagree, whatever the manifest claims", () => {
    expect(() => new ModelTokenizer({ tokenizerJson, tokenizerConfig: {}, chatTemplate: plain, contentFormat: "openai" })).toThrow("the pinned template takes string")
    expect(() => new ModelTokenizer({ tokenizerJson, tokenizerConfig: {}, chatTemplate: looping, contentFormat: "string" })).toThrow("the pinned template takes openai")
    expect(() => modelTokenizerFrom((path) => (path === "tokenizer.json" ? JSON.stringify(tokenizerJson) : path === "chat_template.jinja" ? plain : null), "openai")).toThrow("pinned template")
  })

  test("the two formats really do count differently, which is why it must be pinned", () => {
    const asString = new ModelTokenizer({ tokenizerJson, tokenizerConfig: {}, chatTemplate: plain })
    const asParts = new ModelTokenizer({ tokenizerJson, tokenizerConfig: {}, chatTemplate: "{% for m in messages %}{% for p in m.content %}<<part>>{{ p.text }}<<end part>>{% endfor %}{% endfor %}" })
    expect(asParts.countChat({ messages: parts })).toBeGreaterThan(asString.countChat({ messages: parts }))
  })

  test("a router's claim about the format is not even read", () => {
    const files = Object.fromEntries(["tokenizer.json", "tokenizer_config.json"].map((path) => [path, readFileSync(`${dir}${path}`, "utf8")]))
    const published = { weights: manifest.weights, tokenizer: manifest.tokenizer, chatTemplate: manifest.chatTemplate, files }
    const claimed = tokenizerFromFiles({ ...published, contentFormat: "openai" }, manifestDigest(manifest))
    expect(claimed.countChat({ messages: parts })).toBe(tokenizer.countChat({ messages: parts }))
  })
})

describe("a real public tokenizer", () => {
  test("pinned files are the ones published for the model", () => {
    const hash = (name: string) => createHash("sha256").update(readFileSync(`${dir}${name}`)).digest("hex")
    expect(hash("tokenizer.json")).toBe("c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539")
    expect(hash("tokenizer_config.json")).toBe("5b5d4f65d0acd3b2d56a35b56d374a36cbc1c8fa5cf3b3febbbfabf22f359583")
  })

  test("the model digest comes from the manifest", () => {
    expect(manifestDigest(manifest)).toBe("0x9599ee65e52af1a4254555c5d515ea86484eff63776402469bc1c640636875c9")
  })

  test.each(cases.chat.map((row, index) => [row.name, row, golden.chat[index]!] as const))("renders and counts: %s", (name, row, want) => {
    expect(want.name).toBe(name)
    expect(tokenizer.render(row)).toBe(want.rendered)
    expect(tokenizer.encode(want.rendered)).toEqual(want.ids)
    expect(tokenizer.countChat(row)).toBe(want.ids.length)
    expect(countChat(tokenizer, row.messages, row.tools)).toBe(want.ids.length)
  })

  test("output text counts match, with and without special tokens", () => {
    for (const row of golden.text) {
      expect(tokenizer.encode(row.text)).toEqual(row.ids)
      expect(countText(tokenizer, row.text)).toBe(row.ids.length)
      expect(countInputs(tokenizer, [row.text, row.text])).toBe(row.idsWithSpecial.length * 2)
    }
  })

  test("the end token counts only when the model stopped on its own", () => {
    const text = golden.text[0]!
    expect(tokenizer.countOutput(text.text, undefined, "stop")).toBe(text.ids.length + 1)
    expect(tokenizer.countOutput(text.text, undefined, "length")).toBe(text.ids.length)
    expect(tokenizer.countOutput(text.text)).toBe(text.ids.length)
    expect(countOutput(tokenizer, text.text, [], "stop")).toBe(text.ids.length + 1)
  })

  test("a tool call counts as the turn the template writes", () => {
    cases.toolTurns.forEach((row, index) => {
      const want = golden.toolTurns[index]!
      expect(want.name).toBe(row.name)
      expect(tokenizer.countOutput(row.text, row.toolCalls, "tool_calls")).toBe(want.ids.length)
    })
  })

  test("a file that differs from its pin is refused", () => {
    const wrong = { ...manifest, tokenizer: manifest.tokenizer.map((file) => (file.path === "tokenizer.json" ? { ...file, sha256: "00".repeat(32) } : file)) }
    expect(() => loadModelTokenizer(wrong, dir)).toThrow("does not match its pinned hash")
  })

  test("a template shipped as its own file wins over the config", () => {
    const row = new (tokenizer.constructor as typeof import("./tokenizer.ts").ModelTokenizer)({
      tokenizerJson: JSON.parse(readFileSync(`${dir}tokenizer.json`, "utf8")),
      tokenizerConfig: JSON.parse(readFileSync(`${dir}tokenizer_config.json`, "utf8")),
      chatTemplate: "{% for m in messages %}{{ m.content }}{% endfor %}",
    })
    expect(row.render({ messages: [{ role: "user", content: "only this" }] })).toBe("only this")
  })
})

describe("the manifest", () => {
  test("rejects a path that leaves the model folder", () => {
    const row = { ...manifest, weights: [{ path: "../secret", sha256: "ab".repeat(32) }] }
    expect(modelManifestSchema.safeParse(row).success).toBe(false)
  })

  test("rejects a file listed in two groups", () => {
    const row = { ...manifest, weights: [manifest.tokenizer[0]!] }
    expect(modelManifestSchema.safeParse(row).success).toBe(false)
  })

  test("needs tokenizer.json pinned", () => {
    expect(modelManifestSchema.safeParse({ ...manifest, tokenizer: [manifest.tokenizer[0]!] }).success).toBe(false)
  })
})

describe("the byte-level tokenizer stays as it was", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }]

  test("chat, output and input counts", () => {
    expect(renderChat(messages)).toBe("<bos><user>\nhi<eos><bos><assistant>\n")
    expect(countChat(LAUNCH_TOKENIZER, messages)).toBe(9)
    expect(countOutput(LAUNCH_TOKENIZER, "abc")).toBe(3)
    expect(countOutput(LAUNCH_TOKENIZER, "abc", undefined, "stop")).toBe(3)
    expect(countOutput(LAUNCH_TOKENIZER, "abc", [{ a: 1 }])).toBe(3 + 1 + JSON.stringify([{ a: 1 }]).length)
    expect(countText(LAUNCH_TOKENIZER, "é")).toBe(2)
    expect(countInputs(LAUNCH_TOKENIZER, ["ab", "c"])).toBe(3)
  })
})
