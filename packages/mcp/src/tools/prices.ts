import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { OffpeakError, microToUsd, type Offpeak } from "@offpeak/sdk"
import { hourIndex, hourStart } from "@offpeak/shared"
import { z } from "zod"
import { tool } from "./result.ts"

const FORECAST_HOURS = 24

const pair = z.object({ in: z.string().regex(/^\d+$/), out: z.string().regex(/^\d+$/) })

const board = z.object({
  model: z.string(),
  digest: z.string().optional(),
  now: z.object({ in: z.string().regex(/^\d+$/), out: z.string().regex(/^\d+$/), host: z.string() }).optional(),
  hosts: z.array(z.looseObject({ host: z.string(), live: pair })),
  next168h: z.array(z.object({ hour: z.number().int(), forecast_in: z.string().regex(/^\d+$/), forecast_out: z.string().regex(/^\d+$/) })).optional(),
})

type Board = z.output<typeof board>

const models = z.object({ data: z.array(z.looseObject({ id: z.string() })) })

const shown = (micro: string) => ({ micro_per_m: micro, usd_per_m: microToUsd(BigInt(micro)) })

/** Lowest input price, then output, the order the router ranks hosts in. */
function cheapest(hosts: Board["hosts"]) {
  const rank = (host: Board["hosts"][number]) => [BigInt(host.live.in), BigInt(host.live.out)] as const
  return hosts.reduce<Board["hosts"][number] | undefined>((best, host) => {
    if (!best) return host
    const [bestIn, bestOut] = rank(best)
    const [hostIn, hostOut] = rank(host)
    return hostIn < bestIn || (hostIn === bestIn && hostOut < bestOut) ? host : best
  }, undefined)
}

/** The next hours from now. The router keys rows by absolute hour, from the current one. */
export function nextHours(rows: NonNullable<Board["next168h"]>, now: number, count = FORECAST_HOURS) {
  const start = hourIndex(now)
  return Array.from({ length: count }, (_, offset) => {
    const row = rows.find((candidate) => candidate.hour === start + offset)
    return row && { starts_at: new Date(hourStart(start + offset) * 1000).toISOString(), in: shown(row.forecast_in), out: shown(row.forecast_out) }
  }).filter((row) => row !== undefined)
}

async function boardFor(op: Offpeak, model: string) {
  const row = await op.request(`/v1/prices?model=${encodeURIComponent(model)}`, board)
  if (!row.now) throw new OffpeakError("model_not_found", `No live price for ${model}`)
  const best = cheapest(row.hosts)
  return {
    model: row.model,
    live: { in: shown(row.now.in), out: shown(row.now.out) },
    cheapest_host: best && { host: best.host, in: shown(best.live.in), out: shown(best.live.out) },
    forecast_next_24h: nextHours(row.next168h ?? [], Math.floor(Date.now() / 1000)),
  }
}

export function registerPrices(server: McpServer, op: Offpeak) {
  server.registerTool(
    "offpeak_prices",
    {
      description:
        "Show the live price per 1M tokens, fee included, the cheapest host, and the next 24 hours of the forecast. Prices move, and a forecast is not a quote. " +
        "Leave model out to see every model.",
      inputSchema: { model: z.string().min(1).optional() },
    },
    tool(async ({ model }: { model?: string }) => {
      if (model) return boardFor(op, model)
      const { data } = await op.request("/v1/models", models)
      return { models: await Promise.all(data.map((row) => boardFor(op, row.id))) }
    }),
  )
}
