/// <reference path="./secp256k1.d.ts" />
import { fork, type ChildProcess } from "node:child_process"
import { availableParallelism } from "node:os"
import { fileURLToPath } from "node:url"
import { keccak_256 } from "@noble/hashes/sha3"
import secp256k1 from "secp256k1"
import { bytesToHex, hashTypedData, type Hex } from "viem"

const keyAddress = new Map<string, Hex>()

function addressOfKey(privateKey: Hex): Hex {
  const cached = keyAddress.get(privateKey)
  if (cached) return cached
  const pub = secp256k1.publicKeyCreate(Buffer.from(privateKey.slice(2), "hex"), false)
  const addr = `0x${Buffer.from(keccak_256(pub.subarray(1))).subarray(12).toString("hex")}` as Hex
  keyAddress.set(privateKey, addr)
  return addr
}

type Job =
  | { id: number; op: "signPersonal"; message: string; privateKey: Hex }
  | { id: number; op: "signRouter"; canon: string; reqId: string; ts: number; privateKey: Hex }
  | { id: number; op: "recoverPersonal"; message: string; signature: Hex }
  | { id: number; op: "signDigest"; hash: Hex; privateKey: Hex }
  | { id: number; op: "recoverDigest"; hash: Hex; signature: Hex }

type NewJob = Job extends infer J ? (J extends Job ? Omit<J, "id"> : never) : never

type Waiter = { resolve: (value: string) => void; reject: (error: Error) => void; job: Job }

type Reply = {
  kind: string
  ids: number[]
  error?: string
  sigs?: Uint8Array
  addrs?: Uint8Array
  messages?: string[]
  bodyHashes?: Uint8Array
}

export type Keyed = { getHdKey?: () => { privateKey: Uint8Array | null }; localKey?: Hex }

let seq = 1
let idleMs = 50
const waiters = new Map<number, Waiter>()
let queue: Job[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let workers: ChildProcess[] | null = null
let idle: ReturnType<typeof setTimeout> | null = null
let applying = false
const inbox: Reply[] = []
const verified = new Map<string, Hex>()

function cacheKey(signature: string, message: string) {
  return `${signature}\n${message}`
}

function remember(signature: string, message: string, address: string) {
  if (verified.size > 8000) verified.clear()
  verified.set(cacheKey(signature, message), address.toLowerCase() as Hex)
}

function takeCached(signature: string, message: string): Hex | undefined {
  const key = cacheKey(signature, message)
  const hit = verified.get(key)
  if (!hit) return undefined
  verified.delete(key)
  return hit
}

function asBuf(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (Array.isArray(value)) return Buffer.from(value)
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return Buffer.from((value as { data: ArrayLike<number> }).data)
  }
  throw new Error("signature worker returned no bytes")
}

function keyBytes(jobs: { privateKey: Hex }[]): Buffer {
  const out = Buffer.alloc(jobs.length * 32)
  for (let i = 0; i < jobs.length; i++) out.write(jobs[i]!.privateKey.slice(2), i * 32, "hex")
  return out
}

function sigBytes(jobs: { signature: Hex }[]): Buffer {
  const out = Buffer.alloc(jobs.length * 65)
  for (let i = 0; i < jobs.length; i++) out.write(jobs[i]!.signature.slice(2), i * 65, "hex")
  return out
}

function hashBytes(jobs: { hash: Hex }[]): Buffer {
  const out = Buffer.alloc(jobs.length * 32)
  for (let i = 0; i < jobs.length; i++) out.write(jobs[i]!.hash.slice(2), i * 32, "hex")
  return out
}

function packStrings(values: string[]): Buffer {
  const encoded = values.map((value) => Buffer.from(value))
  const out = Buffer.alloc(encoded.reduce((sum, buf) => sum + 4 + buf.length, 0))
  let offset = 0
  for (const buf of encoded) {
    out.writeUInt32LE(buf.length, offset)
    offset += 4
    buf.copy(out, offset)
    offset += buf.length
  }
  return out
}

function payload(jobs: Job[]) {
  const ids = jobs.map((job) => job.id)
  const kind = jobs[0]!.op
  if (kind === "signRouter") {
    const rows = jobs as Extract<Job, { op: "signRouter" }>[]
    const reqIds = Buffer.alloc(rows.length * 32)
    rows.forEach((job, index) => reqIds.write(job.reqId.slice(2), index * 32, "hex"))
    return { kind, ids, packedCanons: packStrings(rows.map((job) => job.canon)), reqIds, tss: rows.map((job) => job.ts), keys: keyBytes(rows) }
  }
  if (kind === "signPersonal") {
    const rows = jobs as Extract<Job, { op: "signPersonal" }>[]
    return { kind, ids, messages: rows.map((job) => job.message), keys: keyBytes(rows) }
  }
  if (kind === "recoverPersonal") {
    const rows = jobs as Extract<Job, { op: "recoverPersonal" }>[]
    return { kind, ids, messages: rows.map((job) => job.message), sigs: sigBytes(rows) }
  }
  if (kind === "signDigest") {
    const rows = jobs as Extract<Job, { op: "signDigest" }>[]
    return { kind, ids, hashes: hashBytes(rows), keys: keyBytes(rows) }
  }
  const rows = jobs as Extract<Job, { op: "recoverDigest" }>[]
  return { kind, ids, hashes: hashBytes(rows), sigs: sigBytes(rows) }
}

function armIdle() {
  if (idle) clearTimeout(idle)
  idle = setTimeout(() => {
    if (queue.length === 0 && waiters.size === 0 && workers) {
      const dying = workers
      workers = null
      for (const child of dying) child.kill()
    }
  }, idleMs)
  idle.unref()
}

/** Short by default so test processes exit. A long-running service keeps its workers warm. */
export function keepSigners(ms: number) {
  idleMs = ms
}

function failAll(error: Error) {
  for (const waiter of waiters.values()) waiter.reject(error)
  waiters.clear()
  queue = []
}

function boot() {
  if (workers) return
  const auto = Math.max(1, Math.min(3, availableParallelism() - 1))
  const count = Math.max(1, Math.min(Number(process.env.OFFPEAK_SIG_PROCS ?? auto), availableParallelism()))
  const cwd = fileURLToPath(new URL("..", import.meta.url))
  workers = Array.from({ length: count }, () => {
    const child = fork(fileURLToPath(new URL("./sig-worker.mjs", import.meta.url)), [], {
      cwd,
      execPath: process.execPath,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    let err = ""
    child.stderr?.on("data", (chunk) => {
      err = (err + chunk.toString()).slice(-400)
    })
    child.on("message", (row: Reply) => {
      inbox.push(row)
      if (applying) return
      applying = true
      queueMicrotask(() => {
        applying = false
        const rows = inbox.splice(0, inbox.length)
        for (const queued of rows) applyReply(queued)
      })
    })
    child.on("exit", (code) => {
      if (!workers?.includes(child)) return
      workers = null
      failAll(new Error(err || `signature worker exited ${code ?? ""}`.trim()))
    })
    return child
  })
}
