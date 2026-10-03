import { describe, expect, test } from "bun:test"
import { createPublicClient, http } from "viem"
import { bootStack } from "../../apps/router/test/support/stack.ts"
import { indexerApp } from "../../services/mock-indexer/src/http.ts"
import { facilitatorApp } from "../../services/mock-facilitator/src/main.ts"
import { LiveChain } from "../../apps/router/src/chainview/live.ts"

describe("local anvil and mocks", () => {
  test("chain id 4663 with the mock indexer and a prepaid call", async () => {
    const anvilBin = `${process.env.HOME}/.foundry/bin/anvil`
    const anvil = Bun.spawn([anvilBin, "--host", "127.0.0.1", "--port", "29545", "--chain-id", "4663", "--silent"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      await waitFor("http://127.0.0.1:29545")
      const client = createPublicClient({ transport: http("http://127.0.0.1:29545") })
      expect(await client.getChainId()).toBe(4663)
      const booted = await bootStack()
      const idx = Bun.serve({ port: 29788, fetch: indexerApp(booted.indexer).fetch })
      const fac = Bun.serve({
        port: 29789,
        fetch: facilitatorApp(booted.facilitator, "local-test-token-0123456789abcdef").fetch,
      })
      process.env.OFFPEAK_INTERNAL_TOKEN = "local-test-token-0123456789abcdef"
      const live = new LiveChain({ url: "http://127.0.0.1:29788", token: process.env.OFFPEAK_INTERNAL_TOKEN, endpointOf: () => undefined })
      expect((await live.buyer(booted.buyer, 0)).servable).toBe(true)
      const chat = await booted.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "anvil" }], max_tokens: 8 }),
      })
      expect(chat.status).toBe(200)
      const supported = await fetch("http://127.0.0.1:29789/x402/supported")
      expect(supported.status).toBe(200)
      idx.stop()
      fac.stop()
    } finally {
      anvil.kill()
    }
  }, 30_000)
})

async function waitFor(url: string) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })
      if (res.ok) return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error("anvil did not start")
}
