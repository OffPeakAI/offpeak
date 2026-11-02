import { describe, expect, test } from "bun:test"
import { applySchemas, openDatabase, type Db } from "@offpeak/common"
import { newIngestState, tick, type IngestDeps } from "./ingest.ts"
import { FakeChain, TEST_CONTRACTS, eventLog, testHash } from "./test-chain.ts"

const HOST = "0x00000000000000000000000000000000000000f1"
const BUYER = "0x00000000000000000000000000000000000000f2"
const CHALLENGER = "0x00000000000000000000000000000000000000f3"
const ZERO32 = `0x${"00".repeat(32)}`
const UINT32_MAX = 4_294_967_295

const healthy = () => [
  eventLog("OffpeakVault", "Deposited", { buyer: BUYER, amount: 10_000_000n, balance: 10_000_000n }, 1n, 0),
  eventLog("OffpeakVault", "Settled", { hour: 5n, root: ZERO32, totalsHash: ZERO32, debited: 0n, credited: 0n, fees: 0n }, 2n, 0),
]

const challenge = (id: bigint, sampleCount: number, block: bigint) => [
  eventLog("AuditCourt", "ChallengeFiled", { challengeId: id, host: HOST, challenger: CHALLENGER, kind: 2, evidenceHash: testHash(`e${id}`) }, block, 0),
  eventLog("AuditCourt", "EvidenceFiled", { challengeId: id, modelDigest: testHash("m"), samplesRoot: testHash(`root${id}`), sampleCount, testId: testHash("t"), statistic: 1n, threshold: 1n, uri: "x" }, block, 1),
]

/** Two digests the same is a real calldata shape, and it breaks the host_models primary key. */
const duplicateModels = (block: bigint) =>
  eventLog("HostRegistry", "ServingUpdated", { host: HOST, imageDigest: testHash("i"), gpuClass: testHash("g"), modelDigests: [testHash("m"), testHash("m")], maxTps: [10, 10], probationEnds: 0n, attestationRef: ZERO32 }, block, 0)

const count = async (db: Db, table: string) => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n)
const settledHour = async (db: Db) => Number((await db.query<{ h: string }>("SELECT last_settled_hour AS h FROM chain.vault_state")).rows[0]!.h)

async function ingested(chain: FakeChain) {
  const db = await openDatabase("pglite://memory")
  const published: Record<string, unknown>[] = []
  const deps: IngestDeps = { db, reader: chain.reader, contracts: TEST_CONTRACTS, confirmations: 1, publish: (m) => void published.push(m) }
  const state = newIngestState()
  await tick(deps, state)
  return { db, deps, state, published }
}

describe("ingest under a failed block read", () => {
  test("an RPC failure at the cursor throws and rewinds nothing", async () => {
    const chain = new FakeChain()
    chain.add(...healthy())
    const { db, deps, state, published } = await ingested(chain)
    published.length = 0
    chain.failNextBlockReads = 1
    await expect(tick(deps, state)).rejects.toThrow("503")
    expect(await count(db, "chain.buyers")).toBe(1)
    await tick(deps, state)
    expect(await settledHour(db)).toBe(5)
    expect(published.filter((m) => m.type === "Reorg")).toEqual([])
  })

  test("an RPC failure while finding the fork leaves state alone", async () => {
    const chain = new FakeChain()
    chain.add(...healthy())
    const { db, deps, state, published } = await ingested(chain)
    published.length = 0
    chain.fork = "other"
    chain.forkFrom = 2n
    const read = chain.reader.getBlock
    let reads = 0
    chain.reader.getBlock = (async (args: never) => {
      if (++reads === 2) throw new Error("HTTP request failed: 503")
      return read(args)
    }) as never
    await expect(tick(deps, state)).rejects.toThrow("503")
    expect(await count(db, "chain.settlements")).toBe(1)
    expect(published).toEqual([])
  })
})

describe("replay after a real fork", () => {
  test("every event replays and survivors are restored", async () => {
    const chain = new FakeChain()
    chain.add(...healthy(), ...challenge(1n, 25, 3n))
    const { db, deps, state, published } = await ingested(chain)
    chain.fork = "other"
    chain.forkFrom = 3n
    await tick(deps, state)
    expect(published.some((m) => m.type === "Reorg")).toBe(true)
    expect((await db.query<{ balance: string }>("SELECT balance FROM chain.buyers")).rows[0]!.balance).toBe("10000000")
    expect(await settledHour(db)).toBe(5)
  })

  test("a uint32 sample count applies, on ingest and on replay", async () => {
    const chain = new FakeChain()
    chain.add(...healthy(), ...challenge(1n, UINT32_MAX, 3n), eventLog("OffpeakVault", "Deposited", { buyer: BUYER, amount: 1n, balance: 10_000_001n }, 4n, 0))
    const { db, deps, state } = await ingested(chain)
    expect(await count(db, "chain.events WHERE NOT processed")).toBe(0)
    chain.fork = "other"
    chain.forkFrom = 4n
    await tick(deps, state)
    expect(Number((await db.query<{ sample_count: string }>("SELECT sample_count FROM chain.challenges")).rows[0]!.sample_count)).toBe(UINT32_MAX)
    expect(await count(db, "chain.events WHERE NOT processed")).toBe(0)
  })

  test("an event that cannot apply is marked on replay and the rest come back", async () => {
    const chain = new FakeChain()
    chain.add(...healthy(), duplicateModels(3n), eventLog("OffpeakVault", "Deposited", { buyer: BUYER, amount: 1n, balance: 10_000_001n }, 4n, 0))
    const { db, deps, state, published } = await ingested(chain)
    expect(await count(db, "chain.events WHERE NOT processed")).toBe(1)
    chain.fork = "other"
    chain.forkFrom = 4n
    await tick(deps, state)
    expect(published.some((m) => m.type === "Reorg")).toBe(true)
    expect(await count(db, "chain.events WHERE NOT processed")).toBe(1)
    expect(await count(db, "chain.buyers")).toBe(1)
    expect(await settledHour(db)).toBe(5)
  })

  test("a failed replay read undoes the wipe", async () => {
    const chain = new FakeChain()
    chain.add(...healthy(), ...challenge(1n, 25, 3n))
    const { db, deps, state } = await ingested(chain)
    chain.fork = "other"
    chain.forkFrom = 3n
    const read = chain.reader.getBlock
    let reads = 0
    chain.reader.getBlock = (async (args: { blockNumber?: bigint }) => {
      if (++reads === 3) throw new Error("HTTP request failed: 503")
      return read(args)
    }) as never
    await expect(tick(deps, state)).rejects.toThrow("503")
    expect(await count(db, "chain.buyers")).toBe(1)
    expect(await settledHour(db)).toBe(5)
  })
})

describe("the chain schema upgrade", () => {
  test("widens both uint32 columns on a database from an earlier step", async () => {
    const db = await openDatabase("pglite://memory")
    await db.exec("ALTER TABLE chain.challenges ALTER COLUMN sample_count TYPE integer; ALTER TABLE chain.host_models ALTER COLUMN max_tps TYPE integer")
    await applySchemas(db, { shared: false })
    await applySchemas(db, { shared: false })
    const types = await db.query<{ data_type: string }>("SELECT data_type FROM information_schema.columns WHERE table_schema = 'chain' AND column_name IN ('sample_count', 'max_tps')")
    expect(types.rows.map((r) => r.data_type)).toEqual(["bigint", "bigint"])
  })
})
