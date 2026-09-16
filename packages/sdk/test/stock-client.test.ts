import { describe, expect, test } from "bun:test"
import OpenAI from "openai"
import { ask, bootRouter, BASE, inProcess, type Booted } from "./support.ts"

/** A plain OpenAI client pointed at the router, with nothing of Offpeak's in front of it. */
const stock = (booted: Booted) => new OpenAI({ baseURL: `${BASE}/v1`, apiKey: booted.key.token, maxRetries: 0, fetch: inProcess(booted.app) })

describe("a stock OpenAI client on an Offpeak stream", () => {
  test("reading choices[0].delta survives the offpeak.* events", async () => {
    const booted = await bootRouter()
    const stream = await stock(booted).chat.completions.create({ ...ask("hello there", 64), messages: [{ role: "user", content: "hello there" }], stream: true })
    let text = ""
    let finish: string | null = null
    let seen = 0
    for await (const chunk of stream) {
      seen += 1
      text += chunk.choices[0]!.delta.content ?? ""
      finish = chunk.choices[0]!.finish_reason ?? finish
    }
    expect(seen).toBeGreaterThan(1)
    expect(text.length).toBeGreaterThan(0)
    expect(finish).toBe("stop")
  })

  test("the usage event gives such a client OpenAI's own usage figures too", async () => {
    const booted = await bootRouter()
    const stream = await stock(booted).chat.completions.create({ ...ask("hello there", 64), messages: [{ role: "user", content: "hello there" }], stream: true })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks.at(-1)!.usage?.total_tokens).toBeGreaterThan(0)
  })

  test("the stream helper ends on the whole completion", async () => {
    const booted = await bootRouter()
    const stream = stock(booted).chat.completions.stream({ ...ask("hello there", 64), messages: [{ role: "user", content: "hello there" }], stream: true })
    const done = await stream.finalChatCompletion()
    expect(done.choices[0]!.message.content!.length).toBeGreaterThan(0)
    expect(done.choices[0]!.finish_reason).toBe("stop")
  })
})
