import type { Hono } from "hono"
import { keccak256, toBytes, type Hex } from "viem"
import { addressOf } from "@offpeak/abis"
import { HOST_STATUS, ZERO_BYTES32, buyerUnitPrice, gpuClassOf, hourOfWeek } from "@offpeak/shared"
import { anvilAccount, roleAccount } from "../../../../packages/shared/src/test-keys.ts"
import { createHostApp } from "../../../host-agent/src/mock-engine.ts"
import { MockIndexer } from "../../../../services/mock-indexer/src/state.ts"
import { MockFacilitator } from "../../../../services/mock-facilitator/src/state.ts"
import { LiveChain } from "../../src/chainview/live.ts"
import { watchChain } from "../../src/chainview/push.ts"
import { LiveFacilitator } from "../../src/pay/facilitator.ts"
import { HoldLedger, MemoryCounters } from "../../src/pay/prepaid.ts"
import { WindowPerf } from "../../src/pay/window-perf.ts"
import { LoadMeter } from "../../src/pricing/load.ts"
import { livePrice, loadFactorBps } from "../../src/pricing/live.ts"
import { sheetHashOf, type PriceSheet } from "../../src/pricing/pricebook.ts"
import { domain, priceSheetTypes } from "@offpeak/shared"
import { issueKey, type Stack } from "../../src/pipeline.ts"
import { openDb } from "../../src/store.ts"
import { createApp } from "../../src/app.ts"

/** Probation takes 72 hours of chain time. These flows start after it, so hosts read as active. */
class ActiveHosts extends LiveChain {
  override async hostList() {
    return (await super.hostList()).map((host) => ({ ...host, status: HOST_STATUS.Active, routable: true }))
  }
}

export type LiveLinks = { indexerUrl: string; facilitatorUrl: string; token: string }

export async function bootStack(opts?: { swap?: boolean; failHost?: boolean; secondHost?: boolean; live?: LiveLinks; db?: Stack["db"]; now?: number; modelDigest?: Hex }) {
  const router = roleAccount("router")
  const host = roleAccount("host")
  const buyer = roleAccount("buyer")
  // The key the local chain's ChannelManager takes as its payee.
  const payee = anvilAccount(14)
  const modelDigest = opts?.modelDigest ?? keccak256(toBytes("ofm-8b"))
  const imageDigest = keccak256(toBytes("offpeak-image-v1"))
  const db = opts?.db ?? (await openDb())
  const indexer = new MockIndexer()
  const facilitator = new MockFacilitator((msg) => indexer.emit(msg))
  const operator = host.address.toLowerCase()
  const buyerAddr = buyer.address.toLowerCase()
  indexer.buyers.set(buyerAddr, {
    balance: 1_000_000_000n,
    reserve: 0n,
    hourlyCap: 100_000_000n,
    dailyCap: 400_000_000n,
    pendingHourlyCap: 0n,
    pendingDailyCap: 0n,
    capsEffectiveAfterHour: 0n,
    withdrawRequestedAt: 0n,
    withdrawDueAt: 0n,
    lastSettledHour: 0n,
    usagePaused: false,
  })
  indexer.hosts.set(operator, {
    operator: operator as Hex,
    status: HOST_STATUS.Active,
    bondUsdg: 2_000_000_000n,
    bondOfpk: 0n,
    requiredBond: 2_000_000_000n,
    imageDigest,
    gpuClass: gpuClassOf("h100-80g-sxm"),
    attestationRef: ZERO_BYTES32,
    probationEnds: 0n,
    strikes: 0,
    openChallenges: 0,
    releasableCredits: 0n,
    pendingCredits: 0n,
    models: [{ digest: modelDigest, maxTps: 100, name: "ofm-8b" }],
    routable: true,
    routingBonusBps: 0,
    endpointHash: ZERO_BYTES32,
    endpoint: "http://host.local",
  })
  const baseIn = Array.from({ length: 168 }, () => 200_000n)
  const baseOut = Array.from({ length: 168 }, () => 800_000n)
  const sheet: PriceSheet = {
    host: operator as Hex,
    modelDigest,
    baseIn,
    baseOut,
    floorIn: 100_000n,
    floorOut: 400_000n,
    validFrom: 0,
    nonce: 1n,
  }
  const registry = addressOf("HostRegistry")
  const sig = await host.signTypedData({
    domain: domain("OffpeakPriceSheet", registry),
    types: priceSheetTypes,
    primaryType: "PriceSheet",
    message: { ...sheet, validFrom: 0n, nonce: 1n },
  })
  let now = opts?.now ?? 1_762_000_000
  const hostApps = new Map<string, Hono>()
  const chain = opts?.live ? new ActiveHosts({ url: opts.live.indexerUrl, token: opts.live.token, endpointOf: () => "http://host.local" }) : null
  const stack: Stack = {
    clock: () => now,
    setClock: (n) => {
      now = n
    },
    ledger: new HoldLedger(),
    counters: new MemoryCounters(),
    indexer: chain ?? indexer,
    facilitator: opts?.live ? new LiveFacilitator({ url: opts.live.facilitatorUrl, token: opts.live.token }) : facilitator,
    hosts: {
      request: async (host, _endpoint, path, init) => {
        const target = hostApps.get(host)
        if (!target) throw new Error("no such host")
        return target.request(path, init as RequestInit)
      },
    },
    models: [
      { name: "ofm-8b", digest: modelDigest, contextLength: 8192, kind: "chat" },
      { name: "ofm-70b", digest: modelDigest, contextLength: 8192, kind: "chat" },
      { name: "ofm-embed", digest: modelDigest, contextLength: 8192, kind: "embeddings" },
    ],
    sheets: [{ ...sheet, sig, sheetHash: sheetHashOf(sheet, registry) }],
    load: new LoadMeter(),
    router: router as unknown as Stack["router"],
    payee: payee as unknown as Stack["router"],
    db,
    probesOk: new Set([operator]),
    ttftFailoverMs: 3000,
    preconfirmTimeoutMs: 15_000,
    usageLedger: addressOf("UsageLedger"),
    registry,
    vault: addressOf("OffpeakVault"),
    channelManager: addressOf("ChannelManager"),
    channelPayee: payee.address,
    escrow: addressOf("X402Escrow"),
    windowMarket: addressOf("WindowMarket"),
    auditCourt: addressOf("AuditCourt"),
    usdg: addressOf("MockUSDG"),
    permit2: addressOf("Permit2"),
    log: [],
    preHostMs: [],
    authWaiters: new Map(),
    authResults: new Map(),
    candidateCache: new Map(),
    windowPerf: new WindowPerf(() => now),
    windowShares: new Map(),
    production: false,
    flags: {
      channels: true,
      upto: true,
      night_jobs: true,
      windows: true,
      sealed: false,
      token_hooks: false,
      beta_cap: true,
    },
  }
  watchChain(stack)
  const engine = createHostApp({
    operator: host as unknown as Stack["router"],
    routerAddress: router.address,
    usageLedger: stack.usageLedger,
    modelDigest,
    modelName: "ofm-8b",
    imageDigest,
    gpuClass: "h100-80g-sxm",
    swap: Boolean(opts?.swap),
    sealed: false,
    fail: Boolean(opts?.failHost),
  })
  hostApps.set(operator, engine.app)
  if (opts?.secondHost) {
    const host2 = roleAccount("settlerA")
    const op2 = host2.address.toLowerCase()
    indexer.hosts.set(op2, {
      ...indexer.hosts.get(operator)!,
      operator: op2 as Hex,
      bondUsdg: 9_000_000_000n,
    })
    const sheet2 = {
      ...sheet,
      host: op2 as Hex,
      nonce: 1n,
      baseIn: sheet.baseIn.map((v) => v * 2n),
      baseOut: sheet.baseOut.map((v) => v * 2n),
    }
    const sig2 = await host2.signTypedData({
      domain: domain("OffpeakPriceSheet", registry),
      types: priceSheetTypes,
      primaryType: "PriceSheet",
      message: { ...sheet2, validFrom: 0n, nonce: 1n },
    })
    stack.sheets.push({ ...sheet2, sig: sig2, sheetHash: sheetHashOf(sheet2, registry) })
    stack.probesOk.add(op2)
    const engine2 = createHostApp({
      operator: host2 as unknown as Stack["router"],
      routerAddress: router.address,
      usageLedger: stack.usageLedger,
      modelDigest,
      modelName: "ofm-8b",
      imageDigest,
      gpuClass: "h100-80g-sxm",
      swap: false,
      sealed: false,
    })
    hostApps.set(op2, engine2.app)
  }
  const key = await issueKey(stack, buyerAddr)
  const app = createApp(stack)
  return { app, stack, key, hostApps, imageDigest, chain, buyer: buyerAddr, host: operator, modelDigest, indexer, facilitator, now: () => now }
}

export function liveBuyer(stack: Stack, host: string) {
  const sheet = stack.sheets.find((s) => s.host === host)!
  const price = livePrice(sheet, hourOfWeek(stack.clock()), loadFactorBps(0))
  return { ...price, buyerIn: buyerUnitPrice(price.in, 400), buyerOut: buyerUnitPrice(price.out, 400) }
}
