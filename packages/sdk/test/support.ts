import type { Hono } from "hono"
import { keccak256, toBytes, type Hex, type PublicClient } from "viem"
import { bootStack } from "../../../apps/router/test/support/stack.ts"
import { roleAccount } from "../../shared/src/test-keys.ts"
import { Offpeak, type OffpeakOptions } from "../src/index.ts"

export const BASE = "http://router.test"
export const buyerAccount = roleAccount("buyer")

export type Booted = Awaited<ReturnType<typeof bootStack>>

/** A real router on mocks, its clock on wall time, because channel proofs carry wall time. */
export async function bootRouter(opts?: Parameters<typeof bootStack>[0]): Promise<Booted> {
  const booted = await bootStack(opts)
  booted.stack.setClock(Math.floor(Date.now() / 1000))
  return booted
}

export const inProcess = (app: Hono) => ((input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch

let channels = 0

export function addChannel(booted: Booted, deposit: bigint, payer: string = booted.buyer) {
  const id = keccak256(toBytes(`sdk-channel-${channels++}`))
  booted.indexer.channels.set(id, {
    payer: payer as Hex,
    deposit,
    claimed: 0n,
    lastSeq: 0n,
    expiry: BigInt(booted.stack.clock() + 86_400),
    challengeEndsAt: 0n,
    status: 1,
    closeRequested: false,
  })
  return id
}

/** The chain as the mock indexer has it: channels and registered hosts, read the way the SDK reads them. */
export function chainView(booted: Booted) {
  const readContract = async ({ functionName, args }: { functionName: string; args: [string] }) => {
    if (functionName === "channelView") {
      const channel = booted.indexer.channels.get(args[0] as Hex)
      return channel ?? { payer: `0x${"00".repeat(20)}`, deposit: 0n, claimed: 0n, lastSeq: 0n, expiry: 0n, challengeEndsAt: 0n, status: 0 }
    }
    const host = booted.indexer.hosts.get(args[0].toLowerCase() as Hex)
    if (functionName === "hostView") return host ?? { status: 0 }
    if (functionName === "modelsOf") return (host?.models ?? []).map((model) => model.digest)
    throw new Error(`no stub for ${functionName}`)
  }
  return { readContract } as unknown as PublicClient
}

export function client(booted: Booted, opts: Partial<OffpeakOptions> = {}) {
  return new Offpeak({ baseURL: BASE, wallet: buyerAccount, deployment: "local", fetch: inProcess(booted.app), publicClient: chainView(booted), ...opts })
}

export const ask = (content: string, max_tokens = 8) => ({ model: "ofm-8b", messages: [{ role: "user", content }], max_tokens })

export async function channelRow(booted: Booted, id: Hex) {
  const rows = await booted.stack.db.query<{ latest_seq: string; cumulative: string }>("SELECT latest_seq, cumulative FROM shared.channel_state WHERE channel_id = $1", [id])
  const row = rows.rows[0]
  return row ? { seq: BigInt(row.latest_seq), cumulative: BigInt(row.cumulative) } : null
}

export const costOf = (env: { record: { hostCostMicro: bigint; feeMicro: bigint } }) => env.record.hostCostMicro + env.record.feeMicro

export async function until(check: () => Promise<boolean>, what: string, ms = 5_000) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}
