import { z } from "zod"
import { assertKeySeparation } from "../../../services/common/src/env.ts"
import { startNightService } from "./run.ts"

const env = z.object({
  OFFPEAK_REDIS_URL: z.string().min(1),
  OFFPEAK_PUBLIC_BASE_URL: z.string().url(),
  OFFPEAK_INTERNAL_TOKEN: z.string().min(32),
})

if (import.meta.main) {
  assertKeySeparation(process.env, [])
  const parsed = env.parse(process.env)
  const service = await startNightService({ redisUrl: parsed.OFFPEAK_REDIS_URL, routerUrl: parsed.OFFPEAK_PUBLIC_BASE_URL, token: parsed.OFFPEAK_INTERNAL_TOKEN })
  console.log(JSON.stringify({ service: "scheduler", event: "started" }))
  const stop = () => void service.close().then(() => process.exit(0))
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}
