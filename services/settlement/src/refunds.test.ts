import { describe, expect, test } from "bun:test"
import { openDatabase, readSignatures, storeSignature, type Db } from "@offpeak/common"
import { hourIndex } from "@offpeak/shared"
import { keccak256, toBytes, type Address, type Hex } from "viem"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { refundTick } from "./refunds.ts"
import { insertRow, signRow } from "./test-rows.ts"

const signers = [roleAccount("settlerA"), roleAccount("settlerB"), roleAccount("settlerC")]
const settlers = signers.map((s) => s.address)
const VAULT = "0x00000000000000000000000000000000000000a1" as Address
const ESCROW = "0x00000000000000000000000000000000000000a4" as Address
const LEDGER = "0x00000000000000000000000000000000000000a5" as Address
const BUYER = "0x00000000000000000000000000000000000000f2"
const STRANGER = "0x00000000000000000000000000000000000000f3"
const RESERVE = 5_000_000_000n
const USDG = 1_000_000n
const STATUS_EXACT = 4
const hash = (value: string) => keccak256(toBytes(value))

type Escrow = { payer: string; captured: bigint; status: number }

async function round(db: Db, escrows: Record<string, Escrow> = {}, reserve = RESERVE) {
  const hour = hourIndex(Math.floor(Date.now() / 1000)) + 1
  const sent: { args: [{ refunds: { payer: string; amount: bigint; refundId: Hex }[] }] }[] = []
  const chain = {
    getBlock: async () => ({ number: 5n, timestamp: BigInt(hour * 3600 + 7200) }),
    readContract: async ({ functionName, args }: { functionName: string; args: [string] }) => {
      if (functionName === "protocolReserve") return reserve
      if (functionName === "escrowView") return escrows[args[0]] ?? { payer: `0x${"00".repeat(20)}`, captured: 0n, status: 0 }
      return false
    },
    simulateContract: async (call: unknown) => ({ request: call }),
    waitForTransactionReceipt: async () => ({ status: "success" }),
  }
  for (const account of signers.slice(0, 2)) {
    const writer = { writeContract: async (c: never) => (sent.push(c), hash("tx")) }
    await refundTick({ db, reader: chain as never, writer: writer as never, account, vault: VAULT, escrow: ESCROW, settlers, chainId: 4663 }, hour)
  }
  return { hour, sent, paid: sent[0]?.args[0].refunds ?? [] }
}

async function refundRow(db: Db, id: string, payer: string, amount: bigint, reason: string, reqIds: string[]) {
  await db.query("INSERT INTO shared.refunds (id, payer, amount, reason, req_ids) VALUES ($1,$2,$3,$4,$5)", [id, payer, amount.toString(), reason, reqIds])
}

async function settledRecord(db: Db, i: number, hour = 100, payer = BUYER) {
  const row = await signRow({ i, hour, payer }, LEDGER)
  await insertRow(db, row)
  await db.query(
    `INSERT INTO chain.settlements (hour, root, totals_hash, debited, credited, fees, tx_hash, block, settled_at)
     VALUES ($1,$2,$2,0,0,0,$2,1,0) ON CONFLICT (hour) DO NOTHING`,
    [hour, hash(`s${hour}`)],
  )
  return { reqId: row.req_id, cost: BigInt(row.host_cost_micro) + BigInt(row.fee_micro) }
}

const excess = (amount: bigint) => ({ id: "agent-excess:p", payer: BUYER, amount: amount.toString(), reason: "excluded_record", reqIds: ["r"] })

/** A batch as the indexer records it: its Settled event names the hash, and signers stored the outcome. */
async function landed(db: Db, signatures: "two" | "one" | "junk", amount: bigint, onChain = true) {
  const batchHash = hash("landed batch")
  const batch = { payments: { drawn: [], writtenOff: [], refunds: [excess(amount)] } }
  if (signatures === "junk") await storeSignature(db, "settle", 7, signers[2]!.address, batchHash, "0x00", batch)
  else for (const account of signers.slice(0, signatures === "two" ? 2 : 1)) await storeSignature(db, "settle", 7, account.address, batchHash, await account.sign({ hash: batchHash }), batch)
  if (onChain) {
    await db.query(
      `INSERT INTO chain.events (tx_hash, log_index, block_number, block_hash, block_ts, contract, event, args, processed)
       VALUES ($1,0,1,$1,0,'OffpeakVault','Settled',$2::jsonb,true)`,
      [hash("settle tx"), JSON.stringify({ hour: "7", batchHash })],
    )
  }
}

describe("refund rows need facts behind them", () => {
  test("with no rows nothing is signed or sent", async () => {
    const db = await openDatabase("pglite://memory")
    const { hour, sent } = await round(db)
    expect(sent.length).toBe(0)
    expect((await readSignatures(db, "refund", hour)).length).toBe(0)
  })

  test("a bare insert spends nothing, past two honest signers", async () => {
    const db = await openDatabase("pglite://memory")
    await refundRow(db, "x", STRANGER, RESERVE, "dispute_upheld", [])
    await refundRow(db, "y", STRANGER, 1n, "metering", [])
    const { hour, sent } = await round(db)
    expect(sent.length).toBe(0)
    expect((await readSignatures(db, "refund", hour)).length).toBe(0)
  })

  test("a bad row does not hold back a good one", async () => {
    const db = await openDatabase("pglite://memory")
    const { reqId, cost } = await settledRecord(db, 1)
    await refundRow(db, "a-forged", STRANGER, 1n, "dispute_upheld", [])
    await refundRow(db, "dispute:1", BUYER, cost, "dispute_upheld", [reqId])
    expect((await round(db)).paid.map((r) => r.amount)).toEqual([cost])
  })

  describe("disputes and lost lines", () => {
    test("up to what was billed passes", async () => {
      const db = await openDatabase("pglite://memory")
      const one = await settledRecord(db, 1)
      const two = await settledRecord(db, 2)
      await refundRow(db, "dispute:1", BUYER, one.cost + two.cost, "dispute_upheld", [one.reqId, two.reqId])
      expect((await round(db)).paid.length).toBe(1)
    })

    test("more than was billed does not", async () => {
      const db = await openDatabase("pglite://memory")
      const { reqId, cost } = await settledRecord(db, 1)
      await refundRow(db, "dispute:1", BUYER, cost + 1n, "dispute_upheld", [reqId])
      expect((await round(db)).sent.length).toBe(0)
    })

    test("another payer's record does not", async () => {
      const db = await openDatabase("pglite://memory")
      const { reqId, cost } = await settledRecord(db, 1)
      await refundRow(db, "dispute:1", STRANGER, cost, "dispute_upheld", [reqId])
      expect((await round(db)).sent.length).toBe(0)
    })

    test("an hour that has not settled waits", async () => {
      const db = await openDatabase("pglite://memory")
      const { reqId, cost } = await settledRecord(db, 1)
      await db.query("DELETE FROM chain.settlements")
      await refundRow(db, "dispute:1", BUYER, cost, "dispute_upheld", [reqId])
      expect((await round(db)).sent.length).toBe(0)
    })

    test("a record settlement rejected does not pass", async () => {
      const db = await openDatabase("pglite://memory")
      const { reqId, cost } = await settledRecord(db, 1)
      await db.query("INSERT INTO chain.settlement_rejects (hour, req_id, reason) VALUES (100, $1, 'bad_host_signature')", [reqId])
      await refundRow(db, "dispute:1", BUYER, cost, "dispute_upheld", [reqId])
      expect((await round(db)).sent.length).toBe(0)
    })

    test("a record pays once, under any id", async () => {
      const db = await openDatabase("pglite://memory")
      const { reqId, cost } = await settledRecord(db, 1)
      await refundRow(db, "dispute:a", BUYER, cost, "dispute_upheld", [reqId])
      await refundRow(db, "dispute:b", BUYER, cost, "dispute_upheld", [reqId])
      expect((await round(db)).paid.length).toBe(1)
    })

    test("a record already paid does not pay again", async () => {
      const db = await openDatabase("pglite://memory")
      const { reqId, cost } = await settledRecord(db, 1)
      await refundRow(db, "dispute:a", BUYER, cost, "dispute_upheld", [reqId])
      await db.query("UPDATE shared.refunds SET paid_hour = 1")
      await refundRow(db, "dispute:b", BUYER, cost, "dispute_upheld", [reqId])
      expect((await round(db)).sent.length).toBe(0)
    })

    test("a forged row cannot use up a record", async () => {
      const db = await openDatabase("pglite://memory")
      const { reqId, cost } = await settledRecord(db, 1)
      await refundRow(db, "a-forged", STRANGER, cost, "dispute_upheld", [reqId])
      await refundRow(db, "dispute:1", BUYER, cost, "dispute_upheld", [reqId])
      expect((await round(db)).paid.map((r) => r.payer.toLowerCase())).toEqual([BUYER])
    })

    test("a lost line uses the id the record gives it", async () => {
      const db = await openDatabase("pglite://memory")
      const { reqId, cost } = await settledRecord(db, 1)
      await refundRow(db, "night-line:other", BUYER, cost, "night_line_lost", [reqId])
      await refundRow(db, `night-line:${reqId}`, BUYER, cost, "night_line_lost", [reqId])
      expect((await round(db)).paid.map((r) => r.refundId)).toEqual([keccak256(toBytes(`night-line:${reqId}`))])
    })
  })

  describe("unserved exact payments", () => {
    const REQ = hash("req")
    const row = (db: Db, amount: bigint, payer = BUYER, id = `exact-unserved:${REQ}`) => refundRow(db, id, payer, amount, "exact_unserved", [REQ])
    const taken = { [REQ]: { payer: BUYER, captured: 5n * USDG, status: STATUS_EXACT } }

    test("what the escrow took passes", async () => {
      const db = await openDatabase("pglite://memory")
      await row(db, 5n * USDG)
      expect((await round(db, taken)).paid.map((r) => r.amount)).toEqual([5n * USDG])
    })

    test("more than it took, or for another payer, or under another id, does not", async () => {
      const db = await openDatabase("pglite://memory")
      await row(db, 6n * USDG)
      await row(db, 5n * USDG, STRANGER, `exact-unserved:${REQ}:2`)
      await row(db, 5n * USDG, BUYER, `exact-unserved:${REQ}:3`)
      expect((await round(db, taken)).sent.length).toBe(0)
    })

    test("a payment nothing took does not", async () => {
      const db = await openDatabase("pglite://memory")
      await row(db, 5n * USDG)
      expect((await round(db)).sent.length).toBe(0)
    })

    test("a request that was served does not", async () => {
      const db = await openDatabase("pglite://memory")
      await row(db, 5n * USDG)
      await db.query("INSERT INTO shared.agent_payments (payment_id, kind, payer, amount_micro, req_ids) VALUES ($1,'exact',$2,1,'{}')", [REQ, BUYER])
      expect((await round(db, taken)).sent.length).toBe(0)
    })
  })

  describe("excluded records", () => {
    const row = (db: Db, amount: bigint) => refundRow(db, "agent-excess:p", BUYER, amount, "excluded_record", ["r"])

    test("a refund in a landed batch two signers stored passes", async () => {
      const db = await openDatabase("pglite://memory")
      await landed(db, "two", 30n)
      await row(db, 30n)
      expect((await round(db)).paid.map((r) => r.amount)).toEqual([30n])
    })

    test("a lone signer's outcome row does not, with or without a true signature", async () => {
      for (const signatures of ["one", "junk"] as const) {
        const db = await openDatabase("pglite://memory")
        await landed(db, signatures, 30n)
        await row(db, 30n)
        expect((await round(db)).sent.length).toBe(0)
      }
    })

    test("a batch that never landed does not", async () => {
      const db = await openDatabase("pglite://memory")
      await landed(db, "two", 30n, false)
      await row(db, 30n)
      expect((await round(db)).sent.length).toBe(0)
    })

    test("another amount does not", async () => {
      const db = await openDatabase("pglite://memory")
      await landed(db, "two", 30n)
      await row(db, 31n)
      expect((await round(db)).sent.length).toBe(0)
    })
  })

  describe("the batch cap", () => {
    test("one batch stops at the cap and the rest waits", async () => {
      const db = await openDatabase("pglite://memory")
      const big = 600n * USDG
      const escrows: Record<string, Escrow> = {}
      for (const i of [1, 2, 3]) {
        const reqId = hash(`big-${i}`)
        escrows[reqId] = { payer: BUYER, captured: big, status: STATUS_EXACT }
        await refundRow(db, `exact-unserved:${reqId}`, BUYER, big, "exact_unserved", [reqId])
      }
      expect((await round(db, escrows)).paid.map((r) => r.amount)).toEqual([big])
    })

    test("the reserve still binds below the cap", async () => {
      const db = await openDatabase("pglite://memory")
      const { reqId, cost } = await settledRecord(db, 1)
      await refundRow(db, "dispute:1", BUYER, cost, "dispute_upheld", [reqId])
      expect((await round(db, {}, cost - 1n)).sent.length).toBe(0)
    })
  })
})
