import { z } from "zod"
import { listDisputes, openDispute } from "../../offpeak/disputes.ts"
import { authed, refuse, router } from "../init.ts"
import { bytes32 } from "../inputs.ts"

/** What the buyer kept. With it the router recounts the tokens, as `POST /v1/disputes` does. */
const material = z.strictObject({
  prompt: z.record(z.string(), z.unknown()),
  output: z.string().max(4 * 1024 * 1024),
  tool_calls: z.array(z.unknown()).optional(),
  finish: z.string().max(32).nullish(),
})

export const disputes = router({
  list: authed.query(({ ctx }) => listDisputes(ctx.stack, ctx.wallet)),
  open: authed.input(z.strictObject({ reqIds: z.array(bytes32).min(1).max(50), reason: z.string().trim().min(1).max(500), material: material.optional() })).mutation(async ({ ctx: { stack, wallet }, input }) => {
    const opened = await openDispute(stack, wallet, { req_ids: input.reqIds, reason: input.reason, material: input.material })
    if (opened.error) throw refuse(opened.error)
    return opened
  }),
})
