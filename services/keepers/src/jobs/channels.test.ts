import { describe, expect, test } from "bun:test"
import { Metrics, openDatabase, type Db } from "@offpeak/common"
import { keccak256, toBytes, type Hex } from "viem"
import { runChannelClaim, runCloseWatch, runChannelExpiry } from "./channels.ts"
import type { KeeperDeps } from "./types.ts"

const NOW = 1_800_000_000
const hash = (value: string) => keccak256(toBytes(value))

async function seed(db: Db, name: string, n: number, cumulative = 10, seq = 1) {
  const ids: Hex[] = []
  for (let i = 0; i < n; i++) {
    const id = hash(`${name}-${i}`)
    ids.push(id)
    await db.query("INSERT INTO chain.channels (channel_id, payer, deposit, expiry, opened_at) VALUES ($1,'0xaa',1000000,$2,0)", [id, NOW + 21_600])
    await db.query("INSERT INTO shared.channel_state (channel_id, payer, latest_seq, cumulative, voucher_sig) VALUES ($1,'0xaa',$2,$3,'0x00')", [id, seq, cumulative])
  }
  return ids
}

type Chain = { now: number; simulated: string[]; reverts: Set<string>; closing?: Hex; left: number }

function deps(db: Db, chain: Chain) {
  return {
    db,
    account: { address: "0x00000000000000000000000000000000000000ee" },
    contracts: { ChannelManager: "0x00000000000000000000000000000000000000ab" },
    metrics: new Metrics(),
    writer: { writeContract: async () => hash("tx") },
    reader: {
      getBlock: async () => ({ number: 1n, timestamp: BigInt(chain.now) }),
      simulateContract: async (call: { args: [Hex] }) => {
        chain.simulated.push(call.args[0])
        if (chain.reverts.has(call.args[0])) throw new Error("BadSignature()")
        return { request: call }
      },
      waitForTransactionReceipt: async () => ({ status: "success" }),
      readContract: async () => ({ lastSeq: 0n, status: 2, challengeEndsAt: BigInt(chain.now + chain.left), claimed: 0n }),
    },
  } as unknown as KeeperDeps
}

const newChain = (reverts: Hex[] = []): Chain => ({ now: NOW, simulated: [], reverts: new Set(reverts), left: 7_000 })

describe("channel-claim stays inside its budget", () => {
  test("landable vouchers finish at once", async () => {
    const db = await openDatabase("pglite://memory")
    const ids = await seed(db, "good", 2)
    const started = performance.now()
    expect((await runChannelClaim(deps(db, newChain()))).sort()).toEqual([...ids].sort())
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test("unlandable vouchers cannot hold the worker past the budget", async () => {
    const db = await openDatabase("pglite://memory")
    const ids = await seed(db, "budget", 20)
    const chain = newChain(ids)
    const started = performance.now()
    expect(await runChannelClaim(deps(db, chain), 150)).toEqual([])
    expect(performance.now() - started).toBeLessThan(5_000)
    chain.simulated.length = 0
    expect(await runChannelClaim(deps(db, chain), 150)).toEqual([])
    expect(chain.simulated).toEqual([])
  })

  test("a failed voucher waits out its back-off, and the good ones still land", async () => {
    const db = await openDatabase("pglite://memory")
    const [bad] = await seed(db, "backoff", 1, 10)
    const [good] = await seed(db, "backoff-good", 1, 5)
    const chain = newChain([bad!])
    expect(await runChannelClaim(deps(db, chain), 1)).toEqual([good!])
    chain.simulated.length = 0

    expect(await runChannelClaim(deps(db, chain))).toEqual([good!])
    expect(chain.simulated).toEqual([good!])

    chain.now += 301
    chain.simulated.length = 0
    await runChannelClaim(deps(db, chain), 1)
    expect(chain.simulated).toContain(bad!)
  })

  test("a newer voucher ignores the back-off of the old one", async () => {
    const db = await openDatabase("pglite://memory")
    const [id] = await seed(db, "newer", 1)
    const chain = newChain([id!])
    await runChannelClaim(deps(db, chain), 1)
    chain.reverts.clear()
    await db.query("UPDATE shared.channel_state SET latest_seq = 2, cumulative = 20 WHERE channel_id = $1", [id])
    expect(await runChannelClaim(deps(db, chain))).toEqual([id!])
  })
})

describe("closing channels", () => {
  async function closing(name: string, n: number) {
    const db = await openDatabase("pglite://memory")
    const ids = await seed(db, name, n)
    await db.query("UPDATE chain.channels SET status = 2, challenge_ends_at = $1", [NOW + 7_000])
    return { db, ids }
  }

  test("the clock's sweep respects a back-off until the deadline is near", async () => {
    const { db, ids } = await closing("sweep", 1)
    const chain = newChain(ids)
    await runCloseWatch(deps(db, chain), undefined, 1)
    chain.simulated.length = 0
    await runCloseWatch(deps(db, chain))
    expect(chain.simulated).toEqual([])
    chain.left = 1_000
    await runCloseWatch(deps(db, chain), undefined, 1)
    expect(chain.simulated).toEqual(ids)
  })

  test("a push always tries, since it is one channel's race", async () => {
    const { db, ids } = await closing("push", 1)
    const chain = newChain(ids)
    await runCloseWatch(deps(db, chain), undefined, 1)
    chain.reverts.clear()
    chain.simulated.length = 0
    await runCloseWatch(deps(db, chain), ids[0]!)
    expect(chain.simulated).toEqual(ids)
  })

  test("the sweep stops at its budget and serves the soonest deadline first", async () => {
    const { db, ids } = await closing("order", 3)
    await db.query("UPDATE chain.channels SET challenge_ends_at = $1 WHERE channel_id = $2", [NOW + 3_000, ids[2]])
    const chain = newChain(ids)
    await runCloseWatch(deps(db, chain), undefined, 1)
    expect(chain.simulated[0]).toBe(ids[2]!)
    expect(chain.simulated.length).toBeLessThan(6 * 3)
  })
})

describe("channel-expiry", () => {
  test("stops at its budget and closes the rest on a later pass", async () => {
    const db = await openDatabase("pglite://memory")
    const ids = await seed(db, "expiry", 3)
    await db.query("UPDATE chain.channels SET expiry = $1", [NOW - 1])
    expect(await runChannelExpiry(deps(db, newChain()), 0)).toEqual([])
    expect((await runChannelExpiry(deps(db, newChain()))).sort()).toEqual([...ids].sort())
  })
})
