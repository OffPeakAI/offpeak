import { timingSafeEqual } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { Offpeak } from "@offpeak/sdk"
import { Budget } from "./budget.ts"
import { registerComplete } from "./tools/complete.ts"
import { registerPrices } from "./tools/prices.ts"
import { registerScheduleJob } from "./tools/schedule-job.ts"
import { registerUsage } from "./tools/usage.ts"

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])
const MCP_PATH = "/mcp"

export function createMcp(op: Offpeak, budget = new Budget()) {
  const server = new McpServer({ name: "offpeak", version: "0.1.0" })
  registerComplete(server, op, budget)
  registerPrices(server, op)
  registerScheduleJob(server, op, budget)
  registerUsage(server, op)
  return server
}

export async function serveStdio(op: Offpeak, budget?: Budget) {
  await createMcp(op, budget).connect(new StdioServerTransport())
}

function tokenMatches(req: Request, token: string) {
  const sent = Buffer.from(req.headers.get("authorization") ?? "")
  const wanted = Buffer.from(`Bearer ${token}`)
  return sent.length === wanted.length && timingSafeEqual(sent, wanted)
}

/** A page in a browser can reach a local port, so a loopback server still checks who is asking. */
function fromThisMachine(req: Request, port: number) {
  const names = [...LOOPBACK].map((name) => `${name}:${port}`)
  const host = req.headers.get("host") ?? ""
  const origin = req.headers.get("origin")
  return names.includes(host) && (origin === null || names.some((name) => origin === `http://${name}` || origin === `https://${name}`))
}

export type HttpOptions = { host: string; port: number; token?: string }

/**
 * Whoever reaches this server can spend through it, so it stays on this machine unless a token guards it.
 * The server keeps no sessions: each request gets its own transport, and all share one client and its channel.
 */
export function serveHttp(op: Offpeak, opts: HttpOptions, budget = new Budget()) {
  const loopback = LOOPBACK.has(opts.host)
  if (!loopback && !opts.token) throw new Error("Set OFFPEAK_MCP_TOKEN to listen beyond this machine")
  return Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== MCP_PATH) return new Response(null, { status: 404 })
      if (loopback && !fromThisMachine(req, opts.port)) return new Response(null, { status: 403 })
      if (opts.token && !tokenMatches(req, opts.token)) return new Response(null, { status: 401 })
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      const server = createMcp(op, budget)
      await server.connect(transport)
      const res = await transport.handleRequest(req)
      void server.close().catch(() => undefined)
      return res
    },
  })
}
