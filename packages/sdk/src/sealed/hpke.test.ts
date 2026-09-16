import { describe, expect, test } from "bun:test"
import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem"
import { FLAG_DATA, FLAG_LAST, FRAME_DATA_BYTES, FRAME_WIRE_BYTES, HPKE_INFO, SEALED_PATH, clientTimeMs, concatBytes, frameNonce, generateHostKey, openFrame, openRequest, publicKeyBytes, publicKeyFrom, requestEnc, responseKey, sealFrame, sealRequest, suite, withinReplayWindow } from "./hpke.ts"
import { FLAG_TRAILER, FrameSplitter, encodeTrailer, openResponse, type OpenedResponse } from "./stream.ts"

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const buffer = (hex: Hex) => hexToBytes(hex).slice().buffer

/** RFC 9180 appendix A.1.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode. */
const RFC = {
  info: "0x4f6465206f6e2061204772656369616e2055726e",
  ikmE: "0x7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234",
  ikmR: "0x6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037",
  pkRm: "0x3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d",
  enc: "0x37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431",
  pt: "0x4265617574792069732074727574682c20747275746820626561757479",
  aad: "0x436f756e742d30",
  ct: "0xf938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a",
  exported: "0x3853fe2b4035195a573ffc53856e77058e15d9ea064de3e59f4961d0095250ee",
} as const

/** Offpeak's own format, frozen. Changing the wire breaks this on purpose. */
const WIRE = {
  ikmR: RFC.ikmR,
  time: 1_762_000_000_000n,
  plaintext: '{"model":"ofm-8b","messages":[{"role":"user","content":"hi"}],"stream":true,"max_tokens":8}',
  request:
    "0x010000019a3f62540037fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf443110c3df63bea95b46fbd77947c83ee65e6ca53d18e3d6eb65e788cd7a6d384a4e330fd7e4fcd3fca19ab87627fd15604ca17193e4bb00312b547523125b01e71bae5a0c41de16af13b0f5c1edeae008e5730306b0c3a73e1480096f80b434c8a635670ccd07e589918e2ae1",
  responseExport: "0x2d59aec88e5b75ee8923c3be4fc3223c",
  response:
    "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a00000000da8996ced5a3526936dd9a1849cc09e9d26439e0beb4512be1e8202d74d12ddcb2d8979fb31917bb5c885a32a93d27f264dbd5546bdd4bc37078bbc88eaca4bab0cdc8bb62fdeaa58a93955a8e7ddc8bb00ea72a5e66cfe54f7d5e50f439b18f247e3c3acb8e1ed1fead97e910374e1713b566de100b732ccc9324cc45fa21958243c4cd9739e306e4ca01d65c419145e3467d79795226ba71e3719595084e3e5b72914699c5a789a310dcdc8d659d5ab7ae0fd8941d4f9a063b7e173a15734ba1ba89dc8dc5a9d43ffcbd29dfc4f34c08e58565aed811a472c9c601000000da6b4be9e77692c5035a3810b04fe74298e39f3b299db86169a947eef611b6a87b4032a53a6ce8f459677378847a62ba2304767ca66b9712ee713fc1ff90caebdbeadf9d558b26f104645d51e7327cceadf58f5ab292a73797f1e2ac4c4d4bb07c4b439e44bb944ee31988ca7914f761755c940b537c0aae061c2f5e24bd3bda0f1e5faa712508034ed969318073c46ca767d762461a2466663a841de145cde299039e229c072c148503db18cf51373afd7c7cc3804603e1411e32d3764721c3775ec820b786c057df89d9119958e5f485c70d3cad8e463b924977",
} as const

const streamOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

async function readAll(body: ReadableStream<Uint8Array>, secret: Uint8Array, enc: Uint8Array) {
  const parts: Uint8Array[] = []
  let opened: OpenedResponse | null = null
  for await (const part of openResponse(body, secret, enc, (result) => (opened = result))) parts.push(part)
  return { text: decode(concatBytes(...parts)), opened: opened as OpenedResponse | null }
}

/** A short response under fixed keys, with its frames apart, so a test can damage any one of them. */
async function response(...pieces: string[]) {
  const secret = new Uint8Array(16).fill(7)
  const enc = new Uint8Array(32).fill(9)
  const salt = new Uint8Array(16).fill(3)
  const keys = await responseKey(secret, enc, salt)
  const frames: Uint8Array[] = []
  for (const [index, piece] of pieces.entries()) frames.push(await sealFrame(keys, index, encode(piece), index === pieces.length - 1))
  return { secret, enc, salt, keys, frames }
}

describe("RFC 9180", () => {
  test("the suite reproduces appendix A.1.1", async () => {
    const hpke = suite()
    const recipient = await hpke.kem.deriveKeyPair(buffer(RFC.ikmR))
    expect(bytesToHex(await publicKeyBytes(recipient.publicKey))).toBe(RFC.pkRm)
    const sender = await hpke.createSenderContext({ recipientPublicKey: recipient.publicKey, info: hexToBytes(RFC.info), ekm: await hpke.kem.deriveKeyPair(buffer(RFC.ikmE)) })
    expect(bytesToHex(new Uint8Array(sender.enc))).toBe(RFC.enc)
    expect(bytesToHex(new Uint8Array(await sender.seal(buffer(RFC.pt), hexToBytes(RFC.aad))))).toBe(RFC.ct)
    expect(bytesToHex(new Uint8Array(await sender.export(new ArrayBuffer(0), 32)))).toBe(RFC.exported)
  })

  test("the suite is the one 4.10 names", () => {
    expect(HPKE_INFO).toBe("offpeak-hpke/v1")
    const hpke = suite()
    expect([hpke.kem.id, hpke.kdf.id, hpke.aead.id]).toEqual([0x0020, 0x0001, 0x0001])
  })
})

describe("frozen wire vector", () => {
  test("a recipient opens the frozen request and reads the frozen response", async () => {
    const { privateKey } = await suite().kem.deriveKeyPair(buffer(WIRE.ikmR))
    const opened = await openRequest(privateKey, hexToBytes(WIRE.request), SEALED_PATH)
    expect(decode(opened.plaintext)).toBe(WIRE.plaintext)
    expect(bytesToHex(opened.secret)).toBe(WIRE.responseExport)
    expect(clientTimeMs(hexToBytes(WIRE.request))).toBe(WIRE.time)
    const read = await readAll(streamOf(hexToBytes(WIRE.response)), opened.secret, opened.enc)
    expect(read.text).toBe("data: {}\n\n")
    expect(read.opened!.outputHash).toBe(keccak256(WIRE.response))
  })
})

describe("request wire", () => {
  test("round trip through a non-extractable host key", async () => {
    const keys = await generateHostKey()
    expect(keys.privateKey.extractable).toBe(false)
    const publicKey = await publicKeyFrom(await publicKeyBytes(keys.publicKey))
    const sealed = await sealRequest(publicKey, encode("canary-sealed-plain"), SEALED_PATH, 1_700_000_000_000)
    expect(sealed.bytes[0]).toBe(0x01)
    expect(sealed.enc.length).toBe(32)
    expect(requestEnc(sealed.bytes)).toEqual(sealed.enc)
    expect(clientTimeMs(sealed.bytes)).toBe(1_700_000_000_000n)
    expect(Buffer.from(sealed.bytes).includes("canary-sealed-plain")).toBe(false)
    const opened = await openRequest(keys.privateKey, sealed.bytes, SEALED_PATH)
    expect(decode(opened.plaintext)).toBe("canary-sealed-plain")
    expect(opened.secret).toEqual(sealed.secret)
  })
