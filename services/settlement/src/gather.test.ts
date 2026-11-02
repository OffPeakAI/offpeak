import { describe, expect, test } from "bun:test"
import { emptyTotals, merkleRoot, totalsHashOf } from "../../../packages/shared/src/index.ts"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { openDatabase, type Db } from "@offpeak/common"
import { keccak256, toBytes, type Address } from "viem"
import { buildBatch } from "./build.ts"
import { gatherHour } from "./gather.ts"

const VAULT = "0x00000000000000000000000000000000000000a1" as Address
const LEDGER = "0x00000000000000000000000000000000000000a5" as Address
const BUYER = "0x00000000000000000000000000000000000000f2"
const REQ = keccak256(toBytes("exact"))
const AMOUNT = 1_000_000n
const COLLECTED = 500
const HOUR = 525

async function collected(db: Db) {
  await db.query("INSERT INTO chain.escrows (req_id, payer, max_amount, captured, status, tx_hash) VALUES ($1,$2,$3,$3,'captured',$4)", [REQ, BUYER, AMOUNT.toString(), keccak256(toBytes("t"))])
  await db.query("INSERT INTO chain.collections (payment_id, tx_hash, hour) VALUES ($1,$2,$3)", [REQ, keccak256(toBytes("t")), COLLECTED])
}

async function batch(db: Db) {
  await db.query("INSERT INTO chain.vault_state (id, initial_settled_hour, last_settled_hour) VALUES (1,0,$1) ON CONFLICT (id) DO UPDATE SET last_settled_hour = $1", [HOUR - 1])
  await db.query("INSERT INTO chain.cursor (id, block, block_hash) VALUES ('main', 100, $1)", [keccak256(toBytes("b"))])
  await db.query("INSERT INTO shared.usage_hours (hour, records, root, totals, totals_hash, router_close_sig) VALUES ($1,0,$2,'{}',$3,'0x')", [HOUR, merkleRoot([]), totalsHashOf(emptyTotals())])
  const reader = {
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({ number: blockNumber ?? 90n, timestamp: BigInt((HOUR + 2) * 3600) }),
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "protocolReserve" ? 5_000_000_000n : 10n * AMOUNT),
  }
  const gathered = await gatherHour({ db, reader: reader as never, chainId: 4663, contracts: { OffpeakVault: VAULT, UsageLedger: LEDGER }, routerAddress: roleAccount("router").address }, HOUR)
  if ("waiting" in gathered) throw new Error(gathered.waiting)
  return buildBatch(gathered.input)
}

describe("money an escrow collected with no payment row", () => {
  test("joins fees after a day when nothing else claims it", async () => {
    const db = await openDatabase("pglite://memory")
    await collected(db)
    const { b, swept } = await batch(db)
    expect(b.fees).toBe(AMOUNT)
    expect(b.agentPoolDraw).toBe(AMOUNT)
    expect(swept.map((s) => s.source)).toEqual([REQ])
  })

  for (const paidHour of [null, COLLECTED + 2]) {
    test(`stays in the pool when its unserved refund is ${paidHour === null ? "waiting" : "paid"}, so the reserve's refund is not also fees`, async () => {
      const db = await openDatabase("pglite://memory")
      await collected(db)
      await db.query("INSERT INTO shared.refunds (id, payer, amount, reason, req_ids, paid_hour) VALUES ($1,$2,$3,'exact_unserved',$4,$5)", [`exact-unserved:${REQ}`, BUYER, AMOUNT.toString(), [REQ], paidHour])
      const { b, swept, drawn } = await batch(db)
      expect(b.fees).toBe(0n)
      expect(b.agentPoolDraw).toBe(0n)
      expect(swept).toEqual([])
      expect(drawn).toEqual([])
    })
  }

  test("a served exact that was drawn is not swept", async () => {
    const db = await openDatabase("pglite://memory")
    await collected(db)
    await db.query("INSERT INTO shared.agent_payments (payment_id, kind, payer, amount_micro, req_ids, drawn_hour) VALUES ($1,'exact',$2,$3,'{}',$4)", [REQ, BUYER, AMOUNT.toString(), COLLECTED])
    expect((await batch(db)).b.fees).toBe(0n)
  })
})
