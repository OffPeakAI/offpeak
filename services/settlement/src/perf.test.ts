import { describe, expect, test } from "bun:test"
import type { Db } from "@offpeak/common"
import { measure } from "./perf.ts"

const FAILURE_BELOW_BPS = 2_000

/** The minutes settlement reads, all of them demanded and below the target. */
const minutes = (count: number) => ({ query: async () => ({ rows: Array.from({ length: count }, (_, minute) => ({ minute: String(minute), demanded: true, below: true })) }) }) as unknown as Db

const failed = (post: Awaited<ReturnType<typeof measure>>) => post.belowMinSeconds * 10_000 > FAILURE_BELOW_BPS * post.measuredSeconds

describe("a Window's post", () => {
  test("under the floor of measured seconds cannot fail a Window, and still shows what was measured", async () => {
    const post = await measure(minutes(9), "7", "100")
    expect(post).toMatchObject({ measuredSeconds: 540, belowMinSeconds: 0 })
    expect(failed(post)).toBe(false)
  })

  test("at the floor carries what was below", async () => {
    const post = await measure(minutes(10), "7", "100")
    expect(post).toMatchObject({ measuredSeconds: 600, belowMinSeconds: 600 })
    expect(failed(post)).toBe(true)
  })
})
