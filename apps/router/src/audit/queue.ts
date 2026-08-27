import { Queue, Worker, type Job } from "bullmq"

export const AUDIT_QUEUE = "offpeak-audit"

export type AuditJob = Job<Record<string, unknown>>

/** Lives here because BullMQ is a router dependency and the auditor cannot add one to the lockfile. */
export function auditQueue(url: string) {
  return new Queue(AUDIT_QUEUE, { connection: { url } })
}

export function auditWorker(url: string, handler: (job: AuditJob) => Promise<unknown>, concurrency: number) {
  return new Worker(AUDIT_QUEUE, handler, { connection: { url }, concurrency })
}
