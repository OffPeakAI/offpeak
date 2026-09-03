import { describe, expect, test } from "bun:test"
import { indexerApp } from "./http.ts"
import { MockIndexer } from "./state.ts"

const buyer = "0x90f79bf6eb2c4f870365e785982e1f101e93b906"

async function buyerData(app: ReturnType<typeof indexerApp>) {
  const res = await app.request(`/idx/v1/buyers/${buyer}`, {
    headers: { authorization: `Bearer ${process.env.OFFPEAK_INTERNAL_TOKEN}` },
  })
  return (await res.json()).data as { servable: boolean; reason?: string; balance: string }
}

describe("mock indexer buyer overrides", () => {
  test("POST /mock/buyers/:addr changes what the buyer route serves", async () => {
    const app = indexerApp(new MockIndexer())
    expect((await buyerData(app)).reason).toBe("no_balance")

    await app.request(`/mock/buyers/${buyer}`, {
      method: "POST",
      body: JSON.stringify({ balance: "100000000", hourlyCap: "5000000" }),
    })
    const after = await buyerData(app)
    expect(after.balance).toBe("100000000")
    expect(after.servable).toBe(true)
  })

  test("a daily cap of 0 still serves, because the vault reads it as 4 × hourly", async () => {
    const idx = new MockIndexer()
    idx.setBuyer(buyer, { balance: "1", hourlyCap: "1", dailyCap: "0" })
    expect(idx.buyerNow(buyer, 0).servable).toBe(true)
  })
})
