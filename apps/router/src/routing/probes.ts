import type { Db } from "@offpeak/common"
import { z } from "zod"
import type { Stack } from "../context.ts"

const PROBE_TIMEOUT_MS = 2_000

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
  try {
    const url = new URL(endpoint)
    if (url.username || url.password || url.search || url.hash) return false
    return production ? url.protocol === "https:" : url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}
