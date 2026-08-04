import { sha256 } from "@noble/hashes/sha2"
import { keccak_256 } from "@noble/hashes/sha3"
import {
  bytesToHex,
  encodeAbiParameters,
  keccak256,
  type Hex,
} from "viem"

import { canonicalJson } from "./canonical.ts"
import { asAddress, asBytes32 } from "./hex.ts"

const textEncoder = new TextEncoder()

export function keccakUtf8(value: string): Hex {
  return bytesToHex(keccak_256(textEncoder.encode(value)))
}

export function sha256Hex(data: Uint8Array | string): Hex {
  return bytesToHex(sha256(typeof data === "string" ? textEncoder.encode(data) : data))
}

export function buyerRefOf(payer: string, reqId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [asAddress(payer), asBytes32(reqId)],
    ),
  )
}

export function modelDigestOf(weightsSha256: string, tokenizerSha256: string, chatTemplateSha256: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [asBytes32(weightsSha256), asBytes32(tokenizerSha256), asBytes32(chatTemplateSha256)],
    ),
  )
}

/** Sorted `path\\tsha256\\n` lines, then sha256 of that text. */
export function manifestSha256(files: { path: string; sha256: string }[]): Hex {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\t${f.sha256.replace(/^0x/, "")}`)
  return sha256Hex(`${lines.join("\n")}${lines.length ? "\n" : ""}`)
}

export function gpuClassOf(name: string): Hex {
  return keccakUtf8(name)
}

/** OCI digest `sha256:<hex>` with the prefix stripped, as bytes32. */
export function imageDigestOf(ociOrHex: string): Hex {
  const raw = ociOrHex.startsWith("sha256:") ? ociOrHex.slice("sha256:".length) : ociOrHex.replace(/^0x/, "")
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error("image digest must be 32 bytes")
  return `0x${raw.toLowerCase()}` as Hex
}

export function promptHashOf(body: unknown): Hex {
  return keccakUtf8(canonicalJson(body))
}

export function outputHashOf(text: string, toolCalls: unknown[] | null | undefined): Hex {
  const calls = canonicalJson(toolCalls ?? [])
  return keccakUtf8(`${text}\u0000${calls}`)
}

export function ciphertextHashOf(bytes: Uint8Array): Hex {
  return keccak256(bytes)
}

export function channelPaymentId(channelId: string, seq: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }],
      [asBytes32(channelId), seq],
    ),
  )
}

export function reqIdFromUlid(ulid: string): Hex {
  return keccakUtf8(ulid)
}

export function agentPaymentsHash(paymentIds: string[]): Hex {
  const sorted = [...paymentIds].map((id) => asBytes32(id)).sort()
  return keccak256(
    encodeAbiParameters([{ type: "bytes32[]" }], [sorted]),
  )
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export function ulid(nowMs: number, entropy: Uint8Array): string {
  if (entropy.length < 10) throw new Error("ulid entropy needs 10 bytes")
  let time = nowMs
  let t = ""
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[time % 32]! + t
    time = Math.floor(time / 32)
  }
  let e = ""
  // 80 bits from 10 bytes
  let bits = 0
  let acc = 0
  for (const byte of entropy) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      e += CROCKFORD[(acc >> bits) & 31]
    }
  }
  return t + e
}
