import { describe, expect, test } from "bun:test"
import { keccak256, toBytes, type Hex } from "viem"
import { channelAuthHeader } from "@offpeak/shared"
import { roleAccount } from "../../../../packages/shared/src/test-keys.ts"
import { mppChannelFetch } from "../../../../packages/sdk/src/mpp.ts"
import { bootStack } from "../support/stack.ts"
const body = JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "MPP hello" }], max_tokens: 8 })
async function setup() {
  const r = await bootStack()
  r.stack.mppSecret = "test-only-mpp-secret-with-more-than-32-characters"
  const id = keccak256(toBytes("mpp-test-channel"))
  r.indexer.channels.set(id, {
    payer: r.buyer as Hex,
    deposit: 50000000n,
    claimed: 0n,
    lastSeq: 0n,
    expiry: BigInt(r.stack.clock() + 86400),
    challengeEndsAt: 0n,
    status: 1,
    closeRequested: false,
  })
  const proof = await channelAuthHeader(roleAccount("buyer"), { channelId: id, ts: r.stack.clock(), body })
  return { ...r, id, proof }
}
describe("MPP channel transport", () => {
  test("SDK wrapper serves through the existing signed channel and caps", async () => {
    const { app, stack, id, proof } = await setup()
    const send = mppChannelFetch(((input, init) => app.request(input, init)) as typeof fetch)
    const r = await send("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-offpeak-channel": id,
        "x-offpeak-channel-auth": proof,
        "x-offpeak-max-charge": "10000",
      },
      body,
    })
    expect(r.status).toBe(200)
    expect((await r.json()).offpeak_usage.record.payMode).toBe(3)
    expect((await stack.db.query("SELECT * FROM shared.usage_records")).rows.length).toBe(1)
  })
  test("rejects replay and binds body, caps and expiration", async () => {
    const { app, stack, id, proof } = await setup(),
      headers = { "content-type": "application/json", "accept-payment": "offpeak-channel", "x-offpeak-max-charge": "10000" }
    const first = await app.request("/v1/chat/completions", { method: "POST", headers, body })
    expect(first.status).toBe(402)
    expect(first.headers.get("www-authenticate")).toContain("Payment ")
    const { challenge } = await first.json()
    const credential =
      "Payment " +
      Buffer.from(
        JSON.stringify({ challenge, payload: { channelId: id, proof: JSON.parse(Buffer.from(proof, "base64url").toString()) } }),
      ).toString("base64url")
    const paid = { ...headers, "payment-authorization": credential }
    expect(
      (await app.request("/v1/chat/completions", { method: "POST", headers: { ...paid, "x-offpeak-max-charge": "20000" }, body })).status,
    ).toBe(402)
    expect(
      (await app.request("/v1/chat/completions", { method: "POST", headers: paid, body: body.replace("hello", "changed") })).status,
    ).toBe(402)
    expect((await app.request("/v1/chat/completions", { method: "POST", headers: paid, body })).status).toBe(200)
    expect((await app.request("/v1/chat/completions", { method: "POST", headers: paid, body })).status).toBe(409)
    stack.setClock(stack.clock() + 121)
    expect((await app.request("/v1/chat/completions", { method: "POST", headers: paid, body })).status).toBe(402)
  })
  test("does not serve an unsigned channel credential or enable itself without configuration", async () => {
    const { app, stack } = await setup()
    stack.mppSecret = undefined
    expect(
      (
        await app.request("/v1/chat/completions", {
          method: "POST",
          headers: { "accept-payment": "offpeak-channel", "x-offpeak-max-charge": "10000" },
          body,
        })
      ).status,
    ).toBe(503)
  })
})
