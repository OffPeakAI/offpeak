import { getAddress, isAddress, type Hex } from "viem"
import { ZERO_BYTES32 } from "./constants.ts"

export type { Hex }

export function isHex(value: string, bytes?: number): value is Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) return false
  if (bytes === undefined) return true
  return value.length === 2 + bytes * 2
}

export function asBytes32(value: string): Hex {
  if (!isHex(value, 32)) throw new Error(`expected bytes32, got ${value}`)
  return value.toLowerCase() as Hex
}

export function asAddress(value: string): Hex {
  if (!isAddress(value)) throw new Error(`expected address, got ${value}`)
  return value.toLowerCase() as Hex
}

export function checksum(value: string): Hex {
  return getAddress(value)
}

export function zeroBytes32(): Hex {
  return ZERO_BYTES32
}

export function bytes32FromBigint(n: bigint): Hex {
  if (n < 0n) throw new Error("negative")
  const hex = n.toString(16).padStart(64, "0")
  if (hex.length > 64) throw new Error("overflow")
  return `0x${hex}` as Hex
}

export function concatHex(parts: Hex[]): Hex {
  return `0x${parts.map((p) => p.slice(2)).join("")}` as Hex
}
