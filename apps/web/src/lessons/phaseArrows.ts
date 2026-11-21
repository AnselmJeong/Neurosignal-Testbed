// Arithmetic behind the "phase and arrows" primer. All of it runs in the browser.
// One epoch's phase difference is an arrow of length 1; averaging arrows measures consistency.

export interface Arrow { x: number; y: number }

const rad = (deg: number) => (deg * Math.PI) / 180

export function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Phase differences (degrees) for n epochs: the mean lag plus a uniform scatter.
 * scatter 0 = identical every epoch, 1 = anywhere on the circle (no relation).
 */
export function epochPhases(n: number, meanDeg: number, scatter: number, seed: number): number[] {
  const random = mulberry32(seed)
  return Array.from({ length: n }, () => meanDeg + (random() * 2 - 1) * 180 * scatter)
}

export const toArrow = (deg: number): Arrow => ({ x: Math.cos(rad(deg)), y: Math.sin(rad(deg)) })

export function meanArrow(phasesDeg: number[]): Arrow {
  const arrows = phasesDeg.map(toArrow)
  const n = Math.max(1, arrows.length)
  return { x: arrows.reduce((sum, a) => sum + a.x, 0) / n, y: arrows.reduce((sum, a) => sum + a.y, 0) / n }
}

export const length = (arrow: Arrow) => Math.hypot(arrow.x, arrow.y)

/** The three phase-based metrics with unit amplitudes, as in the manual's Lab 03 section. */
export function phaseMetrics(phasesDeg: number[]) {
  const mean = meanArrow(phasesDeg)
  const imag = phasesDeg.map((deg) => Math.sin(rad(deg)))
  const meanAbsImag = imag.reduce((sum, value) => sum + Math.abs(value), 0) / Math.max(1, imag.length)
  const n = phasesDeg.length
  const plv = length(mean)
  return {
    plv,
    /** Pairwise phase consistency: PLV with the small-sample bias removed. */
    ppc: n > 1 ? (n * plv * plv - 1) / (n - 1) : 0,
    imaginary: Math.abs(mean.y),
    wpli: meanAbsImag > 0 ? Math.abs(mean.y) / meanAbsImag : 0,
  }
}

/** PLV of unrelated signals: n uniformly random arrows, repeated. */
export function nullPlv(n: number, repeats: number, seed: number): number[] {
  const random = mulberry32(seed)
  return Array.from({ length: repeats }, () => length(meanArrow(Array.from({ length: n }, () => random() * 360))))
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]!
}

/** Lag in milliseconds of a phase difference at a given frequency. */
export const lagMs = (deg: number, frequencyHz: number) => (deg / 360) * (1000 / frequencyHz)
