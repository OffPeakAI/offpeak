import { bothCountsOk, domain, hostCostMicro, leafFor, parseRecord, recordToMessage, recoverTyped, signTyped, usageTypes, type Keyed, type UsageRecord, type UsageRecordJson } from "@offpeak/shared"
import type { Hex, PrivateKeyAccount } from "viem"
import { z } from "zod"
import type { Counts, ServedBook, ServedRequest, SignReply } from "./meter.ts"
import type { SheetBook } from "./sheets.ts"
import { liveBand, nightBand } from "./sheets.ts"
import type { SignedLog } from "./signed-log.ts"

const SETTLE_WAIT_MS = 5_000

const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const uint32 = z.int().min(0).max(2 ** 32 - 1)
const uint64 = z.string().regex(/^\d+$/).refine((value) => BigInt(value) < 2n ** 64n, "must fit uint64")

export const signBodySchema = z.object({
  record: z.object({
    reqId: hash32,
    buyerRef: hash32,
    host: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    modelDigest: hash32,
    tokensIn: uint32,
    tokensOut: uint32,
    promptHash: hash32,
    outputHash: hash32,
    priceIn: uint64,
    priceOut: uint64,
    hostCostMicro: uint64,
    feeMicro: uint64,
    payMode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    payRef: hash32,
    ts: z.int().positive().max(Number.MAX_SAFE_INTEGER),
    sheetHash: hash32,
  }),
  routerSig: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  partial: z.boolean().optional(),
})

export type SignerDeps = {
  operator: PrivateKeyAccount & Keyed
  routerAddress: string
  usageLedger: string
  served: ServedBook
  sheets: SheetBook
  log: SignedLog
  nightJobs: (modelDigest: Hex) => boolean
  clock: () => number
}

const refused = (reason: string, hostCounts: Counts | null): SignReply => ({ status: 409, body: { refused: true, reason, hostCounts } })

const typedRecord = (record: UsageRecord, usageLedger: string) => ({
  domain: domain("OffpeakUsage", usageLedger),
  types: usageTypes,
  primaryType: "UsageRecord" as const,
  message: recordToMessage(record) as never,
})

const within = (price: bigint, band: { low: bigint; high: bigint }) => price >= band.low && price <= band.high

type Bands = ReturnType<typeof liveBand>

/** Embeddings have no output, and the router prices that side at zero. */
const fits = (record: UsageRecord, band: Bands) => within(record.priceIn, band.in) && (record.priceOut === 0n ? record.tokensOut === 0 : within(record.priceOut, band.out))

/** Prices must come from this host's own sheet in force at the record's start, and the cost must follow from them. */
async function priceProblem(deps: SignerDeps, record: UsageRecord): Promise<string | null> {
  const sheet = await deps.sheets.inForce(record.sheetHash, record.modelDigest, record.ts)
  if (!sheet) return "sheet"
  if (record.payMode === 4) {
    // A Window was paid at purchase, so its draw-down records carry no price (3.3).
    const zero = record.priceIn === 0n && record.priceOut === 0n && record.hostCostMicro === 0n && record.feeMicro === 0n
    return zero ? null : "price"
  }
  const nightJobs = deps.nightJobs(record.modelDigest)
  if (!fits(record, nightJobs ? nightBand(sheet) : liveBand(sheet, record.ts))) {
    // A locked price this host never agreed to. The router must not send it here: `/offpeak/v1/info` lists the
    // models this host takes night jobs on. A plain `price` would read as this host breaking its own sheet.
    return !nightJobs && fits(record, nightBand(sheet)) ? "night_jobs_off" : "price"
  }
  if (record.hostCostMicro !== hostCostMicro(record.tokensIn, record.tokensOut, record.priceIn, record.priceOut)) return "cost"
  return null
}

/** A cut stream stops early on the router's side, so it may bill less output than the host produced, never more. */
function countsAgree(record: UsageRecord, local: Counts, partial: boolean) {
  if (partial) return bothCountsOk(record.tokensIn, 0, local.tokensIn, 0) && record.tokensOut <= local.tokensOut
  return bothCountsOk(record.tokensIn, record.tokensOut, local.tokensIn, local.tokensOut)
}

export async function settledRequest(request: ServedRequest) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), SETTLE_WAIT_MS)
  })
  const done = await Promise.race([request.settled.then(() => true), late])
  clearTimeout(timer)
  return done
}

/** A cut stream's output hash covers what reached the router, which this agent cannot see, so only the prompt is compared. */
function sealedHashProblem(request: ServedRequest, record: UsageRecord, partial: boolean) {
  if (!request.sealed) return null
  if (record.promptHash.toLowerCase() !== request.sealed.promptHash.toLowerCase()) return "sealed_prompt_hash"
  if (!partial && record.outputHash.toLowerCase() !== request.sealed.outputHash?.toLowerCase()) return "sealed_output_hash"
  return null
}

/** Runs every check on the router's record. Only a record that passes all of them gets the host's signature. */
export function createSigner(deps: SignerDeps) {
  const judge = async (request: ServedRequest, hostCounts: Counts, record: UsageRecord, json: UsageRecordJson, routerSig: Hex, partial: boolean): Promise<SignReply> => {
    if (record.modelDigest.toLowerCase() !== request.modelDigest.toLowerCase()) return refused("digest", hostCounts)
    if (record.ts !== request.ts) return refused("ts", hostCounts)
    const sealedIssue = sealedHashProblem(request, record, partial)
    if (sealedIssue) return refused(sealedIssue, hostCounts)
    if (!countsAgree(record, hostCounts, partial)) return refused("counts", hostCounts)
    const priceIssue = await priceProblem(deps, record)
    if (priceIssue) return refused(priceIssue, hostCounts)
    const hostSig = await signTyped(deps.operator, typedRecord(record, deps.usageLedger))
    const leaf = leafFor(record, routerSig, hostSig)
    // The log comes first. A signature this host cannot show later never leaves the machine.
    await deps.log.append({ at: deps.clock(), record: json, routerSig, hostSig, leaf, partial, hostCounts, engineUsage: request.usage, hostOutputHash: request.outputHash })
    return { status: 200, body: { hostSig, hostCounts, leaf } }
  }

  return async function sign(raw: unknown): Promise<SignReply> {
    const parsed = signBodySchema.safeParse(raw)
    if (!parsed.success) return { status: 400, body: { error: "bad_request" } }
    const routerSig = parsed.data.routerSig as Hex
    const partial = parsed.data.partial === true
    const json = parsed.data.record as UsageRecordJson
    const record = parseRecord(json)
    const signer = await recoverTyped(typedRecord(record, deps.usageLedger), routerSig).catch(() => null)
    if (signer?.toLowerCase() !== deps.routerAddress.toLowerCase()) return { status: 401, body: { error: "bad_router_sig" } }
    if (record.host.toLowerCase() !== deps.operator.address.toLowerCase()) return refused("host", null)
    const request = deps.served.get(record.reqId)
    if (!request) return { status: 404, body: { error: "unknown_request" } }
    if (!(await settledRequest(request))) return refused("still_serving", null)
    const hostCounts = request.counts
    if (!hostCounts) return refused("uncounted", null)
    const message = JSON.stringify({ ...json, partial })
    // Set before the first wait below, so two calls for one request cannot both pass. A retry of the same record gets the same answer.
    if (request.signing && request.signing.message !== message) return refused("already_signed", hostCounts)
    if (!request.signing) request.signing = { message, reply: judge(request, hostCounts, record, json, routerSig, partial) }
    const reply = await request.signing.reply.catch((): SignReply => ({ status: 500, body: { refused: true, reason: "sign_failed", hostCounts } }))
    if (reply.status !== 200) request.signing = null
    return reply
  }
}
