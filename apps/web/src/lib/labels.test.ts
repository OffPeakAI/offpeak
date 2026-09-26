import { describe, expect, test } from "bun:test"
import { FEATURES, flagWord, pageFor, windowPhase } from "./labels.ts"

describe("routes", () => {
  test("paths map to pages, trailing slash or not", () => {
    expect(pageFor("/")).toBe("prices")
    expect(pageFor("/dashboard")).toBe("dashboard")
    expect(pageFor("/windows/")).toBe("windows")
    expect(pageFor("/terms")).toBe("terms")
    expect(pageFor("/nope")).toBeNull()
  })
})

describe("status wording", () => {
  test("every flag from /v1/status has a row", () => {
    expect(FEATURES.map((row) => row.flag).sort()).toEqual(["beta_cap", "channels", "night_jobs", "sealed", "token_hooks", "upto", "windows"])
  })

  test("an off flag uses the agreed words", () => {
    expect(flagWord(false)).toBe("Not switched on yet")
    expect(flagWord(true)).toBe("On")
  })
})

describe("window phases", () => {
  test("t0 starts it and t1 ends it", () => {
    const window = { t0: 10, t1: 20 }
    expect(windowPhase(window, 9)).toBe("before")
    expect(windowPhase(window, 10)).toBe("running")
    expect(windowPhase(window, 19)).toBe("running")
    expect(windowPhase(window, 20)).toBe("ended")
  })
})
