#!/usr/bin/env bun
import { budgetFrom, clientFrom, readConfig } from "./config.ts"
import { serveHttp, serveStdio } from "./server.ts"

const config = readConfig(process.env)
const budget = budgetFrom(config)
const op = clientFrom(config, budget)

if (process.argv.includes("--http")) {
  const server = serveHttp(op, { host: config.OFFPEAK_MCP_HOST, port: config.OFFPEAK_MCP_PORT, token: config.OFFPEAK_MCP_TOKEN }, budget)
  // stdout belongs to the protocol on stdio, so both transports log to stderr.
  console.error(JSON.stringify({ service: "mcp", event: "listening", host: server.hostname, port: server.port }))
} else {
  await serveStdio(op, budget)
}
