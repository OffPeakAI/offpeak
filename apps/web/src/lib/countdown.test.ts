import { describe, expect, test } from "bun:test"
import { capsState, clockOffset, disputeOpen, effectiveDaily, withdrawAllState } from "./countdown.ts"

const REQUESTED = 1_762_002_000
const DUE = REQUESTED + 7_200
const REQUEST_HOUR = Math.floor(REQUESTED / 3_600)

const state = (now: number, lastSettledHour = REQUEST_HOUR - 2) => withdrawAllState({ requestedAt: String(REQUESTED), dueAt: String(DUE), lastSettledHour: String(lastSettledHour), now })

describe("withdraw-all countdown", () => {
  test("nothing requested shows nothing", () => {
    expect(withdrawAllState({ requestedAt: "0", dueAt: "0", lastSettledHour: "0", now: 5 })).toEqual({ phase: "none" })
  })

  test("counts down to the 2-hour guarantee", () => {
    expect(state(REQUESTED)).toMatchObject({ phase: "waiting", remaining: 7_200, label: "2h 00m 00s", elapsedBps: 0 })
    expect(state(REQUESTED + 3_600)).toMatchObject({ phase: "waiting", remaining: 3_600, label: "1h 00m 00s", elapsedBps: 5_000 })
    expect(state(DUE - 1)).toMatchObject({ phase: "waiting", remaining: 1, label: "0m 01s" })
  })

  test("opens exactly at the due time", () => {
    expect(state(DUE)).toEqual({ phase: "ready", reason: "due", dueAt: DUE })
  })

  test("opens early once the request hour settles, not before", () => {
    expect(state(REQUESTED + 60, REQUEST_HOUR)).toEqual({ phase: "ready", reason: "settled", dueAt: DUE })
    expect(state(REQUESTED + 60, REQUEST_HOUR - 1).phase).toBe("waiting")
  })

  test("a pushed request with no due time still counts from the request", () => {
    expect(withdrawAllState({ requestedAt: String(REQUESTED), dueAt: "0", lastSettledHour: "0", now: REQUESTED })).toMatchObject({ phase: "waiting", remaining: 7_200 })
  })
})

describe("caps", () => {
  test("a pending decrease shows beside the current cap", () => {
    expect(capsState({ hourlyCap: "5000000", dailyCap: "20000000", pendingHourlyCap: "1000000", pendingDailyCap: "4000000", capsEffectiveAfterHour: "99" })).toEqual({
      hourly: 5_000_000n,
      daily: 20_000_000n,
      pendingHourly: 1_000_000n,
      pendingDaily: 4_000_000n,
      effectiveAfterHour: 99n,
    })
  })

  test("no pending hour means no pending caps", () => {
    expect(capsState({ hourlyCap: "1", dailyCap: "4", pendingHourlyCap: "0", pendingDailyCap: "0", capsEffectiveAfterHour: "0" }).pendingHourly).toBeNull()
  })

  test("daily 0 reads as four hours", () => {
    expect(effectiveDaily(5_000_000n, 0n)).toBe(20_000_000n)
    expect(effectiveDaily(5_000_000n, 7n)).toBe(7n)
  })
})

describe("time limits", () => {
  test("disputes close after 7 days to the second", () => {
    expect(disputeOpen(1_000, 1_000 + 604_800)).toBe(true)
    expect(disputeOpen(1_000, 1_000 + 604_801)).toBe(false)
  })

  test("clock offset corrects a slow browser", () => {
    expect(clockOffset(1_000, 990_000)).toBe(10)
  })
})
