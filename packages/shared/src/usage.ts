import type { Hex } from "viem"
import { ZERO_BYTES32 } from "./constants.ts"
import { usageStructHash } from "./eip712.ts"
import { asAddress, asBytes32 } from "./hex.ts"
import { usageLeaf } from "./merkle.ts"

export type PayMode = 0 | 1 | 2 | 3 | 4

export type UsageRecord = {
  reqId: Hex
  buyerRef: Hex
  host: Hex
  modelDigest: Hex
  tokensIn: number
  tokensOut: number
  promptHash: Hex
  outputHash: Hex
  priceIn: bigint
  priceOut: bigint
  hostCostMicro: bigint
  feeMicro: bigint
  payMode: PayMode
  payRef: Hex
  ts: number
  sheetHash: Hex
}

export type UsageEnvelope = {
  v: 1
  record: UsageRecord
  routerSig: Hex
  hostSig: Hex
  leaf: Hex
  hostCounts: { tokensIn: number; tokensOut: number }
  sealed: boolean
  proofUrl: string
}

export type UsageRecordJson = {
  [K in keyof UsageRecord]: UsageRecord[K] extends bigint ? string : UsageRecord[K]
}

export function recordToMessage(r: UsageRecord): Record<string, unknown> {
  return {
    reqId: asBytes32(r.reqId),
    buyerRef: asBytes32(r.buyerRef),
    host: asAddress(r.host),
    modelDigest: asBytes32(r.modelDigest),
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    promptHash: asBytes32(r.promptHash),
    outputHash: asBytes32(r.outputHash),
    priceIn: r.priceIn,
    priceOut: r.priceOut,
    hostCostMicro: r.hostCostMicro,
    feeMicro: r.feeMicro,
    payMode: r.payMode,
    payRef: asBytes32(r.payRef),
    ts: BigInt(r.ts),
    sheetHash: asBytes32(r.sheetHash),
  }
}

export function leafFor(r: UsageRecord, routerSig: Hex, hostSig: Hex): Hex {
  return usageLeaf(usageStructHash(recordToMessage(r)), routerSig, hostSig)
}

export function serializeRecord(r: UsageRecord): UsageRecordJson {
  return {
    reqId: r.reqId,
    buyerRef: r.buyerRef,
    host: asAddress(r.host),
    modelDigest: r.modelDigest,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    promptHash: r.promptHash,
    outputHash: r.outputHash,
    priceIn: r.priceIn.toString(),
    priceOut: r.priceOut.toString(),
    hostCostMicro: r.hostCostMicro.toString(),
    feeMicro: r.feeMicro.toString(),
    payMode: r.payMode,
    payRef: r.payRef,
    ts: r.ts,
    sheetHash: r.sheetHash,
  }
}

export function parseRecord(j: UsageRecordJson): UsageRecord {
  return {
    reqId: asBytes32(j.reqId),
    buyerRef: asBytes32(j.buyerRef),
    host: asAddress(j.host),
    modelDigest: asBytes32(j.modelDigest),
    tokensIn: j.tokensIn,
    tokensOut: j.tokensOut,
    promptHash: asBytes32(j.promptHash),
    outputHash: asBytes32(j.outputHash),
    priceIn: BigInt(j.priceIn),
    priceOut: BigInt(j.priceOut),
    hostCostMicro: BigInt(j.hostCostMicro),
    feeMicro: BigInt(j.feeMicro),
    payMode: j.payMode,
    payRef: j.payRef === ZERO_BYTES32 ? ZERO_BYTES32 : asBytes32(j.payRef),
    ts: j.ts,
    sheetHash: asBytes32(j.sheetHash),
  }
}

export function serializeEnvelope(env: UsageEnvelope) {
  return {
    v: 1 as const,
    record: serializeRecord(env.record),
    routerSig: env.routerSig,
    hostSig: env.hostSig,
    leaf: env.leaf,
    hostCounts: env.hostCounts,
    sealed: env.sealed,
    proofUrl: env.proofUrl,
  }
}

export function parseEnvelope(raw: {
  v: 1
  record: UsageRecordJson
  routerSig: Hex
  hostSig: Hex
  leaf: Hex
  hostCounts: { tokensIn: number; tokensOut: number }
  sealed: boolean
  proofUrl: string
}): UsageEnvelope {
  return {
    v: 1,
    record: parseRecord(raw.record),
    routerSig: raw.routerSig,
    hostSig: raw.hostSig,
    leaf: raw.leaf,
    hostCounts: raw.hostCounts,
    sealed: raw.sealed,
    proofUrl: raw.proofUrl,
  }
}
