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
