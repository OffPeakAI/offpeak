#!/usr/bin/env bun
import { makeClients, openDatabase, readDeployment } from "@offpeak/common"
import { panelPacket, type PanelChoice } from "./panel.ts"

const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 ? process.argv[index + 1] : undefined
}

const challenge = Number(arg("challenge"))
const decision = arg("decision") as PanelChoice | undefined
if (!challenge || !decision) {
  console.error("usage: panel-cli --challenge <id> --decision confirm|downgrade|dismiss")
  process.exit(1)
}

const chainId = Number(process.env.OFFPEAK_CHAIN_ID ?? 4663)
const { reader } = makeClients({ rpcUrl: process.env.OFFPEAK_RPC_URL!, chainId })
const { contracts } = readDeployment(process.env.OFFPEAK_DEPLOYMENT_FILE!)
const db = await openDatabase(process.env.OFFPEAK_DATABASE_URL!)
const packet = await panelPacket({ db, reader, contracts, chainId }, challenge, decision)
console.log(JSON.stringify(packet, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2))
process.exit(0)
