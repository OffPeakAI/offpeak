import { canonicalJson } from "@offpeak/shared"
import { bytesToHex, type Hex } from "viem"
import { REPLAY_WINDOW_MS, clientTimeMs, generateHostKey, openRequest, publicKeyBytes, requestEnc, withinReplayWindow } from "../../../../packages/sdk/src/sealed/hpke.ts"

export { HPKE_STREAM_CONTENT_TYPE, SEALED_PATH, concatBytes, responseKey, sealFrame } from "../../../../packages/sdk/src/sealed/hpke.ts"

/** Above this many live entries the agent refuses, since dropping one would let it be replayed. */
const REPLAY_MAX_ENTRIES = 200_000
const TIME_FIELD_END = 9

/** Every `enc` seen inside the window. A restart clears this, and also brings a new key that old requests cannot open. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>()

  has(enc: string) {
    return this.seen.has(enc)
  }

  /** False for an `enc` already taken, or when the book is full. */
  take(enc: string, clientMs: bigint, nowMs: number) {
    if (this.seen.size >= REPLAY_MAX_ENTRIES) this.sweep(nowMs)
    if (this.seen.has(enc) || this.seen.size >= REPLAY_MAX_ENTRIES) return false
    this.seen.set(enc, Number(clientMs) + REPLAY_WINDOW_MS)
    return true
  }

  private sweep(nowMs: number) {
    for (const [enc, expiresAt] of this.seen) if (expiresAt < nowMs) this.seen.delete(enc)
  }
}

export type OpenRefusal = "bad_time" | "replayed_enc" | "cannot_open"

export type OpenedRequest = { plaintext: Uint8Array; enc: Uint8Array; secret: Uint8Array }

/** The VM's key pair. The private half is a non-extractable key held in this object, and nothing writes it anywhere. */
export class HpkeIdentity {
  readonly #privateKey: CryptoKey
  private readonly replay = new ReplayGuard()

  private constructor(
    keys: CryptoKeyPair,
    readonly publicKey: Hex,
  ) {
    this.#privateKey = keys.privateKey
  }

  static async generate() {
    const keys = await generateHostKey()
    return new HpkeIdentity(keys, bytesToHex(await publicKeyBytes(keys.publicKey)))
  }

  /** `enc` is taken only after the request opens, so nobody can burn a client's `enc` with bytes of their own. */
  async open(bytes: Uint8Array, path: string, nowMs: number): Promise<OpenedRequest | { refused: OpenRefusal }> {
    if (bytes.length < TIME_FIELD_END) return { refused: "cannot_open" }
    const clientMs = clientTimeMs(bytes)
    if (!withinReplayWindow(clientMs, nowMs)) return { refused: "bad_time" }
    const enc = bytesToHex(requestEnc(bytes))
    if (this.replay.has(enc)) return { refused: "replayed_enc" }
    let opened: OpenedRequest
    try {
      opened = await openRequest(this.#privateKey, bytes, path)
    } catch {
      return { refused: "cannot_open" }
    }
    // Checked again here, because two copies can both pass the first check while they decrypt.
    if (!this.replay.take(enc, clientMs, nowMs)) return { refused: "replayed_enc" }
    return opened
  }
}

/** What the router signs for a sealed request: the ciphertext, plus the two limits the VM must hold it to. */
export function sealedReqPayload(input: { bodyHash: string; maxTokens: number; model: string }) {
  return canonicalJson({ bodyHash: input.bodyHash, maxTokens: input.maxTokens, model: input.model })
}
