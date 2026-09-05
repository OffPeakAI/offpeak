import { X402EscrowAbi } from "@offpeak/abis"
import { log, type Metrics } from "@offpeak/common"
import { Queue, Worker, type Job } from "bullmq"
import type { Account, Address, Hex, PublicClient, WalletClient } from "viem"
import { recordGas } from "./gas.ts"

export const CAPTURE_QUEUE = "x402-capture"
const MAX_BATCH = 50
const EXPIRY_GRACE_S = 900
/** A capture still queued this close to expiry needs a person, or the host goes unpaid until write-off. */
const AT_RISK_MARGIN_S = 600
const ATTEMPTS = 10
const BACKOFF_MS = 1_000
const TOKEN = "x402-capture-flusher"
const STATUS_NONE = 0
const STATUS_AUTHORIZED = 1
const STATUS_CAPTURED = 2
const STATUS_EXACT = 4

type CaptureJob = { reqId: Hex; actual: string }

export type CaptureDeps = {
  reader: PublicClient
  writer: WalletClient
  account: Account
  escrow: Address
  metrics: Metrics
  redisUrl: string
  nativeUsd: number
  flushMs: number
}

function connection(redisUrl: string) {
  return { url: redisUrl, maxRetriesPerRequest: null }
}

/** Durable in Redis, so a restart loses no capture. Batches are pulled by hand, as BullMQ has no batch worker. */
export class CaptureQueue {
  private queue: Queue
  private worker: Worker
  private timer: Timer | null = null
  private queued = 0
  private flushing = false

  constructor(private deps: CaptureDeps) {
    this.queue = new Queue(CAPTURE_QUEUE, { connection: connection(deps.redisUrl) })
    this.worker = new Worker(CAPTURE_QUEUE, null, { connection: connection(deps.redisUrl) })
  }

  async add(reqId: Hex, actual: bigint) {
    await this.queue.add(
      "capture",
      { reqId, actual: actual.toString() } satisfies CaptureJob,
      { jobId: reqId, attempts: ATTEMPTS, backoff: { type: "exponential", delay: BACKOFF_MS }, removeOnComplete: true },
    )
    if (++this.queued >= MAX_BATCH) void this.flush()
  }

  start() {
    this.timer = setInterval(() => void this.flush(), this.deps.flushMs)
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    await this.worker.close()
    await this.queue.close()
  }

  private async pull() {
    const jobs: Job<CaptureJob>[] = []
    while (jobs.length < MAX_BATCH) {
      const job = await this.worker.getNextJob(TOKEN, { block: false })
      if (!job) break
      jobs.push(job as Job<CaptureJob>)
    }
    this.queued = 0
    return jobs
  }

  private escrow(reqId: Hex) {
    return this.deps.reader.readContract({ address: this.deps.escrow, abi: X402EscrowAbi, functionName: "escrowView", args: [reqId] })
  }

  /** Splits off items a batch could not carry, since `captureBatch` reverts as a whole on one bad item. */
  private async sort(jobs: Job<CaptureJob>[], now: number) {
    const live: { job: Job<CaptureJob>; actual: bigint }[] = []
    for (const job of jobs) {
      const view = await this.escrow(job.data.reqId)
      if (view.status === STATUS_CAPTURED || view.status === STATUS_EXACT) {
        await job.moveToCompleted("already_settled", TOKEN, false)
      } else if (view.status === STATUS_NONE) {
        await job.moveToFailed(new Error("not_authorized_yet"), TOKEN, false)
      } else if (view.status !== STATUS_AUTHORIZED || now > Number(view.validBefore) + EXPIRY_GRACE_S) {
        log("facilitator", "capture_lost", { reqId: job.data.reqId, status: view.status })
        this.deps.metrics.inc("x402_capture_lost_total")
        await job.discard()
        await job.moveToFailed(new Error("escrow_closed"), TOKEN, false)
      } else {
        const wanted = BigInt(job.data.actual)
        if (wanted > view.max) log("facilitator", "capture_over_max", { reqId: job.data.reqId, wanted, max: view.max })
        if (now > Number(view.validBefore) + EXPIRY_GRACE_S - AT_RISK_MARGIN_S) {
          log("facilitator", "capture_at_risk", { reqId: job.data.reqId })
          this.deps.metrics.inc("x402_capture_at_risk_total")
        }
        live.push({ job, actual: wanted < view.max ? wanted : view.max })
      }
    }
    return live
  }

  async flush() {
    if (this.flushing) return
    this.flushing = true
    try {
      const jobs = await this.pull()
      if (jobs.length > 0) {
        const head = await this.deps.reader.getBlock({ blockTag: "latest" })
        const live = await this.sort(jobs, Number(head.timestamp))
        if (live.length > 0) await this.send(live)
      }
      this.deps.metrics.set("x402_capture_backlog", await this.queue.getJobCountByTypes("waiting", "delayed", "prioritized"))
    } catch (err) {
      log("facilitator", "capture_flush_failed", { error: String(err).slice(0, 200) })
    } finally {
      this.flushing = false
    }
  }

  private async send(live: { job: Job<CaptureJob>; actual: bigint }[]) {
    const { reader, writer, account, escrow, metrics, nativeUsd } = this.deps
    try {
      const { request } = await reader.simulateContract({
        address: escrow,
        abi: X402EscrowAbi,
        functionName: "captureBatch",
        args: [live.map((item) => item.job.data.reqId), live.map((item) => item.actual)],
        account,
      })
      const hash = await writer.writeContract(request)
      const receipt = await reader.waitForTransactionReceipt({ hash })
      if (receipt.status !== "success") throw new Error("capture_reverted")
      recordGas(metrics, receipt, live.length, nativeUsd)
      for (const item of live) await item.job.moveToCompleted(hash, TOKEN, false)
    } catch (err) {
      log("facilitator", "capture_retry", { items: live.length, error: String(err).slice(0, 200) })
      for (const item of live) await item.job.moveToFailed(err as Error, TOKEN, false)
    }
  }
}
