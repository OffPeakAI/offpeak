import { describe, expect, test } from "bun:test"
import { keccak256, toBytes, type Hex } from "viem"
import { roleAccount } from "../../../packages/shared/src/test-keys.ts"
import { agreedSignatures } from "../../common/src/sigs.ts"

const accounts = [roleAccount("settlerA"), roleAccount("settlerB"), roleAccount("settlerC")]
const settlers = accounts.map((a) => a.address)
const HASH = keccak256(toBytes("batch"))
const OTHER_HASH = keccak256(toBytes("other batch"))

async function sigRow(index: number, hash: Hex = HASH) {
  const account = accounts[index]!
  return { signer: account.address.toLowerCase(), batch_hash: hash, sig: await account.sign({ hash }), batch: { hash } }
}

describe("agreedSignatures", () => {
  test("one signer alone is never enough", async () => {
    expect(await agreedSignatures([await sigRow(0)], settlers)).toBeNull()
  })

  test("two signers who computed different batches do not agree", async () => {
    const rows = [await sigRow(0, HASH), await sigRow(1, OTHER_HASH)]
    expect(await agreedSignatures(rows, settlers)).toBeNull()
  })

  test("two signers on the same batch produce an ascending threshold signature", async () => {
    const rows = [await sigRow(0), await sigRow(1)]
    const agreed = await agreedSignatures(rows, settlers)
    const ordered = [...rows].sort((a, b) => (a.signer < b.signer ? -1 : 1))
    expect(agreed!.hash).toBe(HASH)
    expect(agreed!.thresholdSig).toBe(`0x${ordered.map((r) => r.sig.slice(2)).join("")}`)
  })

  test("a majority beats a dissenting signer", async () => {
    const rows = [await sigRow(0, OTHER_HASH), await sigRow(1), await sigRow(2)]
    expect((await agreedSignatures(rows, settlers))!.hash).toBe(HASH)
  })

  test("a signature from outside the set does not count", async () => {
    const outsider = roleAccount("rulingA")
    const forged = {
      signer: outsider.address.toLowerCase(),
      batch_hash: HASH,
      sig: await outsider.sign({ hash: HASH }),
      batch: {},
    }
    expect(await agreedSignatures([await sigRow(0), forged], settlers)).toBeNull()
  })

  test("a junk signature is skipped and the honest pair still agrees", async () => {
    const junk = { signer: "0x0000000000000000000000000000000000000001", batch_hash: HASH, sig: "0x1234" as Hex, batch: { b: "junk" } }
    const agreed = await agreedSignatures([junk, await sigRow(0), await sigRow(1)], settlers)
    expect(agreed!.batch).toEqual({ hash: HASH })
  })

  test("a member's false copy of the batch is not what comes back, whatever its order", async () => {
    const poison = { ...(await sigRow(0)), batch: { b: "poison" } }
    const rows = [poison, await sigRow(1), await sigRow(2)]
    for (const ordered of [rows, [...rows].reverse()]) {
      const agreed = await agreedSignatures(ordered, settlers)
      expect(agreed!.batch).toEqual({ hash: HASH })
      expect(agreed!.thresholdSig).not.toContain(poison.sig.slice(2))
    }
  })

  test("two members holding different batches under one hash do not agree", async () => {
    expect(await agreedSignatures([{ ...(await sigRow(0)), batch: { b: "poison" } }, await sigRow(1)], settlers)).toBeNull()
  })

  test("a row claiming someone else's signature does not count", async () => {
    const stolen = { ...(await sigRow(1)), signer: accounts[2]!.address.toLowerCase() }
    expect(await agreedSignatures([await sigRow(0), stolen], settlers)).toBeNull()
  })
})
