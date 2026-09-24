import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { chartModel, type Leg, type Slot } from "../lib/forecast.ts"
import { dayName, formatPrice, hourLabel } from "../lib/format.ts"

const WIDTH = 1008
const HEIGHT = 240
const STEP = WIDTH / 168

/** 168 thin bars, one per hour. Height carries the price and every value stays a bigint until it is a label. */
export function ForecastChart({ slots, leg }: { slots: Slot[]; leg: Leg }) {
  const chart = useMemo(() => chartModel(slots, leg), [slots, leg])
  const [active, setActive] = useState<number | null>(null)
  const plot = useRef<SVGSVGElement>(null)
  const shown = chart.bars[active ?? -1] ?? chart.cheapest
  const count = chart.bars.length
  const step = count > 0 ? WIDTH / count : STEP

  const point = (event: PointerEvent<SVGSVGElement>) => {
    const box = plot.current?.getBoundingClientRect()
    if (!box || box.width === 0) return
    setActive(Math.min(count - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * count))))
  }
  const key = (event: KeyboardEvent<SVGSVGElement>) => {
    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "PageDown" ? 24 : event.key === "PageUp" ? -24 : 0
    if (!move) return
    event.preventDefault()
    setActive((index) => Math.min(count - 1, Math.max(0, (index ?? chart.cheapest?.index ?? 0) + move)))
  }

  return (
    <figure className="week">
      <figcaption className="week-read" aria-live="polite">
        {shown && (
          <>
            <span className="week-when">{active === null ? "Cheapest forecast" : hourLabel(shown.how)}</span>
            <strong>{formatPrice(shown.price)}</strong>
            <span className="note">
              {active === null ? `${hourLabel(shown.how)} UTC` : shown.index === 0 ? "this hour, UTC" : `in ${shown.index} h, UTC`}
            </span>
          </>
        )}
      </figcaption>
      <div className="week-frame">
        <svg
          ref={plot}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          tabIndex={0}
          role="img"
          aria-label={`Forecast buyer price per 1M tokens for the next ${count} hours, from ${formatPrice(chart.low)} to ${formatPrice(chart.high)}. Use the arrow keys to read each hour.`}
          onPointerMove={point}
          onPointerDown={point}
          onPointerLeave={() => setActive(null)}
          onKeyDown={key}
        >
          {chart.bars.filter((bar) => bar.night).map((bar) => (
            <rect key={`n${bar.index}`} className="night" x={bar.index * step} y={0} width={step} height={HEIGHT} />
          ))}
          {chart.cheapest && <rect className="flag" x={chart.cheapest.index * step + step * 0.12} y={0} width={step * 0.76} height={HEIGHT} />}
          {chart.bars.map((bar) => {
            const height = (bar.heightBps / 10_000) * HEIGHT
            return <rect key={bar.index} className={bar.index === active ? "bar active" : bar.cheapest ? "bar cheapest" : bar.index === 0 ? "bar now" : "bar"} x={bar.index * step + step * 0.12} y={HEIGHT - height} width={step * 0.76} height={height} rx={1.5} />
          })}
        </svg>
        <div className="week-days" aria-hidden="true">
          {chart.days.filter((day) => day.index < count - 8).map((day) => (
            <span key={day.index} style={{ left: `${(day.index / Math.max(count, 1)) * 100}%` }}>
              {dayName(day.how)}
            </span>
          ))}
        </div>
      </div>
      <p className="week-key note">
        <span className="key-now" /> this hour <span className="key-low" /> cheapest <span className="key-night" /> 00:00 to 06:00 UTC
      </p>
      <details className="week-table">
        <summary>Show as a table</summary>
        <div className="scroll-y">
          <table className="ledger plain">
            <thead>
              <tr>
                <th>Hour (UTC)</th>
                <th className="num">Price per 1M</th>
              </tr>
            </thead>
            <tbody>
              {chart.bars.map((bar) => (
                <tr key={bar.index}>
                  <td>{hourLabel(bar.how)}</td>
                  <td className="num">{formatPrice(bar.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}
