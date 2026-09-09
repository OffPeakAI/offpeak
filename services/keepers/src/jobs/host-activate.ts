import { HostRegistryAbi } from "@offpeak/abis"
import { log } from "@offpeak/common"
import type { Address } from "viem"
import type { KeeperDeps } from "./types.ts"

const PROBATION_STATUS = 1

export async function runHostActivate(deps: KeeperDeps) {
  const head = await deps.reader.getBlock({ blockTag: "latest" })
  const ready = await deps.db.query<{ address: string }>(
    "SELECT address FROM chain.hosts WHERE status = $1 AND probation_ends <= $2",
    [PROBATION_STATUS, Number(head.timestamp)],
  )
  const activated: string[] = []
  for (const { address } of ready.rows) {
    try {
      const { request } = await deps.reader.simulateContract({
        address: deps.contracts.HostRegistry!,
        abi: HostRegistryAbi,
        functionName: "activate",
        args: [address as Address],
        account: deps.account,
      })
      await deps.reader.waitForTransactionReceipt({ hash: await deps.writer.writeContract(request) })
      activated.push(address)
    } catch (err) {
      log("keepers", "activate_skipped", { host: address, error: String(err).slice(0, 160) })
    }
  }
  return activated
}
