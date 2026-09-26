import { describe, expect, test } from "bun:test"
import { formatBps, formatDuration, formatPrice, formatTokens, formatUsdg, formatUtc, hourLabel, parseCount, parseUsdg, shortHex } from "./format.ts"

describe("money formatting", () => {
  test("keeps every micro-unit", () => {
    expect(formatUsdg(1n)).toBe("0.000001")
    expect(formatUsdg(1_234_567_891n)).toBe("1,234.567891")
    expect(formatUsdg(500_000_000n)).toBe("500.00")
    expect(formatUsdg(1_500_000n)).toBe("1.50")
    expect(formatUsdg(0n)).toBe("0.00")
    expect(formatUsdg("-2500000")).toBe("-2.50")
  })

  test("survives amounts a float cannot hold", () => {
    expect(formatUsdg(9_007_199_254_740_993_000_001n)).toBe("9,007,199,254,740,993.000001")
    expect(formatUsdg("340282366920938463463374607431768211455")).toBe("340,282,366,920,938,463,463,374,607,431,768.211455")
  })

  test("prices read as dollars per million tokens", () => {
    expect(formatPrice(104_000n)).toBe("$0.104")
    expect(formatPrice(832_000n)).toBe("$0.832")
    expect(formatPrice(1_000_000n)).toBe("$1.000")
    expect(formatPrice(104_001n)).toBe("$0.104001")
    expect(formatPrice("2500000")).toBe("$2.500")
  })

  test("tokens group and bps drop empty digits", () => {
    expect(formatTokens(1234567)).toBe("1,234,567")
    expect(formatTokens("100")).toBe("100")
    expect(formatBps(400)).toBe("4%")
    expect(formatBps(296)).toBe("2.96%")
    expect(formatBps(4810)).toBe("48.1%")
    expect(formatBps(5)).toBe("0.05%")
    expect(formatBps(0)).toBe("0%")
  })
})

describe("parsing typed amounts", () => {
  test("round trips exact decimals", () => {
    expect(parseUsdg("12.34")).toEqual({ ok: true, micro: 12_340_000n })
    expect(parseUsdg("0.000001")).toEqual({ ok: true, micro: 1n })
    expect(parseUsdg(".5")).toEqual({ ok: true, micro: 500_000n })
    expect(parseUsdg("5.")).toEqual({ ok: true, micro: 5_000_000n })
    expect(parseUsdg(" 7 ")).toEqual({ ok: true, micro: 7_000_000n })
  })

  test("takes a value no float could carry", () => {
    expect(parseUsdg("9007199254740993.000001")).toEqual({ ok: true, micro: 9_007_199_254_740_993_000_001n })
  })

  test("refuses rather than rounds", () => {
    for (const bad of ["", ".", "1.0000001", "-1", "1e6", "1,000", "abc", "1.2.3", "0x10"]) {
      expect(parseUsdg(bad).ok).toBe(false)
    }
  })

  test("counts are whole and positive", () => {
    expect(parseCount("3")).toEqual({ ok: true, value: 3n })
    for (const bad of ["0", "-1", "1.5", "", "01"]) expect(parseCount(bad).ok).toBe(false)
  })
})

describe("display helpers", () => {
  test("short hex keeps both ends", () => {
    expect(shortHex("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc")).toBe("0x3c44…93bc")
    expect(shortHex("0x12")).toBe("0x12")
  })

  test("times are UTC", () => {
    expect(formatUtc(1_762_000_000)).toBe("Sat 1 Nov, 12:26 UTC")
    expect(hourLabel(0)).toBe("Mon 00:00")
    expect(hourLabel(167)).toBe("Sun 23:00")
  })

  test("durations stay readable", () => {
    expect(formatDuration(7_200)).toBe("2h 00m 00s")
    expect(formatDuration(3_599)).toBe("59m 59s")
    expect(formatDuration(-5)).toBe("0m 00s")
    expect(formatDuration(200_000)).toBe("2d 7h")
  })
})
