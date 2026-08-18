import { describe, expect, test } from "bun:test"
import { assertKeySeparation, settlementEnv } from "./env.ts"

const KEY_A = `0x${"11".repeat(32)}`
const KEY_B = `0x${"22".repeat(32)}`

describe("boot checks", () => {
  test("a service holding only its own key boots", () => {
    expect(() => assertKeySeparation({ OFFPEAK_SETTLER_KEY: KEY_A }, "OFFPEAK_SETTLER_KEY")).not.toThrow()
  })

  test("a service holding another role's key refuses to start", () => {
    const env = { OFFPEAK_SETTLER_KEY: KEY_A, OFFPEAK_KEEPER_KEY: KEY_B }
    expect(() => assertKeySeparation(env, "OFFPEAK_SETTLER_KEY")).toThrow("must not hold OFFPEAK_KEEPER_KEY")
  })

  test("a missing required variable is a boot failure", () => {
    expect(settlementEnv.safeParse({ OFFPEAK_ENV: "local" }).success).toBe(false)
  })

  test("settlement needs exactly three signers", () => {
    const base = {
      OFFPEAK_ENV: "local",
      OFFPEAK_CHAIN_ID: "4663",
      OFFPEAK_RPC_URL: "http://127.0.0.1:8545",
      OFFPEAK_DEPLOYMENT_FILE: "local.json",
      OFFPEAK_DATABASE_URL: "pglite://memory",
      OFFPEAK_SETTLER_INDEX: "1",
      OFFPEAK_SETTLER_KEY: KEY_A,
      OFFPEAK_ROUTER_ADDRESS: `0x${"33".repeat(20)}`,
    }
    const address = `0x${"44".repeat(20)}`
    expect(settlementEnv.safeParse({ ...base, OFFPEAK_SETTLER_ADDRESSES: `${address},${address}` }).success).toBe(false)
    expect(settlementEnv.safeParse({ ...base, OFFPEAK_SETTLER_ADDRESSES: `${address},${address},${address}` }).success).toBe(true)
  })
})
