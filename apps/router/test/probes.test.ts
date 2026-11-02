import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { endpointAllowed, hostFetch, probeHosts } from "../src/routing/probes.ts"
import { bootStack } from "./support/stack.ts"

type Booted = Awaited<ReturnType<typeof bootStack>>

const answer = (booted: Booted, info: Record<string, unknown>) => {
  const app = new Hono()
  app.get("/offpeak/v1/health", (c) => c.json({ ok: true }))
  app.get("/offpeak/v1/info", (c) => c.json(info))
  booted.hostApps.set(booted.host, app)
  booted.stack.nightModels = new Map()
}

describe("host probes", () => {
  test("a host matching its registration is routable, with its night job models", async () => {
    const booted = await bootStack()
    answer(booted, { operator: booted.host, modelDigests: [booted.modelDigest], nightJobModels: [booted.modelDigest] })
    await probeHosts(booted.stack)
    expect(booted.stack.probesOk.has(booted.host.toLowerCase())).toBe(true)
    expect(booted.stack.nightModels!.get(booted.host.toLowerCase())!.has(booted.modelDigest.toLowerCase())).toBe(true)
  })

  test("another operator at the endpoint is not routable", async () => {
    const booted = await bootStack()
    answer(booted, { operator: `0x${"ab".repeat(20)}`, modelDigests: [booted.modelDigest] })
    await probeHosts(booted.stack)
    expect(booted.stack.probesOk.has(booted.host.toLowerCase())).toBe(false)
  })

  test("a host missing a registered model is not routable", async () => {
    const booted = await bootStack()
    answer(booted, { operator: booted.host, modelDigests: [`0x${"12".repeat(32)}`] })
    await probeHosts(booted.stack)
    expect(booted.stack.probesOk.has(booted.host.toLowerCase())).toBe(false)
  })

  test("a host whose info cannot be read is not routable", async () => {
    const booted = await bootStack()
    answer(booted, { nonsense: true })
    await probeHosts(booted.stack)
    expect(booted.stack.probesOk.has(booted.host.toLowerCase())).toBe(false)
  })
})

describe("host endpoints", () => {
  const privateHosts = ["127.0.0.1", "10.0.0.8", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "[::1]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[::ffff:169.254.169.254]", "2130706433", "0x7f.0.0.1"]

  test("production refuses private and metadata addresses, however they are written", () => {
    for (const host of privateHosts) expect(endpointAllowed(`https://${host}`, true)).toBe(false)
    expect(endpointAllowed("https://8.8.8.8", true)).toBe(true)
    expect(endpointAllowed("https://host.example.com", true)).toBe(true)
  })

  test("local runs keep their private hosts, but never cloud metadata", () => {
    expect(endpointAllowed("http://127.0.0.1:8100", false)).toBe(true)
    expect(endpointAllowed("http://169.254.169.254", false)).toBe(false)
    expect(endpointAllowed("http://[fe80::1]", false)).toBe(false)
  })

  function recordFetch() {
    const real = globalThis.fetch
    const seen: { url: string; redirect?: string }[] = []
    globalThis.fetch = (async (url: URL, init?: RequestInit) => {
      seen.push({ url: String(url), redirect: init?.redirect })
      return new Response("{}")
    }) as typeof fetch
    return { seen, restore: () => (globalThis.fetch = real) }
  }

  test("a name that resolves to a private address never gets a request", async () => {
    const net = recordFetch()
    try {
      await expect(hostFetch(true, "https://rebound.example.com", "/offpeak/v1/health", undefined, async () => ["8.8.8.8", "169.254.169.254"])).rejects.toThrow("not allowed")
      await expect(hostFetch(true, "https://[::ffff:a00:1]", "/offpeak/v1/health")).rejects.toThrow("not allowed")
      expect(net.seen.length).toBe(0)
    } finally {
      net.restore()
    }
  })

  test("a public host is fetched, and is not allowed to redirect", async () => {
    const net = recordFetch()
    try {
      await hostFetch(true, "https://public.example.com", "/offpeak/v1/health", undefined, async () => ["8.8.8.8"])
      expect(net.seen).toEqual([{ url: "https://public.example.com/offpeak/v1/health", redirect: "error" }])
    } finally {
      net.restore()
    }
  })
})
