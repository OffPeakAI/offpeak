import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { channelManagerAbi, hostRegistryAbi, vaultAbi, windowMarketAbi, auditCourtAbi } from "@offpeak/abis"
import { BETA_CAP_PER_BUYER_MICRO, HOST_MIN_BOND, HOST_STATUS, canonicalJson, hourIndex, leafFor, parseRecord, windowResaleFeeMicro, type Hex } from "@offpeak/shared"
import { Hono } from "hono"
import { decodeFunctionData, encodeAbiParameters, erc20Abi, keccak256, toBytes } from "viem"
import { createSiweMessage } from "viem/siwe"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { appRouter } from "../src/trpc/router.ts"
import { mountWeb } from "../src/web.ts"
import { bootStack } from "./support/stack.ts"

const OTHER = "0x00000000000000000000000000000000000000aa"
const CHANNEL = `0x${"c1".repeat(32)}` as Hex

type Booted = Awaited<ReturnType<typeof bootStack>>

async function sessionFor(booted: Booted, wallet: string, id = `sess_${wallet.slice(2, 12)}`, ttl = 2_592_000) {
  await booted.stack.db.query("INSERT INTO serving.siwe_sessions (id, wallet, nonce, expires_at) VALUES ($1, $2, '', to_timestamp($3))", [id, wallet, booted.stack.clock() + ttl])
  return id
}

const auth = (session?: string): Record<string, string> => (session ? { authorization: `Bearer ${session}` } : {})

async function read(res: Response) {
  const body = (await res.json()) as { result?: { data: unknown }; error?: { message: string; data: { code: string; httpStatus: number } } }
  return { status: res.status, data: body.result?.data as unknown, error: body.error }
}

function query(booted: Booted, path: string, input?: unknown, session?: string) {
  const suffix = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`
  return Promise.resolve(booted.app.request(`/trpc/${path}${suffix}`, { headers: auth(session) })).then(read)
}

function mutate(booted: Booted, path: string, input?: unknown, session?: string) {
  return Promise.resolve(
    booted.app.request(`/trpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(session) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }),
  ).then(read)
}

async function chat(booted: Booted) {
  const res = await booted.app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${booted.key.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "ofm-8b", messages: [{ role: "user", content: "hello" }] }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { offpeak_usage: { record: { reqId: Hex } } }
}

function openChannel(booted: Booted, payer: string, status: 1 | 2 = 1) {
  booted.indexer.channels.set(CHANNEL, {
    payer: payer as Hex,
    deposit: 10_000_000n,
    claimed: 1_000_000n,
    lastSeq: 3n,
    expiry: BigInt(booted.stack.clock() + 86_400),
    challengeEndsAt: status === 2 ? BigInt(booted.stack.clock() + 100) : 0n,
    status,
    closeRequested: status === 2,
  })
}

function addWindow(booted: Booted, overrides: { t0?: number; t1?: number; failed?: boolean } = {}) {
  const now = booted.stack.clock()
  booted.indexer.windows.set("7", {
    id: 7n,
    host: booted.host as Hex,
    modelDigest: booted.modelDigest,
    t0: BigInt(overrides.t0 ?? now + 3_600),
    t1: BigInt(overrides.t1 ?? now + 7_200),
    minTps: 50,
    units: 100n,
    hostPricePerUnit: 200_000n,
    buyerPricePerUnit: 208_000n,
    failed: overrides.failed ?? false,
  })
}

/** Every object key an input schema accepts, nested ones included. */
function inputKeys(schema: unknown, out = new Set<string>()): Set<string> {
  const node = schema as { shape?: Record<string, unknown>; def?: Record<string, unknown>; _zod?: { def: Record<string, unknown> } } | undefined
  if (!node || typeof node !== "object") return out
  for (const [key, value] of Object.entries(node.shape ?? {})) {
    out.add(key)
    inputKeys(value, out)
  }
  const def = node._zod?.def ?? node.def
  if (def) for (const link of ["element", "innerType", "in", "out"]) inputKeys(def[link], out)
  return out
}

const PUBLIC = ["account.network", "hosts.board", "hosts.list", "windows.board", "windows.list"]

describe("session wallets only", () => {
  const procedures = Object.entries(appRouter._def.procedures) as unknown as [string, { _def: { inputs: unknown[]; type: string } }][]

  test("the router has every namespace in the doc", () => {
    const names = new Set(procedures.map(([path]) => path.split(".")[0]))
    expect([...names].sort()).toEqual(["account", "channels", "disputes", "hosts", "keys", "usage", "windows"])
  })

  test("no procedure accepts a wallet as input", () => {
    const seen: string[] = []
    for (const [path, procedure] of procedures) {
      for (const schema of procedure._def.inputs) for (const key of inputKeys(schema)) seen.push(`${path}:${key}`)
    }
    expect(seen.length).toBeGreaterThan(20)
    expect(seen.filter((entry) => /^(wallet|address|payer|buyer|owner|holder|seller|operator|account|from|host)$/i.test(entry.split(":")[1]!))).toEqual([])
  })

  test("the input walk sees nested keys, so the check above cannot pass by accident", () => {
    const keys = [...inputKeys(procedures.find(([path]) => path === "hosts.registerPlan")![1]._def.inputs[0])]
    expect(keys).toContain("maxTps")
    expect(keys).toContain("endpoint")
  })

  test("every procedure outside the public list refuses a caller with no session", async () => {
    const booted = await bootStack()
    const checked: string[] = []
    for (const [path, procedure] of procedures) {
      if (PUBLIC.includes(path)) continue
      const res = procedure._def.type === "query" ? await query(booted, path) : await mutate(booted, path, {})
      expect([path, res.status]).toEqual([path, 401])
      checked.push(path)
    }
    expect(checked.length).toBeGreaterThan(30)
    const expired = await sessionFor(booted, booted.buyer, "sess_old", 600)
    booted.stack.setClock(booted.stack.clock() + 601)
    expect((await query(booted, "account.summary", undefined, expired)).status).toBe(401)
  })

  test("a wallet slipped into an input is refused, not ignored", async () => {
    const booted = await bootStack()
    const session = await sessionFor(booted, booted.buyer)
    expect((await mutate(booted, "keys.create", { label: "x", wallet: OTHER }, session)).status).toBe(400)
    expect((await mutate(booted, "account.withdrawTx", { amount: "1", wallet: OTHER }, session)).status).toBe(400)
    expect((await query(booted, "usage.list", { wallet: OTHER }, session)).status).toBe(400)
  })

  test("the wallet comes from the session, whatever else the request says", async () => {
    const booted = await bootStack()
    const mine = await sessionFor(booted, booted.buyer)
    const theirs = await sessionFor(booted, OTHER)
    expect(((await query(booted, "account.summary", undefined, mine)).data as { wallet: string }).wallet).toBe(booted.buyer)
    expect(((await query(booted, "account.summary", undefined, theirs)).data as { wallet: string }).wallet).toBe(OTHER)
    const sent = (await mutate(booted, "account.executeWithdrawAllTx", undefined, mine)).data as { data: Hex }
    expect(decodeFunctionData({ abi: vaultAbi, data: sent.data }).args?.[0]?.toString().toLowerCase()).toBe(booted.buyer as never)
  })

  test("a real Sign-In with Ethereum login opens a session and sign out ends it", async () => {
    const booted = await bootStack()
    booted.stack.siweDomain = "offpeak.test"
    const account = roleAccount("buyer")
    const post = (path: string, body: unknown) => booted.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const { nonce } = await (await post("/v1/auth/nonce", { wallet: account.address })).json()
    const message = createSiweMessage({ address: account.address, chainId: 4663, domain: "offpeak.test", nonce, uri: "https://offpeak.test", version: "1", issuedAt: new Date(booted.stack.clock() * 1000) })
    const signature = await account.signMessage({ message })
    const login = await post("/v1/auth/login", { message, signature })
    expect(login.status).toBe(200)
    const { session, wallet } = await login.json()
    expect(wallet).toBe(booted.buyer)
    expect((await query(booted, "account.summary", undefined, session)).status).toBe(200)
    expect((await mutate(booted, "account.signOut", undefined, session)).status).toBe(200)
    expect((await query(booted, "account.summary", undefined, session)).status).toBe(401)
    expect((await post("/v1/auth/login", { message, signature })).status).toBe(401)
  })
})

describe("account", () => {
  test("withdrawable is balance minus reserve, as exact integers", async () => {
    const booted = await bootStack()
    booted.indexer.buyers.get(booted.buyer)!.reserve = 123_456_789n
    const session = await sessionFor(booted, booted.buyer)
    const { data } = await query(booted, "account.summary", undefined, session)
    expect(data).toMatchObject({ balance: "1000000000", reserve: "123456789", withdrawable: "876543211", feeBps: 400, auditOptIn: false, betaCap: BETA_CAP_PER_BUYER_MICRO.toString() })
  })

  test("the withdraw transaction refuses more than the withdrawable balance", async () => {
    const booted = await bootStack()
    booted.indexer.buyers.get(booted.buyer)!.reserve = 400_000_000n
    const session = await sessionFor(booted, booted.buyer)
    const over = await mutate(booted, "account.withdrawTx", { amount: "600000001" }, session)
    expect(over.error?.message).toBe("exceeds_withdrawable")
    const fine = (await mutate(booted, "account.withdrawTx", { amount: "600000000" }, session)).data as { data: Hex; to: string; value: string; chainId: number }
    expect(fine).toMatchObject({ to: booted.stack.vault, value: "0", chainId: 4663 })
    const decoded = decodeFunctionData({ abi: vaultAbi, data: fine.data })
    expect(decoded.functionName).toBe("withdraw")
    expect(decoded.args).toEqual([600_000_000n])
  })

  test("an approve deposit is the exact amount, for the vault", async () => {
    const booted = await bootStack()
    booted.indexer.buyers.get(booted.buyer)!.balance = 0n
    const session = await sessionFor(booted, booted.buyer)
    const plan = (await mutate(booted, "account.depositPlan", { amount: "12340000", mode: "approve" }, session)).data as { approval: { spender: string; tx: { to: string; data: Hex } }; tx: { to: string; data: Hex } }
    expect(plan.approval.tx.to).toBe(booted.stack.usdg)
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.approval.tx.data }).args).toEqual([booted.stack.vault as Hex, 12_340_000n])
    expect(decodeFunctionData({ abi: vaultAbi, data: plan.tx.data }).args).toEqual([12_340_000n])
  })
