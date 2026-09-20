import { OffpeakError, type Offpeak, type Recount } from "@offpeak/sdk"
import type { UsageEnvelope } from "@offpeak/shared"
import { z } from "zod"

const toJson = (value: unknown) => JSON.stringify(value, (_key, field) => (typeof field === "bigint" ? field.toString() : field))

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: toJson(value) }] })

function failure(err: unknown) {
  if (err instanceof OffpeakError) return { code: err.code, message: err.message, ...err.detail }
  if (err instanceof z.ZodError) return { code: "bad_input", message: err.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ") }
  return { code: "failed", message: "The call failed" }
}

/** A tool failure is an answer the agent can read, not a protocol error, and shows nothing an unknown error carries. */
export function tool<Input>(run: (input: Input) => Promise<unknown>) {
  return async (input: Input) => {
    try {
      return text(await run(input))
    } catch (err) {
      return { ...text({ error: failure(err) }), isError: true }
    }
  }
}

/** Verification needs published addresses. Without them the answer says so instead of passing or failing. */
export async function verification(op: Offpeak, envelope: UsageEnvelope, recount?: Recount): Promise<Record<string, unknown>> {
  try {
    return await op.verifyUsage(envelope, { recount })
  } catch (err) {
    if (err instanceof OffpeakError && err.code === "not_deployed") return { ok: false, status: "not_checked", reason: err.message }
    // The request is already paid for, so a recount that cannot run must not cost the agent its answer.
    if (recount) return { ...(await verification(op, envelope)), recount_problem: err instanceof OffpeakError ? err.message : "The recount could not run" }
    throw err
  }
}

const priceText = z.string().regex(/^\d+(\.\d{1,6})?$/, "must be decimal USD with up to 6 places")

export const maxPriceInput = z.object({ in: priceText, out: priceText })

export type MaxPriceInput = z.output<typeof maxPriceInput>
