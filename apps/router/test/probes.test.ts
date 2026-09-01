import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { probeHosts } from "../src/routing/probes.ts"
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
