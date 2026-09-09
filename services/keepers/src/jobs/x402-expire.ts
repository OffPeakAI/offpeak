import { X402EscrowAbi } from "@offpeak/abis"
import { log } from "@offpeak/common"
import { X402_EXPIRY_GRACE_S } from "@offpeak/shared"
import type { Hex } from "viem"
import type { KeeperDeps } from "./types.ts"

/** Refunds escrows nobody captured. Any here means a capture was lost, so each one raises an alert. */
export async function runX402Expire(deps: KeeperDeps) {
  const head = await deps.reader.getBlock({ blockTag: "latest" })
  const stale = await deps.db.query<{ req_id: Hex }>(
    "SELECT req_id FROM chain.escrows WHERE status = 'authorized' AND valid_before + $1 < $2",
    [X402_EXPIRY_GRACE_S, Number(head.timestamp)],
  )
  const expired: string[] = []
  for (const { req_id: reqId } of stale.rows) {
    try {
      const { request } = await deps.reader.simulateContract({
        address: deps.contracts.X402Escrow!,
        abi: X402EscrowAbi,
        functionName: "expire",
        args: [reqId],
        account: deps.account,
      })
      await deps.reader.waitForTransactionReceipt({ hash: await deps.writer.writeContract(request) })
      expired.push(reqId)
      log("keepers", "escrow_expired", { reqId })
      deps.metrics.inc("x402_escrow_expired_total")
    } catch (err) {
      log("keepers", "escrow_expire_skipped", { reqId, error: String(err).slice(0, 160) })
    }
  }
  return expired
}
