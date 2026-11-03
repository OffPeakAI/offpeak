import { expect, test } from "bun:test"
import { addChannel, ask, bootRouter, client, costOf, inProcess } from "./support.ts"
import { type ChatResult, type ChatStream } from "../src/index.ts"

test("total cap reaches the router and applies to completed and streamed requests", async () => {
  const booted = await bootRouter(),
    op = client(booted, { apiKey: booted.key.token })
  await expect(op.chat(ask("too low"), { maxChargeMicro: 1n })).rejects.toMatchObject({ code: "charge_above_cap" })
  const result = (await op.chat(ask("allowed"), { maxChargeMicro: 10000n })) as ChatResult
  expect(costOf(result.envelope)).toBeLessThanOrEqual(10000n)
  const stream = (await op.chat({ ...ask("stream"), stream: true }, { maxChargeMicro: 10000n })) as ChatStream
  expect(costOf((await stream.final()).envelope)).toBeLessThanOrEqual(10000n)
  await expect(op.chat(ask("sealed"), { maxChargeMicro: 10000n, sealed: true })).rejects.toThrow("not supported")
})

test("SDK refuses a channel receipt above the cap before signing its voucher", async () => {
  const booted = await bootRouter(),
    send = inProcess(booted.app),
    channel = addChannel(booted, 5000000n)
  const op = client(booted, {
    channel: { id: channel },
    fetch: (async (input, init) => {
      const r = await send(input, init)
      if (new URL(String(input)).pathname === "/v1/chat/completions" && r.ok) {
        const body = await r.json()
        body.offpeak_usage.record.hostCostMicro = "10001"
        return Response.json(body, { headers: r.headers })
      }
      return r
    }) as typeof fetch,
  })
  await expect(op.chat(ask("tampered"), { maxChargeMicro: 10000n })).rejects.toMatchObject({ code: "above_charge_cap" })
  expect(op.channels.snapshot()?.signed).toBe(0n)
})

test("an upto offer cannot expand the per-call authorization cap", async () => {
  const { addressOf } = await import("@offpeak/abis"),
    { PERMIT2 } = await import("@offpeak/shared")
  const booted = await bootRouter()
  const op = client(booted, {
    fetch: (async () =>
      Response.json(
        {
          accepts: [
            {
              scheme: "upto",
              network: "eip155:4663",
              asset: addressOf("MockUSDG"),
              payTo: addressOf("OffpeakVault"),
              maxAmountRequired: "50000",
              extra: {
                permit2: PERMIT2,
                spender: addressOf("X402Escrow"),
                reqId: `0x${"ab".repeat(32)}`,
                validBefore: Math.floor(Date.now() / 1000) + 600,
                witness: "UptoWitness",
              },
            },
          ],
        },
        { status: 402 },
      )) as typeof fetch,
  })
  await expect(op.chat(ask("capped"), { maxChargeMicro: 10000n })).rejects.toMatchObject({ code: "above_charge_cap" })
})
