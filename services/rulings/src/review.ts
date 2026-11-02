import { AuditCourtAbi, HostRegistryAbi, UsageLedgerAbi } from "@offpeak/abis"
import { agreedSignatures, log, readSignatures, storeSignature, type Db } from "@offpeak/common"
import { domain, rulingTypes, type EvidenceBundle } from "@offpeak/shared"
import { hashTypedData, keccak256, toBytes, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem"
import { OUTCOME_BREACH, OUTCOME_SWAP, decideRuling, dismiss, type ChallengeFacts } from "./decide.ts"
import { buildRefundTree, spendWithHost, storeRefundTree } from "./refund-tree.ts"

const HOST_RESPONSE_S = 86_400

export type RulingDeps = {
  db: Db
  reader: PublicClient
  writer: WalletClient
  account: LocalAccount
  contracts: Record<string, Address>
  rulers: Address[]
  auditor: Address
  chainId: number
}

export type ChallengeRow = {
  id: string
  host: string
  challenger: string
  kind: number
  samples_root: string | null
  sample_count: number | null
  test_id: string | null
  statistic: string | null
  threshold: string | null
  filed_at: string
  filed_block: string
  response_hash: string | null
}

export async function loadBundle(db: Db, samplesRoot: string | null): Promise<EvidenceBundle | null> {
  const rows = await db.query<{ body: EvidenceBundle }>("SELECT body FROM shared.evidence_bundles WHERE samples_root = $1", [samplesRoot])
  return rows.rows[0]?.body ?? null
}

/** Each sample must be in a posted root and must be a record this host actually served. */
export async function leavesProven(deps: Pick<RulingDeps, "db" | "reader" | "contracts">, bundle: EvidenceBundle): Promise<boolean> {
  for (const sample of bundle.samples) {
    const onChain = await deps.reader.readContract({
      address: deps.contracts.UsageLedger!,
      abi: UsageLedgerAbi,
      functionName: "verifyLeaf",
      args: [BigInt(sample.hour), sample.leaf, sample.proof],
    })
    if (!onChain) return false
    const record = await deps.db.query<{ host: string; leaf: string }>("SELECT host, leaf FROM shared.usage_records WHERE req_id = $1", [sample.reqId])
    if (record.rows[0]?.leaf !== sample.leaf || record.rows[0]?.host !== bundle.host.toLowerCase()) return false
  }
  return true
}

/** An evidence event that never applied leaves these NULL. With no root there is no bundle, so the ruling dismisses. */
export function factsOf(row: ChallengeRow): ChallengeFacts {
  return {
    host: row.host,
    kind: Number(row.kind),
    samplesRoot: row.samples_root ?? "",
    sampleCount: Number(row.sample_count ?? 0),
    testId: row.test_id ?? "",
    statistic: BigInt(row.statistic ?? 0),
    threshold: BigInt(row.threshold ?? 0),
  }
}

/** The slash pool uses the bond when the challenge was filed, so every process computes the same tree. */
export async function refundTreeFor(deps: Pick<RulingDeps, "db" | "reader" | "contracts">, row: ChallengeRow, bundle: EvidenceBundle, slashBps: number) {
  const view = await deps.reader.readContract({
    address: deps.contracts.HostRegistry!,
    abi: HostRegistryAbi,
    functionName: "hostView",
    args: [row.host as Address],
    blockNumber: BigInt(row.filed_block),
  })
  const spend = await spendWithHost(deps.db, row.host, bundle.samples.map((s) => s.hour))
  return buildRefundTree(spend, (view.bondUsdg * BigInt(slashBps)) / 10_000n)
}

/**
 * A root counts once: for the auditor's first filing of it, which also fixes its kind. Roots are public,
 * so a copy proves nothing, and a stranger's filing cannot use up the auditor's.
 */
async function evidenceMisuse(deps: RulingDeps, row: ChallengeRow) {
  const auditor = deps.auditor.toLowerCase()
  if (row.challenger !== auditor) return "evidence_wrong_filer"
  const first = await deps.db.query<{ id: string }>("SELECT min(id) AS id FROM chain.challenges WHERE samples_root = $1 AND challenger = $2", [row.samples_root, auditor])
  return Number(first.rows[0]!.id) === Number(row.id) ? null : "evidence_reused"
}

async function signRuling(deps: RulingDeps, row: ChallengeRow) {
  const bundle = await loadBundle(deps.db, row.samples_root)
  const misuse = bundle ? await evidenceMisuse(deps, row) : null
  const proven = bundle && !misuse ? await leavesProven(deps, bundle) : false
  const decision = misuse ? dismiss(misuse) : decideRuling(bundle, factsOf(row), proven)

  let refundRoot = `0x${"00".repeat(32)}` as Hex
  if (bundle && decision.outcome === OUTCOME_BREACH) {
    const tree = await refundTreeFor(deps, row, bundle, decision.slashBps)
    await storeRefundTree(deps.db, Number(row.id), decision.slashBps, tree)
    refundRoot = tree.root
  }
  const message = {
    challengeId: BigInt(row.id),
    outcome: decision.outcome,
    slashBps: decision.slashBps,
    refundRoot,
    reasonHash: keccak256(toBytes(decision.reason)),
  }
  const hash = hashTypedData({
    domain: domain("OffpeakAudit", deps.contracts.AuditCourt!, deps.chainId),
    types: rulingTypes,
    primaryType: "Ruling",
    message,
  })
  const sig = await deps.account.sign!({ hash })
  await storeSignature(deps.db, "ruling", Number(row.id), deps.account.address, hash, sig, { message, reason: decision.reason })
  return decision
}

type StoredRuling = { message: { challengeId: string; outcome: number; slashBps: number; refundRoot: Hex; reasonHash: Hex } }

async function trySubmit(deps: RulingDeps, id: number) {
  const agreed = await agreedSignatures(await readSignatures(deps.db, "ruling", id), deps.rulers)
  if (!agreed) return "waiting"
  const { message } = agreed.batch as StoredRuling
  const { request } = await deps.reader.simulateContract({
    address: deps.contracts.AuditCourt!,
    abi: AuditCourtAbi,
    functionName: "postRuling",
    args: [{ ...message, challengeId: BigInt(message.challengeId) }, agreed.thresholdSig],
    account: deps.account,
  })
  const hash = await deps.writer.writeContract(request)
  await deps.reader.waitForTransactionReceipt({ hash })
  return hash
}

/** One pass: every challenge ready for a ruling gets this process's signature, and lands once two agree. */
export async function rulingTick(deps: RulingDeps) {
  const head = await deps.reader.getBlock({ blockTag: "latest" })
  const ready = await deps.db.query<ChallengeRow>(
    `SELECT * FROM chain.challenges WHERE state = 'filed' AND outcome IS NULL
       AND (response_hash IS NOT NULL OR filed_at + $1 <= $2) ORDER BY id`,
    [HOST_RESPONSE_S, Number(head.timestamp)],
  )
  const results: { id: number; reason: string; submitted: unknown }[] = []
  for (const row of ready.rows) {
    try {
      const decision = await signRuling(deps, row)
      const submitted = await trySubmit(deps, Number(row.id)).catch((err) => {
        log("rulings", "submit_retry", { id: row.id, error: String(err).slice(0, 200) })
        return "retry"
      })
      results.push({ id: Number(row.id), reason: decision.reason, submitted })
    } catch (err) {
      // One challenge that cannot be ruled must not hold back the ones after it.
      log("rulings", "ruling_failed", { id: row.id, error: String(err).slice(0, 200) })
      results.push({ id: Number(row.id), reason: "ruling_failed", submitted: "retry" })
    }
  }
  return results
}

export { OUTCOME_SWAP }
