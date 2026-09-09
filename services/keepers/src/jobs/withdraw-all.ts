import { OffpeakVaultAbi } from "@offpeak/abis"
import { log } from "@offpeak/common"
import type { Address } from "viem"
import type { KeeperDeps } from "./types.ts"

const WITHDRAW_ALL_MAX_DELAY_S = 7200

/** Courtesy only: anyone can execute an exit, and a buyer's exit never depends on this job. */
export async function runWithdrawAll(deps: KeeperDeps) {
  const head = await deps.reader.getBlock({ blockTag: "latest" })
  const now = Number(head.timestamp)
  const due = await deps.db.query<{ address: string }>(
    `SELECT b.address FROM chain.buyers b, chain.vault_state v
     WHERE b.withdraw_requested_at > 0
       AND (b.withdraw_requested_at + $1 <= $2 OR v.last_settled_hour >= b.withdraw_requested_at / 3600)`,
    [WITHDRAW_ALL_MAX_DELAY_S, now],
  )
  const executed: string[] = []
  for (const { address } of due.rows) {
    try {
      const { request } = await deps.reader.simulateContract({
        address: deps.contracts.OffpeakVault!,
        abi: OffpeakVaultAbi,
        functionName: "executeWithdrawAll",
        args: [address as Address],
        account: deps.account,
      })
      await deps.reader.waitForTransactionReceipt({ hash: await deps.writer.writeContract(request) })
      executed.push(address)
    } catch (err) {
      log("keepers", "withdraw_all_skipped", { buyer: address, error: String(err).slice(0, 160) })
    }
  }
  return executed
}
