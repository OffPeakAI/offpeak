import { randomInt } from "node:crypto"
import type { Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { makeClients, readDeployment } from "../../../services/common/src/chain.ts"
import { log } from "../../../services/common/src/log.ts"
import { Metrics } from "../../../services/common/src/metrics.ts"
import { LiveChain } from "../../router/src/chainview/live.ts"
import { auditQueue, auditWorker, type AuditJob } from "../../router/src/audit/queue.ts"
import { openDb } from "../../router/src/store.ts"
import { recalibrateLive } from "./calibrate.ts"
import { loadAccounts, planCanaries, refreshAccepted, sendCanary, syncAccounts, type CanaryPlan } from "./canaries.ts"
import { loadEnv, loadModels } from "./config.ts"
import { canaryCorpus } from "./corpus.ts"
import type { AuditDeps } from "./deps.ts"
import { checkBond, reconcileFilings } from "./file.ts"
import { advanceFlagged, runMetering, runSequential, runThroughput, scorePending, syncOutcomes, uncalibratedHosts } from "./run.ts"
import { parseKek, runRetention } from "./sample.ts"
import { fillMissingZ } from "./score.ts"

const SERVICE = "auditor"
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const WEEK = 168 * HOUR
const CONCURRENCY = 4
/** Unpredictable by a host, unlike a seeded generator. */
const secureRng = () => randomInt(2 ** 47) / 2 ** 47

type Handler = (deps: AuditDeps) => Promise<unknown>

/** Repeating work, by job name. Canary sends are the one delayed job. */
const SCHEDULE: Record<string, { every: number; run: Handler }> = {
  retention: { every: 15 * MINUTE, run: (deps) => runRetention(deps.db, deps.clock()) },
  "plan-canaries": {
    every: HOUR,
    run: async (deps) => {
      const plans = await planCanaries(deps, deps.clock())
      await Promise.all(plans.map((plan) => deps.enqueueCanary(plan)))
      return { planned: plans.length }
    },
  },
  score: {
    every: MINUTE,
    run: async (deps) => ({ ...(await scorePending(deps)), filled: await fillMissingZ(deps.db) }),
  },
  sequential: {
    every: 15 * MINUTE,
    run: async (deps) => ({ reconciled: await reconcileFilings(deps), read: await runSequential(deps), advanced: await advanceFlagged(deps) }),
  },
  metering: { every: HOUR, run: (deps) => runMetering(deps) },
  throughput: { every: 15 * MINUTE, run: (deps) => runThroughput(deps) },
  bond: { every: 5 * MINUTE, run: (deps) => checkBond(deps) },
  outcomes: { every: 15 * MINUTE, run: (deps) => syncOutcomes(deps) },
  coverage: { every: HOUR, run: (deps) => uncalibratedHosts(deps) },
  recalibrate: {
    every: WEEK,
    run: async (deps) => {
      const results = []
      for (const model of deps.models) results.push(await recalibrateLive(deps.db, model.digest, deps.clock()))
      return results
    },
  },
  "refresh-accepted": {
    every: WEEK,
    run: async (deps) => {
      const stored = []
      for (const model of deps.models) stored.push(await refreshAccepted(deps, model.digest))
      return stored
    },
  },
}

export async function bootAuditor(source: NodeJS.ProcessEnv = process.env) {
  const env = loadEnv(source)
  const corpus = canaryCorpus(env)
  const account = privateKeyToAccount(env.OFFPEAK_AUDITOR_KEY as Hex)
  const { reader, writer } = makeClients({ rpcUrl: env.OFFPEAK_RPC_URL, chainId: env.OFFPEAK_CHAIN_ID, account })
  const db = await openDb(env.OFFPEAK_DATABASE_URL)
  const queue = auditQueue(env.OFFPEAK_REDIS_URL)
  const metrics = new Metrics()
  const accounts = loadAccounts(env.OFFPEAK_CANARY_ACCOUNTS_FILE)
  const deps: AuditDeps = {
    env: env.OFFPEAK_ENV,
    db,
    chain: new LiveChain({ url: env.OFFPEAK_INDEXER_URL, token: env.OFFPEAK_INTERNAL_TOKEN, endpointOf: () => "" }),
    fetcher: (url, init) => fetch(url, init),
    account: { ...account, localKey: env.OFFPEAK_AUDITOR_KEY as Hex } as never,
    reader,
    writer: writer!,
    contracts: readDeployment(env.OFFPEAK_DEPLOYMENT_FILE).contracts,
    metrics,
    kek: parseKek(env.OFFPEAK_AUDIT_SAMPLE_KEK)!,
    routerUrl: env.OFFPEAK_PUBLIC_BASE_URL,
    indexerUrl: env.OFFPEAK_INDEXER_URL,
    internalToken: env.OFFPEAK_INTERNAL_TOKEN,
    accounts,
    corpus,
    models: loadModels(env.OFFPEAK_MODELS_FILE),
    enqueueCanary: (plan) => queue.add("canary", plan, { delay: plan.delayS * 1000, removeOnComplete: true, removeOnFail: 1_000 }),
    fileThroughput: env.OFFPEAK_AUDITOR_FILE_THROUGHPUT === "1",
    rng: secureRng,
    clock: () => Math.floor(Date.now() / 1000),
  }
  await syncAccounts(deps, accounts)
  await reconcileFilings(deps)
  for (const [name, job] of Object.entries(SCHEDULE)) {
    await queue.upsertJobScheduler(name, { every: job.every }, { name, opts: { removeOnComplete: 100, removeOnFail: 1_000 } })
  }
  const running = new Set<string>()
  const worker = auditWorker(
    env.OFFPEAK_REDIS_URL,
    async (job: AuditJob) => {
      if (job.name === "canary") return sendCanary(deps, job.data as CanaryPlan)
      const scheduled = SCHEDULE[job.name]
      if (!scheduled || running.has(job.name)) return null
      running.add(job.name)
      try {
        return await scheduled.run(deps)
      } finally {
        running.delete(job.name)
      }
    },
    CONCURRENCY,
  )
  worker.on("failed", (job, err) => {
    metrics.inc("auditor_job_failures")
    log(SERVICE, "job_failed", { job: job?.name, error: String(err) })
  })
  const server = Bun.serve({
    port: env.OFFPEAK_AUDITOR_PORT,
    fetch: (req) => (new URL(req.url).pathname === "/metrics" ? new Response(metrics.render(), { headers: { "content-type": "text/plain" } }) : Response.json({ ok: true })),
  })
  metrics.set("auditor_canaries_off", corpus ? 0 : 1)
  log(SERVICE, "started", { port: server.port, jobs: Object.keys(SCHEDULE).length, accounts: accounts.length, models: deps.models.length, canaries: corpus !== null })
  return {
    deps,
    queue,
    worker,
    server,
    stop: async () => {
      server.stop(true)
      await worker.close()
      await queue.close()
    },
  }
}

if (import.meta.main) {
  const auditor = await bootAuditor()
  const shutdown = () => {
    auditor.stop().then(() => process.exit(0), () => process.exit(1))
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}
