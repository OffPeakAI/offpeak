import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import type { Db } from "@offpeak/common"
import { z } from "zod"
import type { Stack } from "../context.ts"

const PROBE_TIMEOUT_MS = 2_000
const RESOLVED_TTL_MS = 30_000
const RESOLVED_MAX = 1024
const ENDPOINT_MAX_LENGTH = 512

type Subnet = [address: string, prefix: number, family: "ipv4" | "ipv6"]

const LINK_LOCAL: Subnet[] = [
  ["169.254.0.0", 16, "ipv4"],
  ["fe80::", 10, "ipv6"],
]
const NOT_PUBLIC: Subnet[] = [
  ...LINK_LOCAL,
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["224.0.0.0", 3, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["ff00::", 8, "ipv6"],
]

function blockList(rows: Subnet[]) {
  const list = new BlockList()
  for (const [address, prefix, family] of rows) list.addSubnet(address, prefix, family)
  return list
}

const linkLocal = blockList(LINK_LOCAL)
const notPublic = blockList(NOT_PUBLIC)

/** Cloud metadata sits on link-local addresses, so those are shut everywhere. Local runs need the rest. */
function addressAllowed(address: string, production: boolean) {
  return !(production ? notPublic : linkLocal).check(address, isIP(address) === 6 ? "ipv6" : "ipv4")
}

const bareHost = (hostname: string) => hostname.replace(/^\[|\]$/g, "")

const hostInfo = z.object({
  operator: z.string(),
  modelDigests: z.array(z.string()),
  nightJobModels: z.array(z.string()).default([]),
})

/** Endpoints are not on chain, only their hash, so registration stores them here. */
export async function saveEndpoint(db: Db, host: string, endpoint: string) {
  await db.query(
    `INSERT INTO serving.hosts_cache (address, endpoint, status, routable, bond_usdg, gpu_class, image_digest)
     VALUES ($1,$2,0,false,0,'','') ON CONFLICT (address) DO UPDATE SET endpoint = $2, updated_at = now()`,
    [host.toLowerCase(), endpoint],
  )
}

export async function loadEndpoints(db: Db) {
  const rows = await db.query<{ address: string; endpoint: string }>("SELECT address, endpoint FROM serving.hosts_cache")
  return new Map(rows.rows.map((row) => [row.address, row.endpoint]))
}

/** The host's own account of itself. It must be the registered operator, serving every registered model. */
async function readInfo(stack: Stack, key: string, endpoint: string, registered: string[]) {
  const res = await stack.hosts.request(key, endpoint, "/offpeak/v1/info", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  const info = hostInfo.safeParse(await res.json())
  if (!res.ok || !info.success || info.data.operator.toLowerCase() !== key) return null
  const digests = new Set(info.data.modelDigests.map((digest) => digest.toLowerCase()))
  if (!registered.every((digest) => digests.has(digest.toLowerCase()))) return null
  return new Set(info.data.nightJobModels.map((digest) => digest.toLowerCase()))
}

/** One health pass. A host is routable only while its last probe answered healthy and matched its registration. */
export async function probeHosts(stack: Stack) {
  const hosts = await stack.indexer.hostList()
  stack.candidateCache.clear()
  await Promise.all(
    hosts.map(async (host) => {
      const key = host.operator.toLowerCase()
      if (!host.endpoint) {
        stack.probesOk.delete(key)
        return
      }
      try {
        const res = await stack.hosts.request(key, host.endpoint, "/offpeak/v1/health", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        const health = (await res.json()) as { ok?: boolean }
        const nightModels = res.ok && health.ok !== false ? await readInfo(stack, key, host.endpoint, host.models.map((row) => row.digest)) : null
        if (nightModels) {
          stack.probesOk.add(key)
          stack.nightModels?.set(key, nightModels)
        } else stack.probesOk.delete(key)
      } catch {
        stack.probesOk.delete(key)
      }
    }),
  )
}

/** Hosts sit behind TLS in production. Local runs reach them over plain HTTP. */
export function endpointAllowed(endpoint: string, production: boolean) {
  if (endpoint.length > ENDPOINT_MAX_LENGTH) return false
  try {
    const url = new URL(endpoint)
    if (url.username || url.password || url.search || url.hash) return false
    const host = bareHost(url.hostname)
    if (isIP(host) && !addressAllowed(host, production)) return false
    return production ? url.protocol === "https:" : url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

export type Resolve = (host: string) => Promise<string[]>

const resolveAll: Resolve = async (host) => (await lookup(host, { all: true })).map((row) => row.address)
const resolved = new Map<string, { ok: boolean; at: number }>()

/** A name can point anywhere after registration, so it is checked when used. Requests come too fast to look it up each time. */
async function hostnameAllowed(hostname: string, production: boolean, resolve: Resolve) {
  const host = bareHost(hostname)
  if (isIP(host)) return addressAllowed(host, production)
  const known = resolved.get(host)
  if (known && performance.now() - known.at < RESOLVED_TTL_MS) return known.ok
  const ok = (await resolve(host)).every((address) => addressAllowed(address, production))
  if (resolved.size >= RESOLVED_MAX) resolved.clear()
  resolved.set(host, { ok, at: performance.now() })
  return ok
}

/**
 * Every request to a host. A host names its own endpoint and writes its own replies, so neither may send the
 * router somewhere private. A name that changes between this check and the connection is out of its reach.
 */
export async function hostFetch(production: boolean, endpoint: string, path: string, init?: RequestInit, resolve: Resolve = resolveAll) {
  const url = new URL(`${endpoint}${path}`)
  if (!(await hostnameAllowed(url.hostname, production, resolve))) throw new Error("host endpoint is not allowed")
  return fetch(url, { ...init, redirect: "error" })
}
