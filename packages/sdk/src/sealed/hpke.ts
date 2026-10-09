import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core"
import { OffpeakError } from "../core.ts"

export const HPKE_INFO = "offpeak-hpke/v1"
export const RESPONSE_EXPORT = "offpeak-hpke/v1 response"
export const HPKE_CONTENT_TYPE = "application/offpeak-hpke"
export const HPKE_STREAM_CONTENT_TYPE = "application/offpeak-hpke-stream"
/** The path bound into a request's AAD. It is the one the client called, whichever route the host serves it on. */
export const SEALED_PATH = "/v1/chat/completions"
export const REPLAY_WINDOW_MS = 60_000

const WIRE_VERSION = 0x01
const REQUEST_HEADER_BYTES = 9
const ENC_BYTES = 32
const TAG_BYTES = 16
const RESPONSE_KEY_BYTES = 16
const RESPONSE_NONCE_BYTES = 12

export const REQUEST_MIN_BYTES = REQUEST_HEADER_BYTES + ENC_BYTES + TAG_BYTES
/** Room for what a chat template adds to a prompt of almost no bytes, such as a tool preamble. */
const TEMPLATE_TOKENS = 256
export const RESPONSE_SALT_BYTES = 16
export const FRAME_HEADER_BYTES = 5
/** A reader refuses to buffer more than this for one frame, so a bad length cannot run a client out of memory. */
export const FRAME_MAX_BYTES = 1024 * 1024
/** Stream bytes one host frame holds. Under the `upto` budget, so the first frame, which goes out before any authorization, can never pass it. */
export const FRAME_DATA_BYTES = 200
const FRAME_LENGTH_BYTES = 2
const FRAME_PADDED_BYTES = FRAME_LENGTH_BYTES + FRAME_DATA_BYTES
/** Every host frame is this long on the wire, whatever it holds, so sizes say nothing about the tokens inside. */
export const FRAME_WIRE_BYTES = FRAME_HEADER_BYTES + FRAME_PADDED_BYTES + TAG_BYTES
export const FLAG_DATA = 0x00
export const FLAG_LAST = 0x01

const encoder = new TextEncoder()
const utf8 = (text: string) => encoder.encode(text)

/** WebCrypto takes views over plain buffers only, and a copy always is one. */
const own = (view: Uint8Array) => new Uint8Array(view)

export function concatBytes(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export function suite() {
  return new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes128Gcm(),
  })
}

/** A key pair whose private half cannot be exported, even by this process. */
export async function generateHostKey() {
  return (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair
}

export async function publicKeyBytes(key: CryptoKey) {
  return new Uint8Array(await suite().kem.serializePublicKey(key))
}

export function publicKeyFrom(raw: Uint8Array) {
  if (raw.length !== ENC_BYTES) throw new OffpeakError("sealed_bad_key", "A host key is 32 bytes")
  return suite().kem.deserializePublicKey(own(raw).buffer)
}

function aadFor(header: Uint8Array, path: string) {
  if (!/^[\x20-\x7e]+$/.test(path)) throw new OffpeakError("sealed_bad_path", "The path must be ASCII")
  return concatBytes(header, utf8(path))
}

export async function sealRequest(publicKey: CryptoKey, plaintext: Uint8Array, path: string, nowMs: number) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new OffpeakError("sealed_bad_time", "Client time must be whole milliseconds")
  const sender = await suite().createSenderContext({ recipientPublicKey: publicKey, info: utf8(HPKE_INFO) })
  const header = new Uint8Array(REQUEST_HEADER_BYTES)
  header[0] = WIRE_VERSION
  new DataView(header.buffer).setBigUint64(1, BigInt(nowMs))
  const ct = new Uint8Array(await sender.seal(own(plaintext), aadFor(header, path)))
  const enc = new Uint8Array(sender.enc)
  const secret = new Uint8Array(await sender.export(utf8(RESPONSE_EXPORT), RESPONSE_KEY_BYTES))
  return { bytes: concatBytes(header, enc, ct), enc, secret }
}

export async function openRequest(privateKey: CryptoKey, bytes: Uint8Array, path: string) {
  if (bytes.length < REQUEST_MIN_BYTES) throw new OffpeakError("sealed_bad_request", "Request is too short")
  if (bytes[0] !== WIRE_VERSION) throw new OffpeakError("sealed_bad_request", "Unknown wire version")
  const header = bytes.subarray(0, REQUEST_HEADER_BYTES)
  const enc = bytes.slice(REQUEST_HEADER_BYTES, REQUEST_HEADER_BYTES + ENC_BYTES)
  const ct = bytes.subarray(REQUEST_HEADER_BYTES + ENC_BYTES)
  const recipient = await suite().createRecipientContext({ recipientKey: privateKey, enc: enc.buffer, info: utf8(HPKE_INFO) })
  const plaintext = new Uint8Array(await recipient.open(own(ct), aadFor(header, path)))
  const secret = new Uint8Array(await recipient.export(utf8(RESPONSE_EXPORT), RESPONSE_KEY_BYTES))
  return { plaintext, enc, secret }
}

/** The most tokens a request of this many bytes can hold, since a token takes at least a byte. Holds and bills both stop here. */
export const inputTokenCeiling = (requestBytes: number) => requestBytes + TEMPLATE_TOKENS

export function requestEnc(bytes: Uint8Array) {
  return bytes.subarray(REQUEST_HEADER_BYTES, REQUEST_HEADER_BYTES + ENC_BYTES)
}

/** A `bigint`, since the wire allows values a number cannot hold exactly. */
export function clientTimeMs(bytes: Uint8Array): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(1)
}

export function withinReplayWindow(clientMs: bigint, nowMs: number) {
  const gap = clientMs - BigInt(nowMs)
  return (gap < 0n ? -gap : gap) <= BigInt(REPLAY_WINDOW_MS)
}

export type ResponseKey = { key: CryptoKey; nonce: Uint8Array }

export async function responseKey(secret: Uint8Array, enc: Uint8Array, responseSalt: Uint8Array): Promise<ResponseKey> {
  const base = await crypto.subtle.importKey("raw", own(secret), "HKDF", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: concatBytes(enc, responseSalt), info: utf8(RESPONSE_EXPORT) }, base, (RESPONSE_KEY_BYTES + RESPONSE_NONCE_BYTES) * 8)
  const raw = new Uint8Array(bits)
  const key = await crypto.subtle.importKey("raw", raw.slice(0, RESPONSE_KEY_BYTES), "AES-GCM", false, ["encrypt", "decrypt"])
  return { key, nonce: raw.slice(RESPONSE_KEY_BYTES) }
}

export function frameNonce(base: Uint8Array, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 32) throw new OffpeakError("sealed_bad_frame", "Too many frames")
  const out = new Uint8Array(base)
  const view = new DataView(out.buffer)
  view.setUint32(out.length - 4, (view.getUint32(out.length - 4) ^ index) >>> 0)
  return out
}

export function frameHeader(flag: number, ciphertextBytes: number) {
  const header = new Uint8Array(FRAME_HEADER_BYTES)
  header[0] = flag
  new DataView(header.buffer).setUint32(1, ciphertextBytes)
  return header
}

/** `len(u16 BE) ‖ data ‖ zeros`, always the same length. */
function pad(data: Uint8Array) {
  if (data.length > FRAME_DATA_BYTES) throw new OffpeakError("sealed_bad_frame", "Too much data for one frame")
  const out = new Uint8Array(FRAME_PADDED_BYTES)
  new DataView(out.buffer).setUint16(0, data.length)
  out.set(data, FRAME_LENGTH_BYTES)
  return out
}

function unpad(padded: Uint8Array) {
  const size = padded.length === FRAME_PADDED_BYTES ? new DataView(padded.buffer).getUint16(0) : Infinity
  if (size > FRAME_DATA_BYTES) throw new OffpeakError("sealed_bad_frame", "A frame failed its check")
  return padded.slice(FRAME_LENGTH_BYTES, FRAME_LENGTH_BYTES + size)
}

/**
 * The header is the AAD. The router relays these bytes, and an unbound flag would let it cut a
 * stream short and mark the frame it stopped at as the last one.
 */
export async function sealFrame(response: ResponseKey, index: number, plaintext: Uint8Array, last: boolean) {
  const header = frameHeader(last ? FLAG_LAST : FLAG_DATA, FRAME_PADDED_BYTES + TAG_BYTES)
  const params = { name: "AES-GCM", iv: frameNonce(response.nonce, index), additionalData: header }
  const ct = new Uint8Array(await crypto.subtle.encrypt(params, response.key, pad(plaintext)))
  return concatBytes(header, ct)
}

export async function openFrame(response: ResponseKey, index: number, flag: number, ciphertext: Uint8Array) {
  const params = { name: "AES-GCM", iv: frameNonce(response.nonce, index), additionalData: frameHeader(flag, ciphertext.length) }
  let padded: Uint8Array
  try {
    padded = new Uint8Array(await crypto.subtle.decrypt(params, response.key, own(ciphertext)))
  } catch {
    throw new OffpeakError("sealed_bad_frame", "A frame failed its check")
  }
  return unpad(padded)
}
