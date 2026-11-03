import { describe, expect, test } from "bun:test"
import { bootStack } from "../support/stack.ts"
const body = JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "hello" }], max_tokens: 8 })
describe("wallet chat and charge caps", () => {
  test("a wallet session spends only its balance without creating an API key", async () => {
    const { app, stack, buyer } = await bootStack()
    try {
      await stack.db.query(`INSERT INTO serving.siwe_sessions (id,wallet,nonce,expires_at) VALUES ('sess_chat',$1,'',to_timestamp($2))`, [
        buyer,
        stack.clock() + 600,
      ])
      const headers = { authorization: "Bearer sess_chat", "content-type": "application/json", "x-offpeak-max-charge": "10000" }
      expect((await app.request("/v1/chat/session", { method: "POST", headers, body })).status).toBe(200)
      expect(
        (await app.request("/v1/chat/session", { method: "POST", headers: { ...headers, "x-offpeak-max-charge": "1" }, body })).status,
      ).toBe(429)
      const keys = await stack.db.query("SELECT * FROM serving.api_keys")
      expect(keys.rows.length).toBe(1)
      const records = await stack.db.query("SELECT * FROM shared.usage_records")
      expect(records.rows.length).toBe(1)
      expect(
        (await app.request("/v1/chat/session", { method: "POST", headers: { "content-type": "application/json" }, body })).status,
      ).toBe(401)
    } finally {
      /* bootStack owns the in-process database */
    }
  })
  test("bad caps fail before service and an unpaid request cannot authorize beyond the cap", async () => {
    const { app, stack, key } = await bootStack()
    try {
      for (const cap of ["0", "-1", "1.5", "Infinity", "9999999999999999999"])
        expect(
          (
            await app.request("/v1/chat/completions", {
              method: "POST",
              headers: { authorization: `Bearer ${key.token}`, "x-offpeak-max-charge": cap },
              body,
            })
          ).status,
        ).toBe(400)
      expect((await app.request("/v1/chat/completions", { method: "POST", headers: { "x-offpeak-max-charge": "1" }, body })).status).toBe(
        429,
      )
      expect((await stack.db.query("SELECT * FROM shared.usage_records")).rows.length).toBe(0)
    } finally {
      /* bootStack owns the in-process database */
    }
  })
})
