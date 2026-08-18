import { describe, expect, test } from "bun:test"
import { readDeployment } from "./chain.ts"

const root = new URL("../../../packages/abis/deployments/", import.meta.url).pathname

describe("readDeployment", () => {
  test("contracts from later phases are left out", () => {
    const mainnet = readDeployment(`${root}4663.json`)
    expect(mainnet.contracts.Permit2).toBeDefined()
    expect(mainnet.contracts.OfpkHooks).toBeUndefined()
  })

  test("a local chain has everything", () => {
    const local = readDeployment(`${root}local.json`)
    expect(local.contracts.OfpkHooks).toBeDefined()
    expect(local.contracts.OffpeakVault).toBeDefined()
  })
})
