import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Offpeak } from "@offpeak/sdk"
import { ChannelManagerAbi, HostRegistryAbi, addressOf } from "../../abis/src/index.ts"
import { addChannel, ask, BASE, bootRouter, buyerAccount, chainView, channelRow, client, inProcess, type Booted } from "../../sdk/test/support.ts"
import { anvilAccount } from "../../shared/src/test-keys.ts"
import { decodeFunctionData, encodeFunctionResult } from "viem"
import { clientFrom, createMcp, readConfig, serveHttp } from "../src/index.ts"
import { nextHours } from "../src/tools/prices.ts"

const AGENT_KEY = `0x${Buffer.from(anvilAccount(3).getHdKey().privateKey!).toString("hex")}`
const DEPLOYMENT_FILE = new URL("../../abis/deployments/local.json", import.meta.url).pathname
const MAIN = new URL("../src/main.ts", import.meta.url).pathname
const port = () => 35_000 + Math.floor(Math.random() * 1000)
const farDeadline = () => new Date(Date.now() + 12 * 3_600_000).toISOString()

async function connect(transport: Transport) {
  const mcp = new Client({ name: "test", version: "1.0.0" })
  await mcp.connect(transport)
  return mcp
}

async function connected(op: Offpeak) {
  const [server, peer] = InMemoryTransport.createLinkedPair()
  await createMcp(op).connect(server)
  return connect(peer)
}

async function call(mcp: Client, name: string, args: Record<string, unknown>) {
  const result = await mcp.callTool({ name, arguments: args })
  const [first] = result.content as { type: string; text: string }[]
  return { isError: Boolean(result.isError), raw: first!.text, body: JSON.parse(first!.text) }
}

const usageOf = async (mcp: Client, args: Record<string, unknown>) => (await call(mcp, "offpeak_usage", args)).body.records as { req_id: string; usage: unknown; verification: { ok: boolean; status?: string }; proof: { status: string; ok: boolean; onchain: boolean } }[]

const jobs = async (booted: Booted) => (await booted.stack.db.query<{ status: string; model: string }>("SELECT status, model FROM serving.jobs")).rows

const complete = { model: "ofm-8b", messages: [{ role: "user", content: "hello from an agent" }], max_tokens: 8 }

/** The mock model publishes no tokenizer, so a recount here can only say its counts were not checked. */
const NOT_COUNTED = ["token_count_not_checked"]

/** A JSON-RPC endpoint for the real entry point, answering from what the mock indexer holds. */
function chainServer(booted: Booted) {
  const view = chainView(booted)
  const registry = addressOf("HostRegistry").toLowerCase()
  return Bun.serve({
    port: port(),
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const { id, method, params } = (await req.json()) as { id: number; method: string; params: [{ to: string; data: `0x${string}` }] }
      if (method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id, result: "0x1237" })
      const abi = (params[0].to.toLowerCase() === registry ? HostRegistryAbi : ChannelManagerAbi) as typeof ChannelManagerAbi
      const call = decodeFunctionData({ abi, data: params[0].data })
      const value = await view.readContract({ functionName: call.functionName, args: call.args } as never)
      return Response.json({ jsonrpc: "2.0", id, result: encodeFunctionResult({ abi, functionName: call.functionName, result: value } as never) })
    },
  })
}

describe("tool list", () => {
  test("has the four tools with the inputs the spec names", async () => {
    const booted = await bootRouter()
    const { tools } = await (await connected(client(booted, { apiKey: booted.key.token }))).listTools()
    expect(tools.map((row) => row.name).sort()).toEqual(["offpeak_complete", "offpeak_prices", "offpeak_schedule_job", "offpeak_usage"])
    const fields = (name: string) => Object.keys((tools.find((row) => row.name === name)!.inputSchema as { properties: object }).properties).sort()
    expect(fields("offpeak_complete")).toEqual(["max_price", "max_tokens", "messages", "model", "response_format", "tools"])
    expect(fields("offpeak_prices")).toEqual(["model"])
    expect(fields("offpeak_schedule_job")).toEqual(["deadline", "max_price", "model", "requests"])
    expect(fields("offpeak_usage")).toEqual(["recount", "req_id", "since"])
  })

  test("descriptions carry the honest limits", async () => {
    const booted = await bootRouter()
    const { tools } = await (await connected(client(booted, { apiKey: booted.key.token }))).listTools()
    const text = JSON.stringify(tools)
    expect(text).toContain("Open hosts and the router can read prompts")
    expect(text).toContain("dispute any request within 7 days")
    expect(text).toContain("not the lowest hour")
  })
})

describe("offpeak_complete", () => {
  test("gives the completion, the signed record and its verification", async () => {
    const booted = await bootRouter()
    const mcp = await connected(client(booted, { apiKey: booted.key.token }))
    const { isError, body } = await call(mcp, "offpeak_complete", complete)
    expect(isError).toBe(false)
    expect(body.text).toBeTruthy()
    expect(body.usage.record.payMode).toBe(0)
    expect(body.usage.record.priceIn).toMatch(/^\d+$/)
    expect(body.verification).toMatchObject({ reasons: NOT_COUNTED, routerOk: true, hostOk: true, costOk: true, leafOk: true })
  })

  test("max_price over the live price fails with what the router said", async () => {
    const booted = await bootRouter()
    const mcp = await connected(client(booted, { apiKey: booted.key.token }))
    const { isError, body } = await call(mcp, "offpeak_complete", { ...complete, max_price: { in: "0.000001", out: "0.000001" } })
    expect(isError).toBe(true)
    expect(body.error.code).toBe("price_above_cap")
    expect(body.error.next_cheaper_hour).toBeGreaterThan(0)
    expect((await call(mcp, "offpeak_complete", { ...complete, max_price: { in: "10", out: "10" } })).isError).toBe(false)
  })

  test("an unknown model is a readable failure", async () => {
    const booted = await bootRouter()
    const mcp = await connected(client(booted, { apiKey: booted.key.token }))
    const { isError, body } = await call(mcp, "offpeak_complete", { ...complete, model: "no-such-model" })
    expect(isError).toBe(true)
    expect(body.error.code).toBe("model_not_found")
  })

  test("bad input never reaches the router", async () => {
    const booted = await bootRouter()
    let sent = 0
    const mcp = await connected(
      client(booted, {
        apiKey: booted.key.token,
        fetch: (async () => {
          sent += 1
          return new Response(null, { status: 500 })
        }) as typeof fetch,
      }),
    )
    for (const bad of [{ ...complete, max_tokens: 0 }, { ...complete, messages: [] }, { ...complete, messages: [{ role: "robot", content: "x" }] }, { ...complete, max_price: { in: "free", out: "0.1" } }]) {
      const result = await mcp.callTool({ name: "offpeak_complete", arguments: bad }).catch(() => ({ isError: true }))
      expect(result.isError).toBe(true)
    }
    expect(sent).toBe(0)
  })

  test("a wallet pays from its channel and signs its own vouchers, and the key stays in the process", async () => {
    const booted = await bootRouter()
    const id = addChannel(booted, 5_000_000n)
    const outgoing: string[] = []
    const send = inProcess(booted.app)
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      outgoing.push(String(input), JSON.stringify([...new Headers(init?.headers).entries()]), String(init?.body ?? ""))
      return send(input, init)
    }) as typeof fetch
    const config = readConfig({ OFFPEAK_PUBLIC_BASE_URL: BASE, OFFPEAK_AGENT_WALLET_KEY: AGENT_KEY, OFFPEAK_CHANNEL_ID: id, OFFPEAK_RPC_URL: "http://rpc.test", OFFPEAK_DEPLOYMENT_FILE: DEPLOYMENT_FILE })
    const mcp = await connected(clientFrom(config, recording, chainView(booted)))
    const first = await call(mcp, "offpeak_complete", complete)
    const second = await call(mcp, "offpeak_complete", { ...complete, messages: [{ role: "user", content: "again" }] })
    expect(first.body.usage.record.payMode).toBe(3)
    expect(first.body.verification.reasons).toEqual(NOT_COUNTED)
    expect(second.body.channel.voucher_problem).toBeNull()
    const spent = [first, second].reduce((sum, { body }) => sum + BigInt(body.usage.record.hostCostMicro) + BigInt(body.usage.record.feeMicro), 0n)
    expect(await channelRow(booted, id)).toEqual({ seq: 2n, cumulative: spent })
    const seen = [...outgoing, first.raw, second.raw].join("\n").toLowerCase()
    expect(seen).toContain("x-offpeak-channel-auth")
    expect(seen).not.toContain(AGENT_KEY.slice(2).toLowerCase())
  })
})

describe("offpeak_prices", () => {
  test("gives the live price, the cheapest host and 24 forecast hours from now", async () => {
    const booted = await bootRouter()
    const mcp = await connected(client(booted, { apiKey: booted.key.token }))
    const { body } = await call(mcp, "offpeak_prices", { model: "ofm-8b" })
    expect(body.model).toBe("ofm-8b")
    expect(body.live.in.micro_per_m).toMatch(/^\d+$/)
    expect(body.live.in.usd_per_m).toMatch(/^\d+\.\d{6}$/)
    expect(body.cheapest_host.host).toBe(booted.host)
    expect(body.forecast_next_24h).toHaveLength(24)
    const firstAt = Date.parse(body.forecast_next_24h[0].starts_at)
    expect(firstAt).toBe(Math.floor(Date.now() / 3_600_000) * 3_600_000)
  })
