import { abis } from "@offpeak/abis"
import { encodeAbiParameters, encodeEventTopics, keccak256, toBytes, type Abi, type Address, type Hex, type PublicClient } from "viem"

export const TEST_CONTRACTS = {
  OffpeakVault: "0x00000000000000000000000000000000000000a1",
  AuditCourt: "0x00000000000000000000000000000000000000a2",
  HostRegistry: "0x00000000000000000000000000000000000000a3",
} as const satisfies Record<string, Address>

export type TestLog = Record<string, unknown>

export const testHash = (value: string) => keccak256(toBytes(value))
const blockHash = (n: bigint, fork: string): Hex => testHash(`block-${fork}-${n}`)

export function eventLog(contract: keyof typeof TEST_CONTRACTS, eventName: string, args: Record<string, unknown>, block: bigint, logIndex: number, fork = "main"): TestLog {
  const abi = abis[contract] as Abi
  const item = abi.find((x) => x.type === "event" && x.name === eventName) as { inputs: { name: string; type: string; indexed?: boolean }[] }
  const plain = item.inputs.filter((i) => !i.indexed)
  return {
    address: TEST_CONTRACTS[contract],
    topics: encodeEventTopics({ abi, eventName, args: args as never }),
    data: encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never),
    blockNumber: block,
    blockHash: blockHash(block, fork),
    transactionHash: testHash(`tx-${block}-${logIndex}`),
    logIndex,
  }
}

/** A chain whose block reads can be told to fail, as an RPC blip would, and whose hashes can fork. */
export class FakeChain {
  head = 0n
  logs: TestLog[] = []
  failNextBlockReads = 0
  fork = "main"
  forkFrom = 0n

  reader = {
    getBlockNumber: async () => this.head,
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => {
      if (this.failNextBlockReads > 0) {
        this.failNextBlockReads--
        throw new Error("HTTP request failed: 503")
      }
      const n = blockNumber ?? this.head
      return { number: n, hash: blockHash(n, n >= this.forkFrom ? this.fork : "main"), timestamp: 1_700_000_000n + n }
    },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      this.logs.filter((l) => (l.blockNumber as bigint) >= fromBlock && (l.blockNumber as bigint) <= toBlock),
    readContract: async () => 4n,
  } as unknown as PublicClient

  add(...logs: TestLog[]) {
    this.logs.push(...logs)
    this.head = logs.reduce((max, l) => ((l.blockNumber as bigint) > max ? (l.blockNumber as bigint) : max), this.head)
  }
}
