import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { encodeAbiParameters, keccak256, toBytes, type Hex } from "viem"
import localDeploy from "../../abis/deployments/local.json" with { type: "json" }
import { ZERO_BYTES32 } from "./constants.ts"
import { domainSeparator, typedDataDigest } from "./digest.ts"
import {
  CHANNEL_WITNESS_TYPESTRING,
  EXACT_WITNESS_TYPESTRING,
  UPTO_WITNESS_TYPESTRING,
  domain,
  hashStruct,
  hourCloseTypes,
  permitWitnessTypes,
  priceSheetTypes,
  refundTypes,
  rewardTypes,
  rulingTypes,
  settleTypes,
  usageStructHash,
  usageTypes,
  voucherTypes,
} from "./eip712.ts"
import { buyerRefOf, outputHashOf, promptHashOf } from "./hash.ts"
import { merkleProof, merkleRoot, totalsHashOf, usageLeaf, type RootTotals } from "./merkle.ts"
import { buyerPays, feeMicro, hostCostMicro } from "./money.ts"
import { roleAccount } from "./test-keys.ts"
import { recordToMessage, type UsageRecord } from "./usage.ts"

const contracts = localDeploy.contracts
const router = roleAccount("router")
const host = roleAccount("host")
const buyer = roleAccount("buyer")
const settlers = [roleAccount("settlerA"), roleAccount("settlerB"), roleAccount("settlerC")]
const rulings = [roleAccount("rulingA"), roleAccount("rulingB"), roleAccount("rulingC")]

const baseIn = Array.from({ length: 168 }, (_, i) => 200_000n + BigInt(i) * 100n)
const baseOut = Array.from({ length: 168 }, (_, i) => 800_000n + BigInt(i) * 100n)
const priceMessage = {
  host: host.address.toLowerCase() as Hex,
  modelDigest: keccak256(toBytes("offpeak-model-a")),
  baseIn,
  baseOut,
  floorIn: 100_000n,
  floorOut: 400_000n,
  validFrom: 1_700_000_000n,
  nonce: 1n,
}
const sheetStruct = hashStruct("PriceSheet", priceSheetTypes as never, priceMessage)
const sheetHash = typedDataDigest(
  sheetStruct,
  domainSeparator("OffpeakPriceSheet", contracts.HostRegistry as Hex),
)
const priceSig = await host.signTypedData({
  domain: domain("OffpeakPriceSheet", contracts.HostRegistry),
  types: priceSheetTypes,
  primaryType: "PriceSheet",
  message: priceMessage,
})

const modelDigest = priceMessage.modelDigest
const promptHash = promptHashOf({ model: "ofm-8b", messages: [{ role: "user", content: "vector" }] })
const outputHash = outputHashOf("vector-output", [])

function makeRecord(i: number, payMode: 0 | 1 | 2 | 3 | 4): UsageRecord {
  const tokensIn = 100 + i * 10
  const tokensOut = payMode === 4 ? 50 : 20 + i
  const priceIn = payMode === 4 ? 0n : 250_000n
  const priceOut = payMode === 4 ? 0n : 900_000n
  const hostCost = payMode === 4 ? 0n : hostCostMicro(tokensIn, tokensOut, priceIn, priceOut)
  const fee = payMode === 4 ? 0n : feeMicro(hostCost, 400)
  const reqId = keccak256(toBytes(`vector-req-${i}`))
  return {
    reqId,
    buyerRef: buyerRefOf(buyer.address, reqId),
    host: host.address.toLowerCase() as Hex,
    modelDigest,
    tokensIn,
    tokensOut,
    promptHash,
    outputHash,
    priceIn,
    priceOut,
    hostCostMicro: hostCost,
    feeMicro: fee,
    payMode,
    payRef: payMode === 0 ? ZERO_BYTES32 : keccak256(toBytes(`pay-${i}`)),
    ts: 1_700_003_600 + i,
    sheetHash,
  }
}

const modes: Array<0 | 1 | 2 | 3 | 4> = [0, 1, 3, 4, 2]
const records = modes.map((mode, i) => makeRecord(i, mode))
records.sort((a, b) => (a.reqId < b.reqId ? -1 : 1))

const signed = []
for (const record of records) {
  const message = recordToMessage(record)
  const routerSig = await router.signTypedData({
    domain: domain("OffpeakUsage", contracts.UsageLedger),
    types: usageTypes,
    primaryType: "UsageRecord",
    message: message as never,
  })
  const hostSig = await host.signTypedData({
    domain: domain("OffpeakUsage", contracts.UsageLedger),
    types: usageTypes,
    primaryType: "UsageRecord",
    message: message as never,
  })
  const structHash = usageStructHash(message)
  const leaf = usageLeaf(structHash, routerSig, hostSig)
  signed.push({
    record: {
      reqId: record.reqId,
      buyerRef: record.buyerRef,
      host: record.host,
      modelDigest: record.modelDigest,
      tokensIn: record.tokensIn,
      tokensOut: record.tokensOut,
      promptHash: record.promptHash,
      outputHash: record.outputHash,
      priceIn: record.priceIn.toString(),
      priceOut: record.priceOut.toString(),
      hostCostMicro: record.hostCostMicro.toString(),
      feeMicro: record.feeMicro.toString(),
      payMode: record.payMode,
      payRef: record.payRef,
      ts: record.ts,
      sheetHash: record.sheetHash,
    },
    structHash,
    routerSig,
    hostSig,
    leaf,
    buyerPays: buyerPays(record.hostCostMicro, record.feeMicro).toString(),
  })
}
