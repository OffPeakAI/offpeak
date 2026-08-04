/** UTC hour index: floor(unixSeconds / 3600). */
export function hourIndex(unixSeconds: number): number {
  if (!Number.isFinite(unixSeconds)) throw new Error("bad timestamp")
  return Math.floor(unixSeconds / 3600)
}

/**
 * Hour of week in [0, 167]. Monday = 0.
 * dow = (floor(ts / 86400) + 3) mod 7.
 */
export function hourOfWeek(unixSeconds: number): number {
  const days = Math.floor(unixSeconds / 86400)
  const dow = (days + 3) % 7
  const how = dow * 24 + Math.floor((unixSeconds % 86400) / 3600)
  return how
}

export function hourStart(hour: number): number {
  return hour * 3600
}

export function hourEnd(hour: number): number {
  return (hour + 1) * 3600
}

export function dayIndex(unixSeconds: number): number {
  return Math.floor(unixSeconds / 86400)
}

/** ISO week index (unix days floored to Monday). */
export function weekIndex(unixSeconds: number): number {
  const days = Math.floor(unixSeconds / 86400)
  const mondayDays = days - ((days + 3) % 7)
  return Math.floor(mondayDays / 7)
}
