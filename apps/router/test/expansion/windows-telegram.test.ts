import { describe, expect, test } from "bun:test"
import { decodeFunctionData } from "viem"
import { windowMarketAbi } from "@offpeak/abis"
import { createWindowInput, createWindowPlan } from "../../src/expansion/window-plan.ts"
import { telegramConfig } from "../../src/expansion/telegram.ts"
import { bootStack } from "../support/stack.ts"
describe("capacity creation", () => {
  test("only a serving host can create a bounded, collateralized reservation", async () => {
    const { stack, host, buyer } = await bootStack(),
      t0 = Math.ceil((stack.clock() + 3600) / 3600) * 3600
    const params = createWindowInput.parse({
      modelDigest: stack.models[0]!.digest,
      t0,
      t1: t0 + 8 * 3600,
      units: "1",
      minTps: 80,
      startPricePerUnit: "1000000",
      endPricePerUnit: "500000",
      auctionStart: stack.clock(),
      auctionEnd: t0,
    })
    const p = await createWindowPlan(stack, host, params)
    expect(p.collateralMicro).toBe("200000")
    expect(p.approval.amount).toBe("200000")
    expect(decodeFunctionData({ abi: windowMarketAbi, data: p.tx.data }).functionName).toBe("create")
    await expect(createWindowPlan(stack, buyer, params)).rejects.toThrow("host_not_serving_model")
    await expect(createWindowPlan(stack, host, { ...params, units: 1000n })).rejects.toThrow("window_exceeds_capacity")
    await expect(createWindowPlan(stack, host, { ...params, t0: t0 + 1 })).rejects.toThrow("invalid_window_terms")
  })
})
describe("Telegram wallet handoff", () => {
  test("requires a secret, ignores groups and replays, and never executes paid inference", async () => {
    const { app, stack } = await bootStack()
    stack.telegram = { secret: "test-webhook-secret-of-at-least-32-chars", url: "https://chat.example/chat" }
    const headers = { "content-type": "application/json", "x-telegram-bot-api-secret-token": stack.telegram.secret },
      body = JSON.stringify({ update_id: 99, message: { chat: { id: 123, type: "private" }, text: "/ask Summarize this" } })
    expect((await app.request("/v1/telegram/webhook", { method: "POST", body })).status).toBe(403)
    const r = await app.request("/v1/telegram/webhook", { method: "POST", headers, body }),
      reply = await r.json()
    expect(reply.method).toBe("sendMessage")
    expect(reply.reply_markup.inline_keyboard[0][0].web_app.url).toBe("https://chat.example/chat#prompt=Summarize+this")
    expect(await (await app.request("/v1/telegram/webhook", { method: "POST", headers, body })).json()).toEqual({ ok: true })
    expect((await stack.db.query("SELECT * FROM shared.usage_records")).rows.length).toBe(0)
  })
  test("rejects unsafe Mini App URLs", () => {
    expect(() =>
      telegramConfig({ OFFPEAK_TELEGRAM_WEBHOOK_SECRET: "a".repeat(32), OFFPEAK_CHAT_PUBLIC_URL: "http://example/chat" }),
    ).toThrow()
    expect(telegramConfig({})).toBeUndefined()
  })
})
