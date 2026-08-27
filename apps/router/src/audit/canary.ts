import { HOST_STATUS, type ChainReader, type HostChain } from "@offpeak/shared"
import { z } from "zod"
import type { Stack } from "../context.ts"
import { oai } from "../http.ts"
import { serveChat } from "../pipeline.ts"

const hostHeader = z.string().regex(/^0x[0-9a-f]{40}$/)

/** Hosts a canary may reach. Probation hosts count: canaries are the only traffic they get. */
const auditable = (host: HostChain) => host.status === HOST_STATUS.Active || host.status === HOST_STATUS.Probation

/** The one host a canary is aimed at, shown to routing as a plain active host. */
function pinnedChain(chain: ChainReader, target: HostChain): ChainReader {
  return {
    buyer: (addr, now) => chain.buyer(addr, now),
    hostList: async () => [{ ...target, status: HOST_STATUS.Active, routable: true }],
    host: (addr) => chain.host(addr),
    channel: (id) => chain.channel(id),
    escrow: (reqId) => chain.escrow(reqId),
    window: (id) => chain.window(id),
    windowList: () => chain.windowList(),
    holder: (id, addr) => chain.holder(id, addr),
    ofpkOf: (addr) => chain.ofpkOf(addr),
    proof: (reqId) => chain.proof(reqId),
    subscribe: (fn) => chain.subscribe(fn),
  }
}

/**
 * Runs a canary down the ordinary chat path, aimed at one host so each host gets its own rate.
 * The aim lives in this router process and on this internal route only: the host receives the
 * same signed body and headers as any other request, from the same code.
 */
export async function serveCanary(stack: Stack, req: Request): Promise<Response> {
  const parsed = hostHeader.safeParse(req.headers.get("x-offpeak-canary-host"))
  if (!parsed.success) return oai(400, "Bad host", "invalid_request", "bad_host")
  const target = (await stack.indexer.hostList()).find((host) => host.operator.toLowerCase() === parsed.data)
  if (!target || !auditable(target)) return oai(409, "Host is not auditable", "invalid_request", "host_not_auditable")
  const headers = new Headers(req.headers)
  headers.delete("x-offpeak-canary-host")
  headers.delete("x-offpeak-internal")
  const plain = new Request(req.url, { method: "POST", headers, body: await req.text() })
  return serveChat({ ...stack, indexer: pinnedChain(stack.indexer, target), candidateCache: new Map() }, plain)
}
