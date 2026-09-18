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

  test("a Permit2 deposit signs for the vault and spends the signed amount", async () => {
    const booted = await bootStack()
    booted.indexer.buyers.get(booted.buyer)!.balance = 0n
    const session = await sessionFor(booted, booted.buyer)
    const plan = (await mutate(booted, "account.depositPlan", { amount: "5000000", mode: "permit2" }, session)).data as {
      approval: { spender: string }
      permit: { domain: { name: string; verifyingContract: string }; message: { nonce: string; deadline: string; spender: string; permitted: { token: string; amount: string } }; types: Record<string, unknown> }
    }
    expect(plan.approval.spender).toBe(booted.stack.permit2)
    expect(plan.permit.domain.name).toBe("Permit2")
    expect(plan.permit.message.spender).toBe(booted.stack.vault)
    expect(plan.permit.message.permitted).toEqual({ token: booted.stack.usdg, amount: "5000000" })
    const sig = await roleAccount("buyer").signTypedData({ domain: plan.permit.domain, types: plan.permit.types, primaryType: "PermitTransferFrom", message: plan.permit.message } as never)
    const sent = (await mutate(booted, "account.depositPermit2Tx", { amount: "5000000", nonce: plan.permit.message.nonce, deadline: plan.permit.message.deadline, sig }, session)).data as { data: Hex }
    const decoded = decodeFunctionData({ abi: vaultAbi, data: sent.data })
    expect(decoded.functionName).toBe("depositWithPermit2")
    expect((decoded.args?.[0] as { permitted: { amount: bigint } }).permitted.amount).toBe(5_000_000n)
  })

  test("deposits that the vault would revert are refused first", async () => {
    const booted = await bootStack()
    const buyer = booted.indexer.buyers.get(booted.buyer)!
    buyer.balance = BETA_CAP_PER_BUYER_MICRO
    const session = await sessionFor(booted, booted.buyer)
    expect((await mutate(booted, "account.depositPlan", { amount: "1", mode: "approve" }, session)).error?.message).toBe("beta_cap")
    buyer.balance = 0n
    buyer.withdrawRequestedAt = 5n
    expect((await mutate(booted, "account.depositPlan", { amount: "1", mode: "permit2" }, session)).error?.message).toBe("withdraw_pending")
  })

  test("the audit opt-in sets the 1% lower fee and survives making a new key", async () => {
    const booted = await bootStack()
    const session = await sessionFor(booted, booted.buyer)
    await mutate(booted, "account.setAuditOptIn", { optIn: true }, session)
    expect((await query(booted, "account.summary", undefined, session)).data).toMatchObject({ auditOptIn: true, feeBps: 296 })
    await mutate(booted, "keys.create", { label: "second" }, session)
    expect((await query(booted, "account.summary", undefined, session)).data).toMatchObject({ auditOptIn: true, feeBps: 296 })
  })

  test("no transaction is built for a contract that is not deployed", async () => {
    const booted = await bootStack()
    booted.stack.vault = `0x${"0".repeat(40)}`
    const session = await sessionFor(booted, booted.buyer)
    const res = await mutate(booted, "account.requestWithdrawAllTx", undefined, session)
    expect(res.status).toBe(412)
    expect(res.error?.message).toBe("contract_not_deployed")
    expect(((await query(booted, "account.network")).data as { deployed: boolean }).deployed).toBe(false)
  })

  test("a failure inside a procedure shows no detail", async () => {
    const booted = await bootStack()
    booted.stack.indexer.buyer = async () => {
      throw new Error("secret-indexer-url")
    }
    const session = await sessionFor(booted, booted.buyer)
    const res = await query(booted, "account.summary", undefined, session)
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.error)).not.toContain("secret-indexer-url")
  })
})

describe("keys", () => {
  test("a key is shown once, works, and stops working when revoked", async () => {
    const booted = await bootStack()
    const session = await sessionFor(booted, booted.buyer)
    const made = (await mutate(booted, "keys.create", { label: "build box" }, session)).data as { token: string }
    expect(made.token).toStartWith("op_live_")
    const listed = (await query(booted, "keys.list", undefined, session)).data as { id: string; label: string; token?: string }[]
    const row = listed.find((key) => key.label === "build box")!
    expect(JSON.stringify(listed)).not.toContain(made.token)
    expect((await mutate(booted, "keys.revoke", { id: row.id }, session)).status).toBe(200)
    expect(((await query(booted, "keys.list", undefined, session)).data as unknown[]).length).toBe(listed.length - 1)
  })

  test("another wallet cannot revoke a key", async () => {
    const booted = await bootStack()
    const mine = await sessionFor(booted, booted.buyer)
    const theirs = await sessionFor(booted, OTHER)
    const [row] = (await query(booted, "keys.list", undefined, mine)).data as { id: string }[]
    expect((await mutate(booted, "keys.revoke", { id: row!.id }, theirs)).status).toBe(404)
    expect(((await query(booted, "keys.list", undefined, mine)).data as unknown[]).length).toBe(1)
  })
})

describe("usage", () => {
  test("the list carries a full record whose leaf recomputes", async () => {
    const booted = await bootStack()
    const { offpeak_usage: envelope } = await chat(booted)
    const session = await sessionFor(booted, booted.buyer)
    const { data } = await query(booted, "usage.list", {}, session)
    const { rows } = data as { rows: { record: Parameters<typeof parseRecord>[0]; routerSig: Hex; hostSig: Hex; leaf: Hex; feeBps: number; model: string }[] }
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.record.reqId).toBe(envelope.record.reqId)
    expect(row.model).toBe("ofm-8b")
    expect(row.feeBps).toBe(400)
    expect(leafFor(parseRecord(row.record), row.routerSig, row.hostSig)).toBe(row.leaf)
  })

  test("one record reports no proof until settled, and the proof after", async () => {
    const booted = await bootStack()
    const { offpeak_usage: envelope } = await chat(booted)
    const reqId = envelope.record.reqId
    const session = await sessionFor(booted, booted.buyer)
    expect(((await query(booted, "usage.get", { reqId }, session)).data as { proof: unknown }).proof).toBeNull()
    booted.indexer.proofs.set(reqId, { hour: 1, leaf: "0x01", proof: [], root: "0x01", txHash: "0x02" })
    expect(((await query(booted, "usage.get", { reqId }, session)).data as { proof: { txHash: string } }).proof.txHash).toBe("0x02")
  })

  test("another wallet sees none of it", async () => {
    const booted = await bootStack()
    const { offpeak_usage: envelope } = await chat(booted)
    const theirs = await sessionFor(booted, OTHER)
    expect(((await query(booted, "usage.list", {}, theirs)).data as { rows: unknown[] }).rows).toEqual([])
    expect((await query(booted, "usage.get", { reqId: envelope.record.reqId }, theirs)).status).toBe(404)
  })

  test("pages do not repeat a record", async () => {
    const booted = await bootStack()
    await chat(booted)
    booted.stack.setClock(booted.stack.clock() + 1)
    await chat(booted)
    const session = await sessionFor(booted, booted.buyer)
    const first = (await query(booted, "usage.list", { limit: 1 }, session)).data as { rows: { record: { ts: number; reqId: string } }[]; more: boolean }
    expect(first.more).toBe(true)
    const row = first.rows[0]!
    const second = (await query(booted, "usage.list", { limit: 1, before: { ts: row.record.ts, reqId: row.record.reqId } }, session)).data as { rows: { record: { reqId: string } }[] }
    expect(second.rows[0]?.record.reqId).not.toBe(row.record.reqId)
  })
})

describe("channels", () => {
  test("a channel is only visible to its payer", async () => {
    const booted = await bootStack()
    openChannel(booted, booted.buyer)
    const mine = await sessionFor(booted, booted.buyer)
    const theirs = await sessionFor(booted, OTHER)
    expect((await query(booted, "channels.get", { id: CHANNEL }, mine)).data).toMatchObject({ deposit: "10000000", claimed: "1000000", status: 1 })
    expect((await query(booted, "channels.get", { id: CHANNEL }, theirs)).status).toBe(404)
    expect((await mutate(booted, "channels.requestCloseTx", { id: CHANNEL }, theirs)).status).toBe(404)
  })

  test("the list finds channels the router has served", async () => {
    const booted = await bootStack()
    openChannel(booted, booted.buyer)
    await booted.stack.db.query("INSERT INTO serving.channels_local (channel_id, payer, unvouchered_micro, last_owed, last_owed_req_ids) VALUES ($1,$2,2500,2500,'{}')", [CHANNEL, booted.buyer])
    const mine = await sessionFor(booted, booted.buyer)
    const rows = (await query(booted, "channels.list", undefined, mine)).data as { id: string; owed: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: CHANNEL, owed: "2500" })
    expect((await query(booted, "channels.list", undefined, await sessionFor(booted, OTHER))).data).toEqual([])
  })

  test("a local row naming the wrong payer shows nothing, because the chain decides", async () => {
    const booted = await bootStack()
    openChannel(booted, booted.buyer)
    await booted.stack.db.query("INSERT INTO serving.channels_local (channel_id, payer, unvouchered_micro, last_owed, last_owed_req_ids) VALUES ($1,$2,0,0,'{}')", [CHANNEL, OTHER])
    expect((await query(booted, "channels.list", undefined, await sessionFor(booted, OTHER))).data).toEqual([])
  })

  test("the channel id binds the session wallet", async () => {
    const booted = await bootStack()
    const session = await sessionFor(booted, booted.buyer)
    const plan = (await mutate(booted, "channels.openPlan", { deposit: "2000000", lifetimeSeconds: 21_600 }, session)).data as { channelId: Hex; tx: { data: Hex }; approval: { spender: string; amount: string } }
    const decoded = decodeFunctionData({ abi: channelManagerAbi, data: plan.tx.data })
    expect(decoded.functionName).toBe("open")
    const [deposit, expiry, salt] = decoded.args as unknown as [bigint, bigint, Hex]
    expect(deposit).toBe(2_000_000n)
    expect(expiry).toBe(BigInt(booted.stack.clock() + 21_600))
    expect(plan.channelId).toBe(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [booted.buyer as Hex, salt])))
    expect(plan.approval).toMatchObject({ spender: booted.stack.channelManager, amount: "2000000" })
  })

  test("the challenge period holds a final close back", async () => {
    const booted = await bootStack()
    openChannel(booted, booted.buyer, 2)
    const session = await sessionFor(booted, booted.buyer)
    expect((await mutate(booted, "channels.finalizeCloseTx", { id: CHANNEL }, session)).error?.message).toBe("challenge_period")
    expect((await mutate(booted, "channels.requestCloseTx", { id: CHANNEL }, session)).error?.message).toBe("channel_not_open")
    booted.stack.setClock(booted.stack.clock() + 100)
    expect((await mutate(booted, "channels.finalizeCloseTx", { id: CHANNEL }, session)).status).toBe(200)
  })

  test("a short channel is refused", async () => {
    const booted = await bootStack()
    const session = await sessionFor(booted, booted.buyer)
    expect((await mutate(booted, "channels.openPlan", { deposit: "2000000", lifetimeSeconds: 3_600 }, session)).status).toBe(400)
    expect((await mutate(booted, "channels.openPlan", { deposit: "1", lifetimeSeconds: 21_600 }, session)).error?.message).toBe("deposit_too_small")
  })

  test("nothing moves while channels are switched off", async () => {
    const booted = await bootStack()
    booted.stack.flags.channels = false
    const session = await sessionFor(booted, booted.buyer)
    const res = await mutate(booted, "channels.openPlan", { deposit: "2000000", lifetimeSeconds: 21_600 }, session)
    expect(res.status).toBe(412)
    expect(res.error?.message).toBe("not_switched_on")
  })
})

describe("windows", () => {
  test("the board carries the live Dutch price", async () => {
    const booted = await bootStack()
    addWindow(booted)
    const { data } = await query(booted, "windows.board")
    expect((data as { windows: unknown[] }).windows[0]).toMatchObject({ id: "7", model: "ofm-8b", buyerPricePerUnit: "208000", hostPricePerUnit: "200000", units: "100" })
  })

  test("buying approves exactly units at the maximum price", async () => {
    const booted = await bootStack()
    addWindow(booted)
    const session = await sessionFor(booted, booted.buyer)
    const plan = (await mutate(booted, "windows.buyPlan", { id: "7", units: "3", maxBuyerPricePerUnit: "208000" }, session)).data as { approval: { amount: string; spender: string }; tx: { data: Hex } }
    expect(plan.approval).toMatchObject({ amount: "624000", spender: booted.stack.windowMarket })
    expect(decodeFunctionData({ abi: windowMarketAbi, data: plan.tx.data }).args).toEqual([7n, 3n, 208_000n])
  })

  test("the resale fee uses the seller's cost basis from the chain", async () => {
    const booted = await bootStack()
    addWindow(booted)
    booted.indexer.holders.set(`7:${booted.buyer}`, { balance: 5n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 208_000n })
    const session = await sessionFor(booted, booted.buyer)
    const sale = (await mutate(booted, "windows.listTx", { id: "7", units: "2", pricePerUnit: "300000" }, session)).data as { feeMicro: string; tx: { data: Hex } }
    expect(sale.feeMicro).toBe("24400")
    expect(sale.feeMicro).toBe(windowResaleFeeMicro(600_000n, 416_000n).toString())
    expect(decodeFunctionData({ abi: windowMarketAbi, data: sale.tx.data }).args).toEqual([7n, 2n, 300_000n])
    expect((await mutate(booted, "windows.listTx", { id: "7", units: "6", pricePerUnit: "300000" }, session)).error?.message).toBe("exceeds_holding")
    expect((await mutate(booted, "windows.listTx", { id: "7", units: "1", pricePerUnit: "300000", costBasis: "1" }, session)).status).toBe(400)
  })

  test("cancel stops at the start and at the holding", async () => {
    const booted = await bootStack()
    addWindow(booted)
    booted.indexer.holders.set(`7:${booted.buyer}`, { balance: 5n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 208_000n })
    const session = await sessionFor(booted, booted.buyer)
    expect((await mutate(booted, "windows.cancelTx", { id: "7", units: "6" }, session)).error?.message).toBe("exceeds_holding")
    expect((await mutate(booted, "windows.cancelTx", { id: "7", units: "5" }, session)).status).toBe(200)
    booted.stack.setClock(booted.stack.clock() + 3_600)
    expect((await mutate(booted, "windows.cancelTx", { id: "7", units: "5" }, session)).error?.message).toBe("window_started")
  })

  test("the claim follows the Window's outcome", async () => {
    const booted = await bootStack()
    const now = booted.stack.clock()
    addWindow(booted, { t0: now - 7_200, t1: now - 3_600, failed: true })
    booted.indexer.holders.set(`7:${booted.buyer}`, { balance: 1n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 208_000n })
    const session = await sessionFor(booted, booted.buyer)
    const failed = (await mutate(booted, "windows.claimTx", { id: "7" }, session)).data as { kind: string; tx: { data: Hex } }
    expect(failed.kind).toBe("failure")
    expect(decodeFunctionData({ abi: windowMarketAbi, data: failed.tx.data }).functionName).toBe("claimFailure")
    addWindow(booted, { t0: now - 7_200, t1: now - 3_600 })
    const expired = (await mutate(booted, "windows.claimTx", { id: "7" }, session)).data as { tx: { data: Hex } }
    expect(decodeFunctionData({ abi: windowMarketAbi, data: expired.tx.data }).functionName).toBe("claimExpired")
    addWindow(booted, { t1: now + 10 })
    expect((await mutate(booted, "windows.claimTx", { id: "7" }, session)).error?.message).toBe("window_not_ended")
  })

  test("holdings belong to the session wallet", async () => {
    const booted = await bootStack()
    addWindow(booted)
    booted.indexer.holders.set(`7:${booted.buyer}`, { balance: 5n, lockedPartial: 0n, drawnTokens: 0n, costBasis: 208_000n })
    expect(((await query(booted, "windows.holdings", undefined, await sessionFor(booted, booted.buyer))).data as { id: string }[])[0]?.id).toBe("7")
    expect((await query(booted, "windows.holdings", undefined, await sessionFor(booted, OTHER))).data).toEqual([])
  })

  test("nothing moves while Windows are switched off", async () => {
    const booted = await bootStack()
    addWindow(booted)
    booted.stack.flags.windows = false
    const session = await sessionFor(booted, booted.buyer)
    expect((await mutate(booted, "windows.buyPlan", { id: "7", units: "1", maxBuyerPricePerUnit: "1" }, session)).status).toBe(412)
    expect((await mutate(booted, "windows.claimTx", { id: "7" }, session)).status).toBe(412)
  })
})

describe("disputes", () => {
  test("a dispute opens on your own record and stays yours", async () => {
    const booted = await bootStack()
    const { offpeak_usage: envelope } = await chat(booted)
    const mine = await sessionFor(booted, booted.buyer)
    const theirs = await sessionFor(booted, OTHER)
    const reqIds = [envelope.record.reqId]
    expect((await mutate(booted, "disputes.open", { reqIds, reason: "count looks high" }, theirs)).error?.message).toBe("unknown_request")
    expect((await mutate(booted, "disputes.open", { reqIds, reason: "count looks high" }, mine)).data).toMatchObject({ status: "decided" })
    expect(((await query(booted, "disputes.list", undefined, mine)).data as unknown[]).length).toBe(1)
    expect((await query(booted, "disputes.list", undefined, theirs)).data).toEqual([])
    booted.stack.setClock(booted.stack.clock() + 604_801)
    expect((await mutate(booted, "disputes.open", { reqIds, reason: "late" }, mine)).error?.message).toBe("dispute_window")
  })
})

describe("hosts", () => {
  test("the board has a row per host and names the cheapest", async () => {
    const booted = await bootStack({ secondHost: true })
    await booted.stack.db.query("INSERT INTO serving.host_stats (host, day, served_tokens, billed_host_micro, base_value_micro, effective_discount_bps) VALUES ($1, to_timestamp($2)::date, 1, 700, 1000, 3000)", [booted.host, booted.stack.clock()])
    const { data } = await query(booted, "hosts.board", { model: "ofm-8b" })
    const board = data as {
      now: { in: string; out: string; host: string }
      hosts: { host: string; live: { in: string }; base: { in: string }; floor: { in: string }; bond: string; status: number; effective_discount_30d_bps: number | null; sealed: boolean }[]
      next168h: { hour: number; forecast_in: string }[]
    }
    expect(board.hosts).toHaveLength(2)
    expect(board.now.host).toBe(booted.host)
    const cheap = board.hosts.find((row) => row.host === booted.host)!
    const dear = board.hosts.find((row) => row.host !== booted.host)!
    expect(cheap).toMatchObject({ bond: "2000000000", status: 2, sealed: false, effective_discount_30d_bps: 3000 })
    expect(cheap.live.in).toBe("104000")
    expect(cheap.base.in).toBe("208000")
    expect(cheap.floor.in).toBe("104000")
    expect(dear.effective_discount_30d_bps).toBeNull()
    expect(board.now.in).toBe(cheap.live.in)
  })

  test("the forecast is the next 168 hours from now, in order", async () => {
    const booted = await bootStack()
    const { data } = await query(booted, "hosts.board", { model: "ofm-8b" })
    const { next168h } = data as { next168h: { hour: number; forecast_in: string }[] }
    const start = hourIndex(booted.stack.clock())
    expect(next168h).toHaveLength(168)
    expect(next168h[0]!.hour).toBe(start)
    expect(next168h[167]!.hour).toBe(start + 167)
    expect(next168h[0]!.forecast_in).toBe("145600")
  })

  test("history moves the forecast off the default load", async () => {
    const booted = await bootStack()
    const start = hourIndex(booted.stack.clock())
    await booted.stack.db.query("INSERT INTO serving.host_load (host, model_digest, ts, util, ttft_p95_ms, inflight, healthy) VALUES ($1,$2,to_timestamp($3),0.8,10,0,true)", [booted.host, booted.modelDigest, (start - 168) * 3_600])
    const { data } = await query(booted, "hosts.board", { model: "ofm-8b" })
    const board = data as { forecastFromHistory: boolean; next168h: { forecast_in: string }[] }
    expect(board.forecastFromHistory).toBe(true)
    expect(board.next168h[0]!.forecast_in).toBe("249600")
    expect(board.next168h[1]!.forecast_in).toBe("145600")
  })

  test("a host outside Active is listed but is not the cheapest", async () => {
    const booted = await bootStack({ secondHost: true })
    booted.indexer.hosts.get(booted.host)!.status = HOST_STATUS.Probation
    const { data } = await query(booted, "hosts.board", { model: "ofm-8b" })
    const board = data as { now: { host: string }; hosts: unknown[] }
    expect(board.hosts).toHaveLength(2)
    expect(board.now.host).not.toBe(booted.host)
  })

  test("an unknown model is a 404, and a model with no sheets is an empty board", async () => {
    const booted = await bootStack()
    expect((await query(booted, "hosts.board", { model: "nope" })).status).toBe(404)
    booted.stack.sheets.length = 0
    expect((await query(booted, "hosts.board", { model: "ofm-8b" })).data).toMatchObject({ now: null, hosts: [], next168h: [] })
  })

  test("payouts and the host view read the session wallet", async () => {
    const booted = await bootStack()
    const row = booted.indexer.hosts.get(booted.host)!
    row.releasableCredits = 7_000_000n
    row.pendingCredits = 3_000_000n
    await chat(booted)
    const session = await sessionFor(booted, booted.host)
    const payouts = (await query(booted, "hosts.payouts", undefined, session)).data as { releasable: string; pending: string; served: { tokens: string; records: number }[] }
    expect(payouts).toMatchObject({ releasable: "7000000", pending: "3000000" })
    expect(payouts.served[0]?.records).toBe(1)
    expect(((await query(booted, "hosts.me", undefined, session)).data as { host: { status: number } }).host.status).toBe(2)
    const stranger = await sessionFor(booted, OTHER)
    expect((await query(booted, "hosts.me", undefined, stranger)).data).toMatchObject({ host: null })
    expect((await query(booted, "hosts.payouts", undefined, stranger)).data).toMatchObject({ releasable: "0", served: [] })
    expect((await mutate(booted, "hosts.withdrawCreditsTx", undefined, stranger)).status).toBe(404)
    const sent = (await mutate(booted, "hosts.withdrawCreditsTx", undefined, session)).data as { to: string }
    expect(sent.to).toBe(booted.stack.registry)
  })

  test("registration binds the session wallet, its signature and the minimum bond", async () => {
    const booted = await bootStack()
    const operator = roleAccount("host")
    const session = await sessionFor(booted, operator.address.toLowerCase())
    const endpoint = "https://host.example"
    const sig = await operator.signMessage({ message: canonicalJson({ endpoint, operator: operator.address.toLowerCase() }) })
    const body = { endpoint, models: [{ digest: booted.modelDigest, maxTps: 100 }], imageDigest: booted.imageDigest, gpuClass: "h100-80g-sxm", bondUsdg: HOST_MIN_BOND.toString(), sig }
    expect((await mutate(booted, "hosts.registerPlan", { ...body, bondUsdg: "1" }, session)).error?.message).toBe("bond_below_minimum")
    const stranger = await sessionFor(booted, OTHER)
    expect((await mutate(booted, "hosts.registerPlan", body, stranger)).error?.message).toBe("bad_signature")
    const plan = (await mutate(booted, "hosts.registerPlan", body, session)).data as { approval: { spender: string; amount: string }; tx: { to: string; data: Hex } }
    expect(plan.approval).toMatchObject({ spender: booted.stack.registry, amount: HOST_MIN_BOND.toString() })
    const [params] = decodeFunctionData({ abi: hostRegistryAbi, data: plan.tx.data }).args as unknown as [{ endpointHash: Hex; bondUsdg: bigint }]
    expect(params.endpointHash).toBe(keccak256(toBytes(endpoint)))
    expect(params.bondUsdg).toBe(HOST_MIN_BOND)
    expect((await mutate(booted, "hosts.registerPlan", { ...body, gpuClass: "not-a-gpu" }, session)).status).toBe(400)
  })

  test("only the challenged host responds, and only inside 24 hours", async () => {
    const booted = await bootStack()
    booted.indexer.challenges.push({ host: booted.host, id: "4", status: "filed", kind: 2, filedAt: booted.stack.clock() })
    const session = await sessionFor(booted, booted.host)
    const listed = (await query(booted, "hosts.challenges", undefined, session)).data as { challenges: { id: string; respondBy: number }[] }
    expect(listed.challenges[0]?.respondBy).toBe(booted.stack.clock() + 86_400)
    expect((await mutate(booted, "hosts.respondTx", { challengeId: "4", response: "our counts" }, await sessionFor(booted, OTHER))).status).toBe(404)
    const sent = (await mutate(booted, "hosts.respondTx", { challengeId: "4", response: "our counts" }, session)).data as { responseHash: Hex; tx: { to: string; data: Hex } }
    expect(sent.tx.to).toBe(booted.stack.auditCourt!)
    expect(decodeFunctionData({ abi: auditCourtAbi, data: sent.tx.data }).args).toEqual([4n, keccak256(toBytes("our counts"))])
    booted.stack.setClock(booted.stack.clock() + 86_401)
    expect((await mutate(booted, "hosts.respondTx", { challengeId: "4", response: "late" }, session)).error?.message).toBe("response_window_closed")
  })

  test("activation waits for the end of probation", async () => {
    const booted = await bootStack()
    const row = booted.indexer.hosts.get(booted.host)!
    row.status = HOST_STATUS.Probation
    row.probationEnds = BigInt(booted.stack.clock() + 10)
    const session = await sessionFor(booted, booted.host)
    expect((await mutate(booted, "hosts.activateTx", undefined, session)).error?.message).toBe("probation_running")
    booted.stack.setClock(booted.stack.clock() + 10)
    expect((await mutate(booted, "hosts.activateTx", undefined, session)).status).toBe(200)
  })
})

describe("the static web app", () => {
  function site() {
    const dist = mkdtempSync(join(tmpdir(), "offpeak-web-"))
    mkdirSync(join(dist, "assets"))
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>OFFPEAK</title>")
    writeFileSync(join(dist, "assets", "app-abc.js"), "console.log(1)")
    writeFileSync(join(dist, "..", "offpeak-secret.txt"), "secret")
    const app = new Hono()
    app.get("/v1/status", (c) => c.json({ ok: true }))
    mountWeb(app, dist)
    return app
  }

  test("serves pages, assets and the page fallback with a tight policy", async () => {
    const app = site()
    const home = await app.request("/")
    expect(home.status).toBe(200)
    expect(await home.text()).toContain("OFFPEAK")
    expect(home.headers.get("content-security-policy")).toContain("default-src 'self'")
    expect(home.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(home.headers.get("x-content-type-options")).toBe("nosniff")
    expect(home.headers.get("cache-control")).toBe("no-cache")
    expect(await (await app.request("/dashboard")).text()).toContain("OFFPEAK")
    const asset = await app.request("/assets/app-abc.js")
    expect(asset.headers.get("cache-control")).toContain("immutable")
    expect(asset.headers.get("content-type")).toContain("javascript")
  })

  test("never answers an API path with the page, and never leaves the build folder", async () => {
    const app = site()
    expect((await app.request("/v1/status")).status).toBe(200)
    expect((await app.request("/v1/nope")).status).toBe(404)
    expect((await app.request("/trpc/nope")).status).toBe(404)
    expect((await app.request("/assets/missing.js")).status).toBe(404)
    expect((await app.request("/%2e%2e/offpeak-secret.txt")).status).toBe(404)
    expect((await app.request("/..%2Foffpeak-secret.txt")).status).toBe(404)
    expect((await app.request("/%ff")).status).toBe(404)
  })

  test("the router itself falls through to the page after its API routes", async () => {
    const booted = await bootStack()
    booted.stack.webDist = "/nonexistent"
    expect((await booted.app.request("/v1/status")).status).toBe(200)
    expect((await booted.app.request("/trpc/account.network")).status).toBe(200)
  })
})
