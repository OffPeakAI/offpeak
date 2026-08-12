import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type Address,
  type Hex,
} from "viem"
import { CHAIN_ID, DOMAIN_VERSION, PERMIT2 } from "./constants.ts"
import { asAddress, asBytes32 } from "./hex.ts"

export type TypedField = { name: string; type: string }

export type TypedTypes = Record<string, readonly TypedField[]>

const ATOMIC = /^(u?int(8|16|32|64|128|256)|address|bool|bytes32|bytes16|uint8)$/

export function encodeType(primary: string, types: TypedTypes): string {
  const deps = new Set<string>()
  function collect(name: string) {
    const fields = types[name]
    if (!fields) throw new Error(`unknown type ${name}`)
    for (const field of fields) {
      const base = field.type.replace(/\[[0-9]*\]$/, "")
      if (base === name) continue
      if (types[base] && !deps.has(base)) {
        deps.add(base)
        collect(base)
      }
    }
  }
  collect(primary)
  deps.delete(primary)
  const ordered = [...deps].sort()
  const self = typeFragment(primary, types)
  return self + ordered.map((name) => typeFragment(name, types)).join("")
}

function typeFragment(name: string, types: TypedTypes): string {
  const fields = types[name]
  if (!fields) throw new Error(`unknown type ${name}`)
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`
}

export function typeHash(primary: string, types: TypedTypes): Hex {
  return keccak256(toBytes(encodeType(primary, types)))
}

function isAtomic(type: string): boolean {
  return ATOMIC.test(type)
}

function encodeAtomic(type: string, value: unknown): Hex {
  if (type === "address") {
    return encodeAbiParameters([{ type: "address" }], [asAddress(String(value))])
  }
  if (type === "bool") {
    return encodeAbiParameters([{ type: "bool" }], [Boolean(value)])
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    const n = typeof value === "bigint" ? value : BigInt(value as number | string)
    return encodeAbiParameters([{ type }], [n])
  }
  if (type === "bytes32" || type === "bytes16") {
    return encodeAbiParameters([{ type: "bytes32" }], [asBytes32(String(value))])
  }
  throw new Error(`unsupported atomic ${type}`)
}

export function hashStruct(primary: string, types: TypedTypes, value: Record<string, unknown>): Hex {
  const fields = types[primary]
  if (!fields) throw new Error(`unknown type ${primary}`)
  const parts: Hex[] = [typeHash(primary, types)]
  for (const field of fields) {
    parts.push(encodeField(field.type, value[field.name], types))
  }
  return keccak256(concat32(parts))
}

function encodeField(type: string, value: unknown, types: TypedTypes): Hex {
  const array = /^(.+)\[(\d*)\]$/.exec(type)
  if (array) {
    const inner = array[1]!
    const arr = value as unknown[]
    const encoded = arr.map((item) => encodeField(inner, item, types))
    return keccak256(concat32(encoded))
  }
  if (type === "string" || type === "bytes") {
    const data = typeof value === "string" && type === "string" ? toBytes(value) : (value as Uint8Array)
    return keccak256(typeof data === "string" ? toBytes(data) : data)
  }
  if (types[type]) {
    return hashStruct(type, types, value as Record<string, unknown>)
  }
  if (!isAtomic(type)) throw new Error(`cannot encode ${type}`)
  return encodeAtomic(type, value)
}

function concat32(parts: Hex[]): Hex {
  return `0x${parts.map((p) => p.slice(2)).join("")}` as Hex
}

export type DomainName =
  | "OffpeakUsage"
  | "OffpeakSettlement"
  | "OffpeakChannel"
  | "OffpeakPriceSheet"
  | "OffpeakAudit"
  | "OffpeakWindows"
  | "Permit2"

export function domain(name: DomainName, verifyingContract: string, chainId = CHAIN_ID) {
  if (name === "Permit2") {
    return {
      name,
      chainId,
      verifyingContract: asAddress(verifyingContract) as Address,
    }
  }
  return {
    name,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract: asAddress(verifyingContract) as Address,
  }
}

export const usageTypes = {
  UsageRecord: [
    { name: "reqId", type: "bytes32" },
    { name: "buyerRef", type: "bytes32" },
    { name: "host", type: "address" },
    { name: "modelDigest", type: "bytes32" },
    { name: "tokensIn", type: "uint32" },
    { name: "tokensOut", type: "uint32" },
    { name: "promptHash", type: "bytes32" },
    { name: "outputHash", type: "bytes32" },
    { name: "priceIn", type: "uint64" },
    { name: "priceOut", type: "uint64" },
    { name: "hostCostMicro", type: "uint64" },
    { name: "feeMicro", type: "uint64" },
    { name: "payMode", type: "uint8" },
    { name: "payRef", type: "bytes32" },
    { name: "ts", type: "uint64" },
    { name: "sheetHash", type: "bytes32" },
  ],
} as const

export const hourCloseTypes = {
  HourClose: [
    { name: "hour", type: "uint64" },
    { name: "records", type: "uint32" },
    { name: "root", type: "bytes32" },
    { name: "totalsHash", type: "bytes32" },
  ],
} as const

export const priceSheetTypes = {
  PriceSheet: [
    { name: "host", type: "address" },
    { name: "modelDigest", type: "bytes32" },
    { name: "baseIn", type: "uint64[168]" },
    { name: "baseOut", type: "uint64[168]" },
    { name: "floorIn", type: "uint64" },
    { name: "floorOut", type: "uint64" },
    { name: "validFrom", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const

export const voucherTypes = {
  Voucher: [
    { name: "channelId", type: "bytes32" },
    { name: "seq", type: "uint64" },
    { name: "cumulative", type: "uint128" },
  ],
} as const

export const coopCloseTypes = {
  CooperativeClose: [
    { name: "channelId", type: "bytes32" },
    { name: "finalCumulative", type: "uint128" },
    { name: "deadline", type: "uint64" },
  ],
} as const

export const settleTypes = {
  SettleBatch: [
    { name: "chainId", type: "uint256" },
    { name: "vault", type: "address" },
    { name: "hour", type: "uint64" },
    { name: "root", type: "bytes32" },
    { name: "totalsHash", type: "bytes32" },
    { name: "debits", type: "Debit[]" },
    { name: "credits", type: "Credit[]" },
    { name: "windowDraws", type: "WindowDraw[]" },
    { name: "fees", type: "uint128" },
    { name: "agentPoolDraw", type: "uint128" },
    { name: "reserveDraw", type: "uint128" },
    { name: "agentPaymentsHash", type: "bytes32" },
  ],
  Debit: [
    { name: "buyer", type: "address" },
    { name: "amount", type: "uint128" },
    { name: "lastTs", type: "uint64" },
  ],
  Credit: [
    { name: "host", type: "address" },
    { name: "amount", type: "uint128" },
  ],
  WindowDraw: [
    { name: "windowId", type: "uint256" },
    { name: "holder", type: "address" },
    { name: "tokens", type: "uint64" },
  ],
} as const

export const refundTypes = {
  RefundBatch: [
    { name: "batchId", type: "uint64" },
    { name: "refunds", type: "Refund[]" },
  ],
  Refund: [
    { name: "payer", type: "address" },
    { name: "amount", type: "uint128" },
    { name: "refundId", type: "bytes32" },
  ],
} as const

export const rewardTypes = {
  RewardBatch: [
    { name: "week", type: "uint64" },
    { name: "credits", type: "Credit[]" },
  ],
  Credit: settleTypes.Credit,
} as const

export const rulingTypes = {
  Ruling: [
    { name: "challengeId", type: "uint256" },
    { name: "outcome", type: "uint8" },
    { name: "slashBps", type: "uint16" },
    { name: "refundRoot", type: "bytes32" },
    { name: "reasonHash", type: "bytes32" },
  ],
} as const

export const panelTypes = {
  PanelDecision: [
    { name: "challengeId", type: "uint256" },
    { name: "decision", type: "uint8" },
    { name: "finalSlashBps", type: "uint16" },
    { name: "refundRoot", type: "bytes32" },
    { name: "reasonHash", type: "bytes32" },
  ],
} as const

export const windowPerfTypes = {
  WindowPerformance: [
    { name: "windowId", type: "uint256" },
    { name: "measuredSeconds", type: "uint32" },
    { name: "belowMinSeconds", type: "uint32" },
    { name: "evidenceRoot", type: "bytes32" },
  ],
} as const

export const uptoWitnessTypes = {
  UptoWitness: [
    { name: "reqId", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "maxAmount", type: "uint256" },
    { name: "validBefore", type: "uint64" },
    { name: "resourceHash", type: "bytes32" },
  ],
} as const

export const exactWitnessTypes = {
  ExactWitness: [
    { name: "reqId", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "validBefore", type: "uint64" },
    { name: "resourceHash", type: "bytes32" },
  ],
} as const

export const channelOpenWitnessTypes = {
  ChannelOpenWitness: [
    { name: "channelSalt", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "expiry", type: "uint64" },
  ],
} as const

export const tokenPermissionTypes = {
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const

/** Witness type strings Permit2 requires, referenced types in alphabetical order. */
export const UPTO_WITNESS_TYPESTRING =
  "UptoWitness witness)TokenPermissions(address token,uint256 amount)UptoWitness(bytes32 reqId,address payee,uint256 maxAmount,uint64 validBefore,bytes32 resourceHash)"
export const EXACT_WITNESS_TYPESTRING =
  "ExactWitness witness)ExactWitness(bytes32 reqId,address payee,uint256 amount,uint64 validBefore,bytes32 resourceHash)TokenPermissions(address token,uint256 amount)"
export const CHANNEL_WITNESS_TYPESTRING =
  "ChannelOpenWitness witness)ChannelOpenWitness(bytes32 channelSalt,address payee,uint64 expiry)TokenPermissions(address token,uint256 amount)"

export function permitWitnessTypes(witnessName: "UptoWitness" | "ExactWitness" | "ChannelOpenWitness") {
  const witness =
    witnessName === "UptoWitness"
      ? uptoWitnessTypes.UptoWitness
      : witnessName === "ExactWitness"
        ? exactWitnessTypes.ExactWitness
        : channelOpenWitnessTypes.ChannelOpenWitness
  return {
    PermitWitnessTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "witness", type: witnessName },
    ],
    TokenPermissions: tokenPermissionTypes.TokenPermissions,
    [witnessName]: witness,
  } as const
}

export function usageStructHash(record: Record<string, unknown>): Hex {
  return hashStruct("UsageRecord", usageTypes as unknown as TypedTypes, record)
}

export function usageDigest(record: Record<string, unknown>, usageLedger: string): Hex {
  return hashTypedData({
    domain: domain("OffpeakUsage", usageLedger),
    types: usageTypes,
    primaryType: "UsageRecord",
    message: record as never,
  })
}

export async function recoverUsageSigner(record: Record<string, unknown>, signature: Hex, usageLedger: string) {
  return recoverTypedDataAddress({
    domain: domain("OffpeakUsage", usageLedger),
    types: usageTypes,
    primaryType: "UsageRecord",
    message: record as never,
    signature,
  })
}

export { PERMIT2 }
