#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs"
import { keccak256, toBytes, type Hex } from "viem"
import { addressOf } from "../../packages/abis/src/index.ts"
import { roleAccount } from "../../packages/shared/src/test-keys.ts"
import {
  ZERO_BYTES32,
  buyerRefOf,
  domain,
  feeMicro,
  hostCostMicro,
  leafFor,
  merkleRoot,
  recordToMessage,
  usageTypes,
  type UsageRecord,
} from "../../packages/shared/src/index.ts"

const hour = Number(process.argv.includes("--hour") ? process.argv[process.argv.indexOf("--hour") + 1] : 472223)
const n = Number(process.argv.includes("--n") ? process.argv[process.argv.indexOf("--n") + 1] : 20)
const router = roleAccount("router")
const host = roleAccount("host")
const buyer = roleAccount("buyer")
const ledger = addressOf("UsageLedger")
const rows = []
for (let i = 0; i < n; i++) {
  const reqId = keccak256(toBytes(`faker-${hour}-${i}`))
  const record: UsageRecord = {
    reqId,
    buyerRef: buyerRefOf(buyer.address, reqId),
    host: host.address.toLowerCase() as Hex,
    modelDigest: keccak256(toBytes("ofm-8b")),
    tokensIn: 10 + i,
    tokensOut: 4,
    promptHash: keccak256(toBytes("p")),
    outputHash: keccak256(toBytes("o")),
    priceIn: 200_000n,
    priceOut: 800_000n,
    hostCostMicro: 0n,
    feeMicro: 0n,
    payMode: 0,
    payRef: ZERO_BYTES32,
    ts: hour * 3600 + 10,
    sheetHash: keccak256(toBytes("sheet")),
  }
  record.hostCostMicro = hostCostMicro(record.tokensIn, record.tokensOut, record.priceIn, record.priceOut)
  record.feeMicro = feeMicro(record.hostCostMicro, 400)
  const message = recordToMessage(record)
  const routerSig = await router.signTypedData({ domain: domain("OffpeakUsage", ledger), types: usageTypes, primaryType: "UsageRecord", message: message as never })
  const hostSig = await host.signTypedData({ domain: domain("OffpeakUsage", ledger), types: usageTypes, primaryType: "UsageRecord", message: message as never })
  rows.push({ record, routerSig, hostSig, leaf: leafFor(record, routerSig, hostSig), payer: buyer.address.toLowerCase() })
}
const root = merkleRoot(rows.map((r) => r.leaf).sort())
mkdirSync(".data", { recursive: true })
const out = `.data/usage-${hour}.json`
writeFileSync(out, JSON.stringify({ hour, n, root, rows: rows.map((r) => ({ ...r.record, priceIn: r.record.priceIn.toString(), priceOut: r.record.priceOut.toString(), hostCostMicro: r.record.hostCostMicro.toString(), feeMicro: r.record.feeMicro.toString(), routerSig: r.routerSig, hostSig: r.hostSig, leaf: r.leaf, payer: r.payer, feeBps: 400 })) }, null, 2))
console.log(`wrote ${n} records to ${out}`)
