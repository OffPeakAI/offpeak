import secp256k1 from "secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"

const enc = new TextEncoder()

function keccakHex(bytes) {
  return `0x${Buffer.from(keccak_256(bytes)).toString("hex")}`
}

function hashPersonal(message) {
  const bytes = typeof message === "string" ? enc.encode(message) : message
  const prefix = enc.encode(`\u0019Ethereum Signed Message:\n${bytes.length}`)
  const joined = new Uint8Array(prefix.length + bytes.length)
  joined.set(prefix)
  joined.set(bytes, prefix.length)
  return Buffer.from(keccak_256(joined))
}

function addressOf(publicKey) {
  const raw = publicKey.length === 65 ? publicKey.subarray(1) : publicKey
  return Buffer.from(keccak_256(raw)).subarray(12)
}

const HEX = "0123456789abcdef"

function writeHex(buf, offset, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i]
    buf[offset++] = HEX.charCodeAt(v >> 4)
    buf[offset++] = HEX.charCodeAt(v & 15)
  }
  return offset
}

function signChecked(hash, key, into, offset) {
  const signed = secp256k1.ecdsaSign(hash, key)
  into.set(signed.signature, offset)
  into[offset + 64] = signed.recid + 27
}

function signHash(hash, key) {
  const signed = secp256k1.ecdsaSign(hash, key)
  const sig = Buffer.alloc(65)
  sig.set(signed.signature, 0)
  sig[64] = signed.recid + 27
  const pub = secp256k1.ecdsaRecover(signed.signature, signed.recid, hash, false)
  return { sig, addr: addressOf(pub) }
}

function recoverHash(hash, signature) {
  const recidRaw = signature[64]
  const recid = recidRaw >= 27 ? recidRaw - 27 : recidRaw
  const pub = secp256k1.ecdsaRecover(signature.subarray(0, 64), recid, hash, false)
  return addressOf(pub)
}

function unpack(buf) {
  const out = []
  let o = 0
  const raw = Buffer.from(buf)
  while (o < raw.length) {
    const n = raw.readUInt32LE(o)
    o += 4
    out.push(raw.toString("utf8", o, o + n))
    o += n
  }
  return out
}

function handle(msg) {
  const n = msg.ids.length
  const keys = msg.keys ? Buffer.from(msg.keys) : null
  const sigsIn = msg.sigs ? Buffer.from(msg.sigs) : null
  if (msg.kind === "signRouter") {
    const canons = unpack(msg.packedCanons)
    const reqRaw = Buffer.from(msg.reqIds)
    const tss = Array.isArray(msg.tss) ? msg.tss : [...new Float64Array(Buffer.from(msg.tss).buffer, Buffer.from(msg.tss).byteOffset, n)]
    const sigs = Buffer.alloc(65 * n)
    const bodyHashes = Buffer.alloc(32 * n)
    const scratch = Buffer.alloc(256)
    const prefix1 = Buffer.from('{"bodyHash":"0x')
    const mid = Buffer.from('","reqId":"0x')
    const mid2 = Buffer.from('","ts":')
    for (let i = 0; i < n; i++) {
      const bodyHash = Buffer.from(keccak_256(enc.encode(canons[i])))
      bodyHashes.set(bodyHash, i * 32)
      const ts = String(tss[i])
      const msgLen = prefix1.length + 64 + mid.length + 64 + mid2.length + ts.length + 1
      let o = 0
      scratch.set(prefix1, o); o += prefix1.length
      o = writeHex(scratch, o, bodyHash)
      scratch.set(mid, o); o += mid.length
      o = writeHex(scratch, o, reqRaw.subarray(i * 32, i * 32 + 32))
      scratch.set(mid2, o); o += mid2.length
      scratch.write(ts, o, "ascii"); o += ts.length
      scratch[o++] = 125
      const hash = hashPersonal(scratch.subarray(0, msgLen))
      signChecked(hash, keys.subarray(i * 32, i * 32 + 32), sigs, i * 65)
    }
    return { kind: msg.kind, ids: msg.ids, sigs, bodyHashes }
  }
  if (msg.kind === "signPersonal" || msg.kind === "signRouter") {
    const sigs = Buffer.alloc(65 * n)
    const addrs = Buffer.alloc(20 * n)
    const messages = new Array(n)
    const bodyHashes = msg.kind === "signRouter" ? new Array(n) : undefined
    for (let i = 0; i < n; i++) {
      let message = msg.messages?.[i]
      if (msg.kind === "signRouter") {
        const bodyHash = keccakHex(enc.encode(msg.canons[i]))
        bodyHashes[i] = bodyHash
        message = `{"bodyHash":"${bodyHash}","reqId":"${msg.reqIds[i]}","ts":${msg.tss[i]}}`
      }
      messages[i] = message
      const signed = signHash(hashPersonal(message), keys.subarray(i * 32, i * 32 + 32))
      sigs.set(signed.sig, i * 65)
      addrs.set(signed.addr, i * 20)
    }
    return { kind: msg.kind, ids: msg.ids, sigs, addrs, messages: msg.kind === "signRouter" ? undefined : messages, bodyHashes }
  }
  if (msg.kind === "recoverPersonal") {
    const addrs = Buffer.alloc(20 * n)
    for (let i = 0; i < n; i++) {
      try {
        const sig = sigsIn.subarray(i * 65, i * 65 + 65)
        addrs.set(recoverHash(hashPersonal(msg.messages[i]), sig), i * 20)
      } catch {
        /* leave a zero address so the caller rejects the signature */
      }
    }
    return { kind: msg.kind, ids: msg.ids, addrs }
  }
  if (msg.kind === "signDigest") {
    const sigs = Buffer.alloc(65 * n)
    const hashes = Buffer.from(msg.hashes)
    for (let i = 0; i < n; i++) {
      const signed = signHash(hashes.subarray(i * 32, i * 32 + 32), keys.subarray(i * 32, i * 32 + 32))
      sigs.set(signed.sig, i * 65)
    }
    return { kind: msg.kind, ids: msg.ids, sigs }
  }
  const addrs = Buffer.alloc(20 * n)
  const hashes = Buffer.from(msg.hashes)
  for (let i = 0; i < n; i++) {
    addrs.set(recoverHash(hashes.subarray(i * 32, i * 32 + 32), sigsIn.subarray(i * 65, i * 65 + 65)), i * 20)
  }
  return { kind: msg.kind, ids: msg.ids, addrs }
}

function deliver(msg) {
  try {
    process.send?.(handle(msg))
  } catch (error) {
    process.send?.({ kind: "error", ids: msg.ids ?? [], error: error instanceof Error ? error.message : "sig" })
  }
}

process.on("message", deliver)
