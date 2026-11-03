import { expect, test } from "bun:test"
import type { Offpeak } from "@offpeak/sdk"
import { createAgentTool, gameFunction, bursarFetch } from "../src/index.ts"
test("agent input cannot override the operator budget, model or output ceiling", async () => {
  const calls: unknown[] = []
  const op = {
    chat: async (...args: unknown[]) => {
      calls.push(args)
      return { text: "answer", envelope: { record: { reqId: "req", hostCostMicro: 5n, feeMicro: 1n } } }
    },
    verifyUsage: async () => ({ ok: true }),
  } as unknown as Offpeak
  const tool = createAgentTool(op, {
    models: ["allowed"],
    maxTokens: 128,
    maxChargeMicro: 10000n,
    maxPrice: { inPerM: 100n, outPerM: 200n },
  })
  await expect(tool.execute({ model: "forbidden", prompt: "hi" })).rejects.toThrow("not allowed")
  await expect(tool.execute({ model: "allowed", prompt: "hi", maxChargeMicro: 9999999 })).rejects.toThrow()
  const result = await tool.execute({ model: "allowed", prompt: "hi" })
  expect(result.costMicro).toBe("6")
  expect(calls[0]).toEqual([
    { model: "allowed", messages: [{ role: "user", content: "hi" }], max_tokens: 128, stream: false },
    { maxPrice: { inPerM: 100n, outPerM: 200n }, maxChargeMicro: 10000n },
  ])
  const game = gameFunction(tool, (status, feedback) => ({ status, feedback }))
  expect((await game.executable({ model: "forbidden", prompt: "hi" })).status).toBe("failed")
  expect((await game.executable({ model: "allowed", prompt: "hi" })).status).toBe("done")
})
test("Bursar adapter pins HTTPS origin, route, mandate lane and cap", async () => {
  const calls: unknown[] = []
  const send = bursarFetch(
    {
      fetch: async (...args) => {
        calls.push(args)
        return { response: Response.json({ ok: true }) }
      },
    },
    "https://merchant.example",
    10000n,
  )
  expect((await send("/v1/chat/completions", { model: "m" })).ok).toBe(true)
  const [url, options] = calls[0] as [string, Record<string, unknown>]
  expect(url).toBe("https://merchant.example/v1/chat/completions")
  expect(options.lane).toBe("mandate")
  expect(options.maxAmount).toBe(10000n)
  expect(options.capability).toBe("service:inference.text")
  for (const path of ["https://other.example/v1/chat/completions", "/v1/chat/completions?override=1", "/v1/other"])
    await expect(send(path, {})).rejects.toThrow("not allowed")
  expect(() => bursarFetch({ fetch: async () => ({ response: new Response() }) }, "http://merchant.example", 1n)).toThrow()
  expect(calls).toHaveLength(1)
})
