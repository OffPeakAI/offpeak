import { describe, expect, test } from "bun:test"
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem"
import localDeploy from "../../abis/deployments/local.json" with { type: "json" }
import { hourOfWeek, hourIndex } from "./time.ts"
import { canonicalJson } from "./canonical.ts"
import { domainSeparator, typedDataDigest } from "./digest.ts"
import {
  CHANNEL_WITNESS_TYPESTRING,
  EXACT_WITNESS_TYPESTRING,
  UPTO_WITNESS_TYPESTRING,
  domain,
  encodeType,
  hashStruct,
  permitWitnessTypes,
  usageTypes,
} from "./eip712.ts"
import { roleAccount } from "./test-keys.ts"
import { recordToMessage, type UsageRecord } from "./usage.ts"
import { ZERO_BYTES32 } from "./constants.ts"

const ledger = localDeploy.contracts.UsageLedger

describe("time and canonical json", () => {
  test("hour of week is Monday-zero UTC", () => {
    // 2024-01-01 is a Monday. 00:30 UTC → how 0.
    const ts = Date.UTC(2024, 0, 1, 0, 30, 0) / 1000
    expect(hourOfWeek(ts)).toBe(0)
    expect(hourIndex(ts)).toBe(Math.floor(ts / 3600))
    const sunday = Date.UTC(2024, 0, 7, 23, 0, 0) / 1000
    expect(hourOfWeek(sunday)).toBe(167)
  })

  test("canonical json sorts keys and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: "x" })).toBe('{"a":"x","b":1}')
    expect(canonicalJson({ z: [1, { b: true, a: null }] })).toBe('{"z":[1,{"a":null,"b":true}]}')
  })
})

describe("eip712", () => {
  test("usage digest matches viem and recovers the router", async () => {
    const router = roleAccount("router")
    const record: UsageRecord = {
      reqId: `0x${"11".repeat(32)}`,
      buyerRef: `0x${"22".repeat(32)}`,
      host: roleAccount("host").address.toLowerCase() as Hex,
      modelDigest: `0x${"33".repeat(32)}`,
      tokensIn: 12,
      tokensOut: 4,
      promptHash: `0x${"44".repeat(32)}`,
      outputHash: `0x${"55".repeat(32)}`,
      priceIn: 200_000n,
      priceOut: 800_000n,
      hostCostMicro: 6n,
      feeMicro: 1n,
      payMode: 0,
      payRef: ZERO_BYTES32,
      ts: 1_700_000_000,
      sheetHash: `0x${"66".repeat(32)}`,
    }
    const message = recordToMessage(record)
    const struct = hashStruct("UsageRecord", usageTypes as never, message)
    const sep = domainSeparator("OffpeakUsage", ledger as Hex)
    const digest = typedDataDigest(struct, sep)
    const viem = hashTypedData({
      domain: domain("OffpeakUsage", ledger),
      types: usageTypes,
      primaryType: "UsageRecord",
      message: message as never,
    })
    expect(digest).toBe(viem)
    const sig = await router.signTypedData({
      domain: domain("OffpeakUsage", ledger),
      types: usageTypes,
      primaryType: "UsageRecord",
      message: message as never,
    })
    const recovered = await recoverTypedDataAddress({
      domain: domain("OffpeakUsage", ledger),
      types: usageTypes,
      primaryType: "UsageRecord",
      message: message as never,
      signature: sig,
    })
    expect(recovered.toLowerCase()).toBe(router.address.toLowerCase())
  })

  test("permit2 witness type strings match the interface", () => {
    const upto = encodeType("PermitWitnessTransferFrom", permitWitnessTypes("UptoWitness") as never)
    const exact = encodeType("PermitWitnessTransferFrom", permitWitnessTypes("ExactWitness") as never)
    const channel = encodeType("PermitWitnessTransferFrom", permitWitnessTypes("ChannelOpenWitness") as never)
    const prefix = "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,"
    expect(upto.slice(prefix.length)).toBe(UPTO_WITNESS_TYPESTRING)
    expect(exact.slice(prefix.length)).toBe(EXACT_WITNESS_TYPESTRING)
    expect(channel.slice(prefix.length)).toBe(CHANNEL_WITNESS_TYPESTRING)
  })
})
