import { Offpeak, type ChatResult, type MaxPrice } from "@offpeak/sdk"
import { z } from "zod"

export type AgentPolicy = { models: readonly string[]; maxTokens: number; maxChargeMicro: bigint; maxPrice: MaxPrice }
const input = z.strictObject({ model: z.string().min(1), prompt: z.string().min(1).max(16000) })
/** A tool takes a prompt and a permitted model. It cannot raise its operator's spending limits. */
export function createAgentTool(op: Offpeak, policy: AgentPolicy) {
  if (
    !policy.models.length ||
    policy.maxChargeMicro <= 0n ||
    !Number.isSafeInteger(policy.maxTokens) ||
    policy.maxTokens < 1 ||
    policy.maxTokens > 4096
  )
    throw Error("Invalid agent policy")
  return {
    name: "offpeak_complete",
    description: "Complete a text task using an allowed open model and a fixed spending cap.",
    parameters: {
      type: "object",
      properties: { model: { type: "string", enum: [...policy.models] }, prompt: { type: "string", maxLength: 16000 } },
      required: ["model", "prompt"],
      additionalProperties: false,
    },
    async execute(raw: unknown) {
      const args = input.parse(raw)
      if (!policy.models.includes(args.model)) throw Error("Model is not allowed by this agent policy")
      const result = (await op.chat(
        { model: args.model, messages: [{ role: "user", content: args.prompt }], max_tokens: policy.maxTokens, stream: false },
        { maxPrice: policy.maxPrice, maxChargeMicro: policy.maxChargeMicro },
      )) as ChatResult
      return {
        text: result.text,
        requestId: result.envelope.record.reqId,
        costMicro: (result.envelope.record.hostCostMicro + result.envelope.record.feeMicro).toString(),
        verification: await op.verifyUsage(result.envelope),
      }
    },
  }
}
/** GAME's custom function boundary; inject SDK constructors in the host application. */
export function gameFunction<T>(tool: ReturnType<typeof createAgentTool>, respond: (status: "done" | "failed", feedback: string) => T) {
  return {
    name: tool.name,
    description: tool.description,
    args: [
      { name: "model", type: "string", description: "Allowed OffPeak model", optional: false },
      { name: "prompt", type: "string", description: "Task to complete", optional: false },
    ],
    executable: async (args: unknown) => {
      try {
        return respond("done", JSON.stringify(await tool.execute(args)))
      } catch (e) {
        return respond("failed", e instanceof Error ? e.message : "Inference failed")
      }
    },
  }
}

/** Bursar's real SDK boundary. Its `fetch` enforces mandate payments on Bursar-compatible routes.
 * A policy check alone is never treated as paid authorization. */
export type BursarMandate = {
  fetch: (url: string, options: RequestInit & { capability: string; maxAmount: bigint; lane: "mandate" }) => Promise<{ response: Response }>
}
export function bursarFetch(mandate: BursarMandate, origin: string, capMicro: bigint, capability = "service:inference.text") {
  const base = new URL(origin)
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash || capMicro <= 0n)
    throw Error("Use a trusted HTTPS payment origin and positive cap")
  return async (path: string, body: unknown) => {
    const url = new URL(path, base)
    if (url.origin !== base.origin || url.pathname !== "/v1/chat/completions" || url.search || url.hash)
      throw Error("Payment route is not allowed")
    return (
      await mandate.fetch(url.href, {
        method: "POST",
        headers: { "content-type": "application/json", "x-offpeak-max-charge": capMicro.toString() },
        body: JSON.stringify(body),
        capability,
        maxAmount: capMicro,
        lane: "mandate",
      })
    ).response
  }
}
