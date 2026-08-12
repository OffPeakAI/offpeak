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

const leaves = signed.map((s) => s.leaf as Hex)
const root = merkleRoot(leaves)
const proofs = leaves.map((_, i) => merkleProof(leaves, i))

let prepaidDebit = 0n
let agentCollected = 0n
let windowDrawn = 0n
let hostCredit = 0n
let fees = 0n
let tokensIn = 0n
let tokensOut = 0n
for (const record of records) {
  tokensIn += BigInt(record.tokensIn)
  tokensOut += BigInt(record.tokensOut)
  if (record.payMode === 0) prepaidDebit += record.hostCostMicro + record.feeMicro
  if (record.payMode === 1 || record.payMode === 2 || record.payMode === 3) {
    agentCollected += record.hostCostMicro + record.feeMicro
  }
  if (record.payMode === 4) windowDrawn += BigInt(record.tokensIn + record.tokensOut)
  if (record.payMode !== 4) {
    hostCredit += record.hostCostMicro
    fees += record.feeMicro
  }
}
const totals: RootTotals = {
  records: records.length,
  tokensIn,
  tokensOut,
  prepaidDebit,
  agentCollected,
  windowDrawn,
  hostCredit,
  fees,
}
const totalsHash = totalsHashOf(totals)
const hourCloseMessage = { hour: 472223n, records: records.length, root, totalsHash }
const hourCloseSig = await router.signTypedData({
  domain: domain("OffpeakUsage", contracts.UsageLedger),
  types: hourCloseTypes,
  primaryType: "HourClose",
  message: hourCloseMessage,
})

const settleMessage = {
  chainId: 4663n,
  vault: contracts.OffpeakVault as Hex,
  hour: 472223n,
  root,
  totalsHash,
  debits: [
    {
      buyer: buyer.address.toLowerCase() as Hex,
      amount: prepaidDebit,
      lastTs: BigInt(records.find((r) => r.payMode === 0)?.ts ?? 0),
    },
  ],
  credits: [{ host: host.address.toLowerCase() as Hex, amount: hostCredit }],
  windowDraws: [] as { windowId: bigint; holder: Hex; tokens: bigint }[],
  fees,
  agentPoolDraw: agentCollected,
  reserveDraw: 0n,
  agentPaymentsHash: keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [[]])),
}
const orderedSettlers = [...settlers].sort((a, b) =>
  a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
)
const pair = orderedSettlers.slice(0, 2)
const pairSigs = await Promise.all(
  pair.map((signer) =>
    signer.signTypedData({
      domain: domain("OffpeakSettlement", contracts.OffpeakVault),
      types: settleTypes,
      primaryType: "SettleBatch",
      message: settleMessage,
    }),
  ),
)

const refundMessage = {
  batchId: 472223n,
  refunds: [{ payer: buyer.address.toLowerCase() as Hex, amount: 1_234n, refundId: keccak256(toBytes("vector-refund")) }],
}
const refundSigs = await Promise.all(
  pair.map((signer) =>
    signer.signTypedData({
      domain: domain("OffpeakSettlement", contracts.OffpeakVault),
      types: refundTypes,
      primaryType: "RefundBatch",
      message: refundMessage,
    }),
  ),
)

const rewardMessage = {
  week: 2811n,
  credits: [{ host: host.address.toLowerCase() as Hex, amount: 5_678n }],
}
const rewardSigs = await Promise.all(
  pair.map((signer) =>
    signer.signTypedData({
      domain: domain("OffpeakSettlement", contracts.OffpeakVault),
      types: rewardTypes,
      primaryType: "RewardBatch",
      message: rewardMessage,
    }),
  ),
)

const channelId = keccak256(toBytes("vector-channel"))
const voucherSig = await buyer.signTypedData({
  domain: domain("OffpeakChannel", contracts.ChannelManager),
  types: voucherTypes,
  primaryType: "Voucher",
  message: { channelId, seq: 1n, cumulative: 123_456n },
})

const uptoTypes = permitWitnessTypes("UptoWitness")
const uptoMessage = {
  permitted: { token: contracts.MockUSDG as Hex, amount: 50_000n },
  spender: contracts.X402Escrow as Hex,
  nonce: 1n,
  deadline: 1_800_000_000n,
  witness: {
    reqId: keccak256(toBytes("upto-req")),
    payee: contracts.OffpeakVault as Hex,
    maxAmount: 50_000n,
    validBefore: 1_800_000_000n,
    resourceHash: keccak256(toBytes("resource")),
  },
}
const uptoStruct = hashStruct("PermitWitnessTransferFrom", uptoTypes as never, uptoMessage)
const permitSeparator = domainSeparator("Permit2", contracts.Permit2 as Hex, null)
const uptoDigest = typedDataDigest(uptoStruct, permitSeparator)

const exactTypes = permitWitnessTypes("ExactWitness")
const exactMessage = {
  permitted: { token: contracts.MockUSDG as Hex, amount: 10_000n },
  spender: contracts.X402Escrow as Hex,
  nonce: 2n,
  deadline: 1_800_000_000n,
  witness: {
    reqId: keccak256(toBytes("exact-req")),
    payee: contracts.OffpeakVault as Hex,
    amount: 10_000n,
    validBefore: 1_800_000_000n,
    resourceHash: keccak256(toBytes("resource-exact")),
  },
}
const exactStruct = hashStruct("PermitWitnessTransferFrom", exactTypes as never, exactMessage)
const exactDigest = typedDataDigest(exactStruct, permitSeparator)

const rulingMessage = {
  challengeId: 7n,
  outcome: 1,
  slashBps: 2000,
  refundRoot: keccak256(toBytes("refunds")),
  reasonHash: keccak256(toBytes("metering")),
}
const rulingOrdered = [...rulings].sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))
const rulingSigs = await Promise.all(
  rulingOrdered.slice(0, 2).map((signer) =>
    signer.signTypedData({
      domain: domain("OffpeakAudit", contracts.AuditCourt),
      types: rulingTypes,
      primaryType: "Ruling",
      message: rulingMessage,
    }),
  ),
)

const json = {
  note: "Anvil default mnemonic, accounts 1-9. Private keys are not stored. 1 router, 2 host, 3 buyer, 4-6 settlement, 7-9 ruling.",
  chainId: 4663,
  addresses: {
    router: router.address.toLowerCase(),
    host: host.address.toLowerCase(),
    buyer: buyer.address.toLowerCase(),
    settlers: settlers.map((s) => s.address.toLowerCase()),
    rulings: rulings.map((s) => s.address.toLowerCase()),
    contracts,
  },
  priceSheet: {
    hash: sheetHash,
    structHash: sheetStruct,
    signature: priceSig,
    host: priceMessage.host,
    modelDigest: priceMessage.modelDigest,
    floorIn: priceMessage.floorIn.toString(),
    floorOut: priceMessage.floorOut.toString(),
    validFrom: priceMessage.validFrom.toString(),
    nonce: priceMessage.nonce.toString(),
    baseIn0: priceMessage.baseIn[0]!.toString(),
    baseOut0: priceMessage.baseOut[0]!.toString(),
  },
  usage: signed,
  merkle: { root, proofs },
  hourClose: {
    hour: hourCloseMessage.hour.toString(),
    records: hourCloseMessage.records,
    root,
    totalsHash,
    signature: hourCloseSig,
    totals: {
      records: totals.records,
      tokensIn: totals.tokensIn.toString(),
      tokensOut: totals.tokensOut.toString(),
      prepaidDebit: totals.prepaidDebit.toString(),
      agentCollected: totals.agentCollected.toString(),
      windowDrawn: totals.windowDrawn.toString(),
      hostCredit: totals.hostCredit.toString(),
      fees: totals.fees.toString(),
    },
  },
  settleBatch: {
    thresholdSig: `0x${pairSigs.map((s) => s.slice(2)).join("")}`,
    signers: pair.map((p) => p.address.toLowerCase()),
    fees: fees.toString(),
    agentPoolDraw: agentCollected.toString(),
    reserveDraw: "0",
  },
  refundBatch: {
    batchId: refundMessage.batchId.toString(),
    payer: refundMessage.refunds[0]!.payer,
    amount: refundMessage.refunds[0]!.amount.toString(),
    refundId: refundMessage.refunds[0]!.refundId,
    structHash: hashStruct("RefundBatch", refundTypes as never, refundMessage),
    thresholdSig: `0x${refundSigs.map((s) => s.slice(2)).join("")}`,
  },
  rewardBatch: {
    week: rewardMessage.week.toString(),
    host: rewardMessage.credits[0]!.host,
    amount: rewardMessage.credits[0]!.amount.toString(),
    structHash: hashStruct("RewardBatch", rewardTypes as never, rewardMessage),
    thresholdSig: `0x${rewardSigs.map((s) => s.slice(2)).join("")}`,
  },
  voucher: {
    channelId,
    seq: "1",
    cumulative: "123456",
    signature: voucherSig,
  },
  permit2: {
    uptoWitnessType: UPTO_WITNESS_TYPESTRING,
    exactWitnessType: EXACT_WITNESS_TYPESTRING,
    channelWitnessType: CHANNEL_WITNESS_TYPESTRING,
    uptoDigest,
    exactDigest,
    uptoStruct,
    exactStruct,
  },
  ruling: {
    challengeId: "7",
    outcome: 1,
    slashBps: 2000,
    refundRoot: rulingMessage.refundRoot,
    reasonHash: rulingMessage.reasonHash,
    thresholdSig: `0x${rulingSigs.map((s) => s.slice(2)).join("")}`,
    signers: rulingOrdered.slice(0, 2).map((s) => s.address.toLowerCase()),
  },
}

const out = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/vectors.json")
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`)
console.log(`wrote ${out}`)
