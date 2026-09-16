import { describe, expect, test } from "bun:test"
import { bootStack } from "../../../apps/router/test/support/stack.ts"
import { parseEnvelope } from "@offpeak/shared"
import { verifyUsage } from "./verify.ts"

describe("sdk verify", () => {
  test("accepts a router envelope", async () => {
    const { app, key, stack, host } = await bootStack()
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "verify me" }] }),
    })
    const json = await res.json()
    const env = parseEnvelope(json.offpeak_usage)
    const report = await verifyUsage(env, stack.usageLedger, stack.router.address, host)
    expect(report.ok).toBe(true)
  })
})
