import { rmSync } from "node:fs"
import { join } from "node:path"
import { LAUNCH_TOKENIZER, countChat, countInputs, countOutput, countText, renderChat, type Hex } from "@offpeak/shared"
import { roleAccount } from "../../../../packages/shared/src/test-keys.ts"
import type { Measurement } from "../../../../packages/sdk/src/sealed/attest.ts"
import { EngineWatch } from "../../../host-agent/src/health.ts"
import type { AgentTokenizer } from "../../../host-agent/src/meter.ts"
import { createAgentApp } from "../../../host-agent/src/proxy.ts"
import { SealedAgent } from "../../../host-agent/src/sealed/serve.ts"
import { SheetBook } from "../../../host-agent/src/sheets.ts"
import { SignedLog } from "../../../host-agent/src/signed-log.ts"
import { fakeGpuCommand } from "../../../host-agent/test/support/fake-gpu-tool.ts"
import { startFakeVllm, type FakeReply } from "../../../host-agent/test/support/fake-vllm.ts"
import { FAKE_TD, sealedTempDir, startFakeTsm, type FakeTd } from "../../../host-agent/test/support/fake-tsm.ts"
import { AttestBook, sweepAttestations } from "../../src/routing/attest.ts"
import { startFakeDcap, startFakeGpuService } from "./fake-attestation.ts"
import { bootStack } from "./stack.ts"

process.env.OFFPEAK_TEST_PORT_BASE ??= "37000"

export const MODEL = "ofm-8b"

/** For tests about something other than attestation. A real client leaves this off. */
export const TRUST_ROUTER = { trustRouterVerification: true }

/** The router still counts on the byte tokenizer, so the agent does too. */
export const byteTokenizer: AgentTokenizer = {
  render: (body) => renderChat(body.messages ?? [], body.tools),
  encode: (text) => Array.from({ length: countText(LAUNCH_TOKENIZER, text) }, (_, id) => id),
  decodeToken: (id) => String(id),
  countChat: (body) => countChat(LAUNCH_TOKENIZER, body.messages ?? [], body.tools),
  countOutput: (text, toolCalls) => countOutput(LAUNCH_TOKENIZER, text, toolCalls),
  countInputs: (inputs) => countInputs(LAUNCH_TOKENIZER, inputs),
}

export type RigOptions = {
  td?: FakeTd
  reply?: (body: Record<string, any>) => FakeReply
  failWith?: number
  hold?: Promise<void>
  tokenizer?: AgentTokenizer
  /** The allow-list. Defaults to the fake TD's measurements and this rig's config. */
  measurements?: (imageDigest: Hex, configHash: Hex) => Measurement[]
  /** What the agent's model table says for `engine`, when that should differ from the engine the VM attested. */
  modelEngine?: string
  /** Leaves the router's verifier URLs out. */
  noVerifiers?: boolean
  /** Skips the first attestation sweep. */
  noSweep?: boolean
}

/** One sealed host behind one router: a real agent and router, with fake TSM, engine, DCAP and GPU services. */
export async function sealedRig(opts: RigOptions = {}) {
  const boot = await bootStack()
  const { stack } = boot
  stack.setClock(Math.floor(Date.now() / 1000))
  stack.flags.sealed = true
  const dataDir = sealedTempDir("rig-")
  const td = opts.td ?? FAKE_TD
  const tsm = startFakeTsm({ td })
  const engine = startFakeVllm({ name: MODEL, tokenizer: opts.tokenizer ?? byteTokenizer, reply: opts.reply ?? (() => ({ text: "Served in the sealed VM." })), failWith: opts.failWith, hold: opts.hold })
  const dcap = startFakeDcap()
  const gpu = startFakeGpuService()
  const sheets = new SheetBook(join(dataDir, "sheets"), boot.host, stack.registry)
  const row = stack.sheets[0]!
  await sheets.save(row, row.sig)
  await sheets.load()
  const log = new SignedLog(join(dataDir, "signed"))
  await log.open()
  const startVm = () => SealedAgent.start({ modelName: MODEL, modelDigest: boot.modelDigest, imageDigest: boot.imageDigest, operator: boot.host, engine: engine.url, tsmRoot: tsm.root, gpuTool: fakeGpuCommand() })
  const sealed = await startVm()
  const makeAgent = (agentSealed: SealedAgent) =>
    createAgentApp({
      operator: roleAccount("host") as never,
      routerAddress: stack.router.address,
      usageLedger: stack.usageLedger,
      sheets,
      log,
      clock: stack.clock,
      imageDigest: boot.imageDigest,
      gpuClass: "h100-80g-sxm",
      models: [{ name: MODEL, digest: boot.modelDigest, engine: opts.modelEngine ?? engine.url, tokenizer: opts.tokenizer ?? byteTokenizer, nightJobs: false }],
      integrity: { failed: null },
      engines: new EngineWatch([{ name: MODEL, engine: engine.url, vllmArgs: [] }]),
      auditor: null,
      sealed: agentSealed,
    })
  boot.hostApps.set(boot.host, makeAgent(sealed))
  const hostRow = boot.indexer.hosts.get(boot.host)!
  hostRow.attestationRef = sealed.attestationRef
  const { configHash } = sealed.bootBindings
  const measurements = opts.measurements ? opts.measurements(boot.imageDigest, configHash) : [{ imageDigest: boot.imageDigest, mrtd: td.mrtd, rtmrs: td.rtmrs, configHash }]
  stack.attest = new AttestBook({ tdxVerifierUrl: opts.noVerifiers ? undefined : dcap.url, gpuAttestationUrl: opts.noVerifiers ? undefined : gpu.url, measurements })
  if (!opts.noSweep) await sweepAttestations(stack)

  /** A host restart: new key, new boot quote, new agent process. */
  const restartHost = async () => {
    const next = await startVm()
    boot.hostApps.set(boot.host, makeAgent(next))
    return next
  }

  const stop = () => {
    tsm.stop()
    engine.stop()
    dcap.stop()
    gpu.stop()
    rmSync(dataDir, { recursive: true, force: true })
  }
  return { ...boot, sealed, tsm, engine, dcap, gpu, log, sheets, hostRow, restartHost, stop }
}
