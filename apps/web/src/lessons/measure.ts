// P1-6: arithmetic behind the measurement lens. Reading a trace means reading two numbers off it,
// an amplitude and a time, so the lens zooms in around a clicked point and puts both on a ruler.

/** Index of the sample closest to t (x must be ascending). */
export function nearestIndex(x: number[], t: number): number {
  if (!x.length) return -1
  let lo = 0
  let hi = x.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (x[mid]! < t) lo = mid
    else hi = mid
  }
  return Math.abs(x[lo]! - t) <= Math.abs(x[hi]! - t) ? lo : hi
}

/** The 1-2-5 step at or below a value: the numbers people write on a ruler. */
export function niceStep(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const fraction = value / power
  return (fraction >= 5 ? 5 : fraction >= 2 ? 2 : 1) * power
}

/** Same rounding up as the trace viewer's locked scale (±value it prints in the toolbar). */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const fraction = value / power
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power
}

export interface LensWindow {
  times: number[]
  values: number[]
  /** Position of the measured sample inside `times`. */
  at: number
}

/** Samples within ±half seconds of t, for the zoomed view. */
export function lensWindow(x: number[], values: number[], t: number, half: number): LensWindow {
  const center = nearestIndex(x, t)
  if (center < 0) return { times: [], values: [], at: -1 }
  let start = center
  let end = center
  while (start > 0 && x[start - 1]! >= x[center]! - half) start -= 1
  while (end < x.length - 1 && x[end + 1]! <= x[center]! + half) end += 1
  return { times: x.slice(start, end + 1), values: values.slice(start, end + 1), at: center - start }
}

export function peakToPeak(values: number[]): number {
  const finite = values.filter(Number.isFinite)
  return finite.length ? Math.max(...finite) - Math.min(...finite) : 0
}

/**
 * Rough rhythm from how often the trace swings across its own mean: one cycle crosses twice.
 * A crossing counts only after the trace has moved past a band of ±15% of its peak-to-peak size,
 * so small noise riding on a slow wave does not count as a fast rhythm. Not a spectrum.
 */
export function roughFrequency(times: number[], values: number[]): number | null {
  if (values.length < 4) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const band = 0.15 * peakToPeak(values)
  if (band <= 0) return null
  const crossings: number[] = []
  let side = 0
  for (let i = 0; i < values.length; i += 1) {
    const offset = values[i]! - mean
    const next = offset > band ? 1 : offset < -band ? -1 : side
    if (side !== 0 && next !== side) crossings.push(times[i]!)
    side = next
  }
  if (crossings.length < 3) return null
  const span = crossings[crossings.length - 1]! - crossings[0]!
  return span > 0 ? (crossings.length - 1) / (2 * span) : null
}

/** Ruler sizes for a zoomed window: about a third of the visible range in each direction. */
export function scaleBars(range: number, durationS: number): { amplitude: number; timeS: number } {
  return { amplitude: niceStep(Math.max(range, 1e-9) / 3), timeS: niceStep(durationS / 3) }
}

export function formatTime(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${Number(seconds.toFixed(2))} s`
}

export function formatValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return '—'
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${unit}`
}
