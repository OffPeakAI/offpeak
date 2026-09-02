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
