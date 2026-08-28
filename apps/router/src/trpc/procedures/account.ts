import { randomBytes } from "node:crypto"
import { BETA_CAP_PER_BUYER_MICRO, CHAIN_ID, domain, feeBpsFor } from "@offpeak/shared"
import { vaultAbi } from "@offpeak/abis"
import { encodeFunctionData, type Hex } from "viem"
import { z } from "zod"
import { approvalFor, authed, publicProcedure, refuse, router, txFor } from "../init.ts"
import { micro, positiveMicro, signature, uint256 } from "../inputs.ts"
import type { Stack } from "../../pipeline.ts"

const PERMIT_TTL_S = 1_800
const ZERO = /^0x0{40}$/

const permitTypes = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const

export function accountId(wallet: string) {
  return `acct_${wallet.slice(2, 18)}`
}

export async function auditOptIn(stack: Stack, wallet: string) {
  const rows = await stack.db.query<{ audit_opt_in: boolean }>("SELECT audit_opt_in FROM serving.accounts WHERE wallet = $1", [wallet])
  return rows.rows[0]?.audit_opt_in ?? false
}

/** Refuses a deposit the vault would revert, before the wallet asks for a signature. */
async function checkDeposit(stack: Stack, wallet: string, amount: bigint) {
  const buyer = await stack.indexer.buyer(wallet, stack.clock())
  if (buyer.withdrawRequestedAt !== 0n) throw refuse("withdraw_pending")
  if (stack.flags.beta_cap && buyer.balance + amount > BETA_CAP_PER_BUYER_MICRO) throw refuse("beta_cap")
}

export const account = router({
  /** Public addresses for reading the chain and checking usage records in the browser. */
  network: publicProcedure.query(({ ctx: { stack } }) => ({
    chainId: CHAIN_ID,
    deployed: !ZERO.test(stack.vault),
    vault: stack.vault,
    usdg: stack.usdg,
    permit2: stack.permit2,
    registry: stack.registry,
    usageLedger: stack.usageLedger,
    channelManager: stack.channelManager,
    windowMarket: stack.windowMarket,
    routerSigner: stack.router.address,
    channelPayee: stack.channelPayee,
    serverTime: stack.clock(),
  })),
  balance: authed.query(async ({ ctx }) => {
    const buyer = await ctx.stack.indexer.buyer(ctx.wallet, ctx.stack.clock())
    return { balance: buyer.balance.toString(), reserve: buyer.reserve.toString(), servable: buyer.servable, reason: buyer.reason ?? null }
  }),
  summary: authed.query(async ({ ctx: { stack, wallet } }) => {
    const now = stack.clock()
    const [buyer, audit] = await Promise.all([stack.indexer.buyer(wallet, now), auditOptIn(stack, wallet)])
    const discount = stack.flags.token_hooks ? ((await stack.indexer.ofpkOf(wallet))?.feeDiscountBps ?? 0) : 0
    return {
      wallet,
      serverTime: now,
      balance: buyer.balance.toString(),
      reserve: buyer.reserve.toString(),
      withdrawable: (buyer.balance > buyer.reserve ? buyer.balance - buyer.reserve : 0n).toString(),
      hourlyCap: buyer.hourlyCap.toString(),
      dailyCap: buyer.dailyCap.toString(),
      pendingHourlyCap: buyer.pendingHourlyCap.toString(),
      pendingDailyCap: buyer.pendingDailyCap.toString(),
      capsEffectiveAfterHour: buyer.capsEffectiveAfterHour.toString(),
      withdrawRequestedAt: buyer.withdrawRequestedAt.toString(),
      withdrawDueAt: buyer.withdrawDueAt.toString(),
      lastSettledHour: buyer.lastSettledHour.toString(),
      usagePaused: buyer.usagePaused,
      servable: buyer.servable,
      reason: buyer.reason ?? null,
      auditOptIn: audit,
      feeBps: feeBpsFor({ auditOptIn: audit, ofpkDiscountBps: discount }),
      betaCap: stack.flags.beta_cap ? BETA_CAP_PER_BUYER_MICRO.toString() : null,
    }
  }),
  setAuditOptIn: authed.input(z.strictObject({ optIn: z.boolean() })).mutation(async ({ ctx: { stack, wallet }, input }) => {
    await stack.db.query(
      `INSERT INTO serving.accounts (id, wallet, audit_opt_in) VALUES ($1,$2,$3)
       ON CONFLICT (wallet) DO UPDATE SET audit_opt_in = EXCLUDED.audit_opt_in`,
      [accountId(wallet), wallet, input.optIn],
    )
    return { auditOptIn: input.optIn }
  }),
  depositPlan: authed.input(z.strictObject({ amount: positiveMicro, mode: z.enum(["approve", "permit2"]) })).mutation(async ({ ctx: { stack, wallet }, input }) => {
    await checkDeposit(stack, wallet, input.amount)
    if (input.mode === "approve") {
      const data = encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [input.amount] })
      return { approval: approvalFor(stack, stack.vault, input.amount), tx: txFor(stack.vault, data), permit: null }
    }
    const nonce = BigInt(`0x${randomBytes(31).toString("hex")}`).toString()
    const deadline = (stack.clock() + PERMIT_TTL_S).toString()
    return {
      approval: approvalFor(stack, stack.permit2, input.amount),
      tx: null,
      permit: {
        domain: domain("Permit2", stack.permit2),
        types: permitTypes,
        primaryType: "PermitTransferFrom" as const,
        message: { permitted: { token: stack.usdg as Hex, amount: input.amount.toString() }, spender: stack.vault as Hex, nonce, deadline },
      },
    }
  }),
  depositPermit2Tx: authed.input(z.strictObject({ amount: positiveMicro, nonce: uint256, deadline: uint256, sig: signature })).mutation(async ({ ctx: { stack, wallet }, input }) => {
    await checkDeposit(stack, wallet, input.amount)
    const permit = { permitted: { token: stack.usdg as Hex, amount: input.amount }, nonce: input.nonce, deadline: input.deadline }
    return txFor(stack.vault, encodeFunctionData({ abi: vaultAbi, functionName: "depositWithPermit2", args: [permit, input.sig] }))
  }),
  setCapsTx: authed.input(z.strictObject({ hourlyCap: micro, dailyCap: micro })).mutation(({ ctx: { stack }, input }) =>
    txFor(stack.vault, encodeFunctionData({ abi: vaultAbi, functionName: "setCaps", args: [input.hourlyCap, input.dailyCap] })),
  ),
  withdrawTx: authed.input(z.strictObject({ amount: positiveMicro })).mutation(async ({ ctx: { stack, wallet }, input }) => {
    const buyer = await stack.indexer.buyer(wallet, stack.clock())
    if (input.amount > buyer.balance - buyer.reserve) throw refuse("exceeds_withdrawable")
    return txFor(stack.vault, encodeFunctionData({ abi: vaultAbi, functionName: "withdraw", args: [input.amount] }))
  }),
  requestWithdrawAllTx: authed.mutation(({ ctx: { stack } }) => txFor(stack.vault, encodeFunctionData({ abi: vaultAbi, functionName: "requestWithdrawAll" }))),
  cancelWithdrawAllTx: authed.mutation(({ ctx: { stack } }) => txFor(stack.vault, encodeFunctionData({ abi: vaultAbi, functionName: "cancelWithdrawAll" }))),
  executeWithdrawAllTx: authed.mutation(({ ctx: { stack, wallet } }) =>
    txFor(stack.vault, encodeFunctionData({ abi: vaultAbi, functionName: "executeWithdrawAll", args: [wallet as Hex] })),
  ),
  signOut: authed.mutation(async ({ ctx: { stack, session } }) => {
    await stack.db.query("DELETE FROM serving.siwe_sessions WHERE id = $1", [session])
    return { signedOut: true }
  }),
})
