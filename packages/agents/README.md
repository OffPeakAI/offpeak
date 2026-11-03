# OffPeak agent adapters

Use `@offpeak/agents` from this Bun workspace. The adapter accepts only an allowed model and a text prompt; the operator fixes the output limit, token prices and total charge. It exposes receipt verification separately from completion success.

```ts
import { Offpeak } from "@offpeak/sdk"
import { createAgentTool, gameFunction } from "@offpeak/agents"
import { GameFunction, ExecutableGameFunctionResponse, ExecutableGameFunctionStatus } from "@virtuals-protocol/game"

const op = new Offpeak({
  baseURL: process.env.OFFPEAK_PUBLIC_BASE_URL!,
  apiKey: process.env.OFFPEAK_API_KEY!,
})
const tool = createAgentTool(op, {
  models: ["your-deployed-model"],
  maxTokens: 512,
  maxChargeMicro: 10000n, // 0.01 USDG including fees
  maxPrice: { inPerM: 1000000n, outPerM: 1000000n },
})
const complete = new GameFunction(
  gameFunction(
    tool,
    (status, feedback) =>
      new ExecutableGameFunctionResponse(
        status === "done" ? ExecutableGameFunctionStatus.Done : ExecutableGameFunctionStatus.Failed,
        feedback,
      ),
  ),
)
// Add `complete` to your GAME worker's functions.
```

Install the official GAME package in the consuming application; it is intentionally not a dependency of every OffPeak service. The adapter follows [GAME's custom-function interface](https://github.com/game-by-virtuals/game-node/blob/main/src/function.ts).

For a Pons-launched agent, configure its runtime with the existing [MCP server](../mcp/README.md) or OpenAI-compatible `/v1` URL. Pons token issuance does not provision an inference account. This is a runtime adapter, not a Pons plugin registration, Virtuals marketplace listing or endorsement. Credentials stay in the runtime environment, never in prompts.

## Bursar mandate client

The mandate route is the separate [merchant gateway](../../services/bursar-gateway/README.md), not the ordinary OffPeak router.

```ts
import { bursarFetch } from "@offpeak/agents"

// `mandate` is your connected @bursar/sdk Mandate, with permission for
// the merchant and service:inference.text. Its budget is enforced on chain.
const send = bursarFetch(mandate, "https://your-merchant-origin.example", 10000n)
const response = await send("/v1/chat/completions", {
  model: "your-deployed-model",
  messages: [{ role: "user", content: "Summarize these notes…" }],
  max_tokens: 512,
  stream: false,
})
if (!response.ok) throw new Error(`Task failed: ${response.status}`)
const completion = await response.json()
```

The client pins HTTPS origin, route, capability and maximum amount. It always selects Bursar's mandate lane. On an ambiguous network failure, preserve and retry the original payment proof; do not invoke a fresh paid fetch blindly, since that may create a new lock.
