import { TRPCError, initTRPC } from "@trpc/server"
import { encodeFunctionData, erc20Abi, type Hex } from "viem"
import { CHAIN_ID } from "@offpeak/shared"
import type { FLAGS } from "../context.ts"
import type { Stack } from "../pipeline.ts"

export type TrpcContext = { stack: Stack; wallet: string | null; session: string | null }

const t = initTRPC.context<TrpcContext>().create({
  isDev: false,
  errorFormatter({ shape, error }) {
    if (error.code === "INTERNAL_SERVER_ERROR") return { ...shape, message: "Service unavailable" }
    return error.code === "BAD_REQUEST" && error.cause ? { ...shape, message: "Invalid input" } : shape
  },
})

export const router = t.router
export const publicProcedure = t.procedure

/** Account data belongs to the signed-in wallet. No procedure takes a wallet as input. */
export const authed = t.procedure.use(({ ctx, next }) => {
  if (!ctx.wallet) throw new TRPCError({ code: "UNAUTHORIZED" })
  return next({ ctx: { ...ctx, wallet: ctx.wallet } })
})

/** Features off in `GET /v1/status` refuse here too, not only in the page. */
export const feature = (flag: keyof typeof FLAGS) =>
  t.middleware(({ ctx, next }) => {
    if (!ctx.stack.flags[flag]) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "not_switched_on" })
    return next()
  })

export const refuse = (message: string) => new TRPCError({ code: "BAD_REQUEST", message })
export const missing = () => new TRPCError({ code: "NOT_FOUND", message: "not_found" })

export type Tx = { to: Hex; data: Hex; value: "0"; chainId: number }

/** Calldata for the user's own wallet. A contract with no deployment gets no transaction. */
export function txFor(to: string | undefined, data: Hex): Tx {
  if (!to || /^0x0{40}$/.test(to)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "contract_not_deployed" })
  return { to: to as Hex, data, value: "0", chainId: CHAIN_ID }
}

/** The approve step a wallet needs first. The page skips it when the allowance already covers `amount`. */
export function approvalFor(stack: Stack, spender: string, amount: bigint) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as Hex, amount] })
  return { token: stack.usdg as Hex, spender: spender as Hex, amount: amount.toString(), tx: txFor(stack.usdg, data) }
}
