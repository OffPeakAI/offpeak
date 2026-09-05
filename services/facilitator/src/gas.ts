import type { Metrics } from "@offpeak/common"
import type { TransactionReceipt } from "viem"

/** Tracks what a call costs in gas, so the team can see when `upto` costs more than it earns. */
export function recordGas(metrics: Metrics, receipt: TransactionReceipt, calls: number, nativeUsd: number) {
  const wei = receipt.gasUsed * receipt.effectiveGasPrice
  const usdg = (Number(wei) / 1e18) * nativeUsd
  metrics.set("x402_gas_usdg_per_call", calls > 0 ? usdg / calls : 0)
  metrics.inc("x402_gas_wei_total", Number(wei))
}
