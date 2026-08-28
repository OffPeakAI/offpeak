import { GPU_CLASSES, HOST_MIN_BOND, HOST_RESPONSE_S, HOST_STATUS, ZERO_BYTES32, gpuClassOf, hourIndex, type HostChain, type Hex } from "@offpeak/shared"
import { auditCourtAbi, hostRegistryAbi } from "@offpeak/abis"
import { encodeFunctionData, keccak256, toBytes } from "viem"
import { z } from "zod"
import { rememberHost } from "../../hosts-api/register.ts"
import { priceTable } from "../../offpeak/prices.ts"
import { approvalFor, authed, missing, publicProcedure, refuse, router, txFor } from "../init.ts"
import { bytes32, micro, signature, uint256 } from "../inputs.ts"
import type { Stack } from "../../pipeline.ts"

const SERVED_HOURS = 48

const register = z.strictObject({
  endpoint: z.string().url().max(256),
  models: z.array(z.strictObject({ digest: bytes32, maxTps: z.number().int().min(1).max(4_000_000_000) })).min(1).max(32),
  imageDigest: bytes32,
  gpuClass: z.enum(GPU_CLASSES),
  bondUsdg: micro,
  sig: signature,
})

function hostView(host: HostChain) {
  return {
    operator: host.operator,
    status: host.status,
    routable: host.routable,
    bondUsdg: host.bondUsdg.toString(),
    bondOfpk: host.bondOfpk.toString(),
    requiredBond: host.requiredBond.toString(),
    probationEnds: host.probationEnds.toString(),
    strikes: host.strikes,
    openChallenges: host.openChallenges,
    releasableCredits: host.releasableCredits.toString(),
    pendingCredits: host.pendingCredits.toString(),
    models: host.models.map((row) => ({ digest: row.digest, maxTps: row.maxTps })),
  }
}

async function ownChallenges(stack: Stack, wallet: string) {
  const rows = (await stack.indexer.challengesOf?.(wallet)) ?? []
  return rows.map((row) => ({ ...row, respondBy: row.filedAt + HOST_RESPONSE_S }))
}

export const hosts = router({
  list: publicProcedure.query(async ({ ctx }) =>
    (await ctx.stack.indexer.hostList()).map((row) => ({ operator: row.operator, status: row.status, routable: row.routable, bondUsdg: row.bondUsdg.toString(), strikes: row.strikes })),
  ),
  /** Everything the public price page shows for one model. */
  board: publicProcedure.input(z.strictObject({ model: z.string().min(1).max(128) })).query(async ({ ctx: { stack }, input }) => {
    const model = stack.models.find((row) => row.name === input.model)
    if (!model) throw missing()
    return priceTable(stack, model)
  }),
  me: authed.query(async ({ ctx: { stack, wallet } }) => {
    const host = await stack.indexer.host(wallet)
    return { wallet, serverTime: stack.clock(), host: host ? hostView(host) : null }
  }),
  payouts: authed.query(async ({ ctx: { stack, wallet } }) => {
    const host = await stack.indexer.host(wallet)
    const served = await stack.db.query<{ hour: string; tokens: string; records: string }>(
      `SELECT hour, sum(tokens_in + tokens_out) AS tokens, count(*) AS records FROM shared.usage_records
       WHERE host = $1 AND status = 'final' AND hour > $2 GROUP BY hour ORDER BY hour DESC`,
      [wallet, hourIndex(stack.clock()) - SERVED_HOURS],
    )
    return {
      releasable: host?.releasableCredits.toString() ?? "0",
      pending: host?.pendingCredits.toString() ?? "0",
      strikes: host?.strikes ?? 0,
      served: served.rows.map((row) => ({ hour: Number(row.hour), tokens: String(row.tokens), records: Number(row.records) })),
    }
  }),
  challenges: authed.query(async ({ ctx: { stack, wallet } }) => ({ serverTime: stack.clock(), challenges: await ownChallenges(stack, wallet) })),
  /** The operator signs the endpoint, so a session alone cannot repoint a host. */
  registerPlan: authed.input(register).mutation(async ({ ctx: { stack, wallet }, input }) => {
    if (input.bondUsdg < HOST_MIN_BOND) throw refuse("bond_below_minimum")
    const remembered = await rememberHost(stack, { operator: wallet as Hex, endpoint: input.endpoint, sig: input.sig })
    if (remembered.error) throw refuse(remembered.error)
    const data = encodeFunctionData({
      abi: hostRegistryAbi,
      functionName: "register",
      args: [
        {
          modelDigests: input.models.map((row) => row.digest),
          maxTps: input.models.map((row) => row.maxTps),
          imageDigest: input.imageDigest,
          gpuClass: gpuClassOf(input.gpuClass),
          endpointHash: keccak256(toBytes(input.endpoint)),
          attestationRef: ZERO_BYTES32 as Hex,
          bondUsdg: input.bondUsdg,
          bondOfpk: 0n,
        },
      ],
    })
    return { approval: approvalFor(stack, stack.registry, input.bondUsdg), tx: txFor(stack.registry, data), probationSeconds: remembered.seconds }
  }),
  activateTx: authed.mutation(async ({ ctx: { stack, wallet } }) => {
    const host = await stack.indexer.host(wallet)
    if (!host) throw missing()
    if (host.status !== HOST_STATUS.Probation) throw refuse("not_in_probation")
    if (BigInt(stack.clock()) < host.probationEnds) throw refuse("probation_running")
    return txFor(stack.registry, encodeFunctionData({ abi: hostRegistryAbi, functionName: "activate", args: [wallet as Hex] }))
  }),
  withdrawCreditsTx: authed.mutation(async ({ ctx: { stack, wallet } }) => {
    const host = await stack.indexer.host(wallet)
    if (!host) throw missing()
    if (host.releasableCredits === 0n) throw refuse("nothing_releasable")
    return txFor(stack.registry, encodeFunctionData({ abi: hostRegistryAbi, functionName: "withdrawCredits" }))
  }),
  /** Only the challenged host may respond, inside its 24 hours. The document itself stays with the host. */
  respondTx: authed.input(z.strictObject({ challengeId: uint256, response: z.string().trim().min(1).max(20_000) })).mutation(async ({ ctx: { stack, wallet }, input }) => {
    const challenge = (await ownChallenges(stack, wallet)).find((row) => row.id === input.challengeId.toString())
    if (!challenge) throw missing()
    if (stack.clock() > challenge.respondBy) throw refuse("response_window_closed")
    const responseHash = keccak256(toBytes(input.response))
    return { responseHash, tx: txFor(stack.auditCourt, encodeFunctionData({ abi: auditCourtAbi, functionName: "respond", args: [input.challengeId, responseHash] })) }
  }),
})
