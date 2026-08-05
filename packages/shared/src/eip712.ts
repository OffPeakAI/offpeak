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
