#!/usr/bin/env bun
import { keccak256, toBytes, type Address } from "viem"
import { buildBatch, type BuyerFacts } from "../services/settlement/src/build.ts"
import { signRow } from "../services/settlement/src/test-rows.ts"
import { roleAccount } from "../packages/shared/src/test-keys.ts"

/** The settlement load target: build and sign one hour of 200,000 records from 2,000 buyers in under 5 minutes. */
const arg = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`)
  return at > -1 ? Number(process.argv[at + 1]) : fallback
}
const RECORDS = arg("records", 200_000)
const BUYERS = arg("buyers", 2_000)
const CHUNK = 500
const TARGET_S = 300
const HOUR = 500_000
const ledger = "0x00000000000000000000000000000000000000aa" as Address

const payers = Array.from({ length: BUYERS }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`)
const open: BuyerFacts = { hourlyCap: 10n ** 15n, dailyCap: 10n ** 15n, withdrawRequestedAt: 0n, dayDebited: 1n }

const signing = performance.now()
const rows = []
for (let start = 0; start < RECORDS; start += CHUNK) {
  const end = Math.min(start + CHUNK, RECORDS)
  const chunk = Array.from({ length: end - start }, (_, n) => {
    const i = start + n
    return signRow({ i, hour: HOUR, payer: payers[i % BUYERS]!, ts: HOUR * 3600 + (i % 3600) }, ledger)
  })
  rows.push(...(await Promise.all(chunk)))
}
console.log(`signed ${rows.length} fixture records in ${((performance.now() - signing) / 1000).toFixed(1)}s (not part of the target)`)

const started = performance.now()
const built = await buildBatch({
  hour: HOUR,
  chainId: 4663,
  vault: "0x00000000000000000000000000000000000000bb",
  rows,
  buyers: new Map(payers.map((payer) => [payer, open])),
  payments: [],
  protocolReserve: 0n,
  agentPool: 0n,
  windows: new Map(),
  closeRoot: null,
  ctx: {
    routerAddress: roleAccount("router").address,
    usageLedger: ledger,
    hostServingAt: () => true,
    discountBps: () => 0,
  },
})
await roleAccount("settlerA").sign({ hash: built.batchHash })
const seconds = (performance.now() - started) / 1000
console.log(`built and signed in ${seconds.toFixed(1)}s, target ${TARGET_S}s`)
console.log(`debits ${built.b.debits.length}, excluded ${built.rejects.length}, batch ${keccak256(toBytes(built.batchHash)).slice(0, 12)}`)
process.exit(seconds < TARGET_S ? 0 : 1)
