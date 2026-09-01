import { describe, expect, test } from "bun:test"
import { bootStack } from "./support/stack.ts"
import { runBatch } from "../src/openai/batches.ts"

describe("embeddings and batches", () => {
  test("embeddings bill input tokens only", async () => {
    const { app, key, stack } = await bootStack()
    const res = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "ofm-embed", input: "hello embeddings" }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.usage.prompt_tokens).toBeGreaterThan(0)
    expect(json.offpeak_usage.record.tokensOut).toBe(0)
    const rows = await stack.db.query<{ tokens_out: number }>("SELECT tokens_out FROM shared.usage_records")
    expect(rows.rows[0]?.tokens_out).toBe(0)
  })

  test("a batch locks a price and runs its lines", async () => {
    const { app, key, stack } = await bootStack()
    const jsonl = [
      JSON.stringify({ custom_id: "a", method: "POST", url: "/v1/chat/completions", body: { model: "ofm-8b", messages: [{ role: "user", content: "one" }] } }),
      JSON.stringify({ custom_id: "b", method: "POST", url: "/v1/chat/completions", body: { model: "ofm-8b", messages: [{ role: "user", content: "two" }] } }),
    ].join("\n")
    const file = await app.request("/v1/files", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({ purpose: "batch", content: jsonl }),
    })
    expect(file.status).toBe(200)
    const uploaded = await file.json()
    const batch = await app.request("/v1/batches", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({ input_file_id: uploaded.id, completion_window: "24h" }),
    })
    expect(batch.status).toBe(200)
    const created = await batch.json()
    expect(created.offpeak.locked_price.in).toBeTruthy()
    const ran = await runBatch(stack, created.id)
    expect(ran.ran).toBe(2)
    const owner = { headers: { authorization: `Bearer ${key.token}` } }
    const view = await (await app.request(`/v1/batches/${created.id}`, owner)).json()
    const body = await app.request(`/v1/files/${view.output_file_id}/content`, owner)
    const text = await body.text()
    expect(text).toContain("custom_id")
  })
})
