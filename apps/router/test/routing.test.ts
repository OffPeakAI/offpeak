import { describe, expect, test } from "bun:test"
import { verifyRouterReq } from "../../host-agent/src/proxy.ts"
import { bootStack } from "./support/stack.ts"

describe("routing and caps", () => {
  test("fails over before the first token when the cheaper host errors", async () => {
    const { app, key, host, hostApps } = await bootStack({ failHost: true, secondHost: true })
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "failover" }] }),
    })
    expect(res.status).toBe(200)
    const served = res.headers.get("x-offpeak-host")
    expect(served).not.toBe(host)
    expect(hostApps.has(served!)).toBe(true)
  })

  test("price above cap is 429 and flex is accepted", async () => {
    const { app, key } = await bootStack()
    const capped = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.token}`,
        "content-type": "application/json",
        "x-offpeak-max-price": "in=0.000001,out=0.000001",
      },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "too dear" }] }),
    })
    expect(capped.status).toBe(429)
    const flex = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.token}`,
        "content-type": "application/json",
        "x-offpeak-max-price": "in=0.000001,out=0.000001",
        "x-offpeak-flex": "2030-01-01T00:00:00Z",
      },
      body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "later" }] }),
    })
    expect(flex.status).toBe(202)
  })

  test("json mode parses and tools pass through", async () => {
    const { app, key } = await bootStack()
    const json = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "ofm-8b",
        messages: [{ role: "user", content: "struct" }],
        response_format: { type: "json_object" },
      }),
    })
    const body = await json.json()
    expect(JSON.parse(body.choices[0].message.content)).toEqual({ ok: true })
    const tools = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "ofm-8b",
        messages: [{ role: "user", content: "please tool this" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      }),
    })
    const toolBody = await tools.json()
    expect(toolBody.choices[0].finish_reason).toBe("tool_calls")
  })

  test("host rejects a request signature that is not from the router", async () => {
    const { stack } = await bootStack()
    const header = Buffer.from(JSON.stringify({
      reqId: `0x${"ab".repeat(32)}`,
      ts: 1,
      bodyHash: `0x${"cd".repeat(32)}`,
      sig: `0x${"11".repeat(65)}`,
    })).toString("base64url")
    expect(await verifyRouterReq(header, stack.router.address)).toBeNull()
  })
})
