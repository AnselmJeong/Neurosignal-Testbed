// P2-1 "Lab 00 · 신호 여행": the arithmetic behind seven short scenes that follow one signal
// from source to electrode to estimate. Everything is computed in the browser from fixed seeds,
// so the tour needs no server and gives the same numbers every time.

export const FS = 200
export const DURATION_S = 2
export const TIMES = Array.from({ length: FS * DURATION_S }, (_, i) => i / FS)

/** Park–Miller generator: small, seedable, good enough for teaching noise. */
export function rng(seed: number) {
  let state = seed % 2147483647
  if (state <= 0) state += 2147483646
  return () => (state = (state * 16807) % 2147483647) / 2147483647
}

/**
 * A band-limited random rhythm: the sum of many sinusoids between lo and hi Hz with random
 * phases, normalised to unit standard deviation. It looks like EEG and has a sharp
 * cross-correlation peak, which the direction scene needs.
 */
export function bandNoise(seed: number, lo = 4, hi = 30, n = TIMES.length + 60): number[] {
  const random = rng(seed)
  const parts = Array.from({ length: 40 }, () => ({ f: lo + random() * (hi - lo), phase: random() * 2 * Math.PI, a: 0.5 + random() }))
  const values = Array.from({ length: n }, (_, i) => parts.reduce((sum, part) => sum + part.a * Math.sin(2 * Math.PI * part.f * (i / FS) + part.phase), 0))
  return standardize(values)
}

export function standardize(values: number[]): number[] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 1
  return values.map((value) => (value - mean) / sd)
}

export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < n; i += 1) {
    sab += (a[i]! - ma) * (b[i]! - mb)
    saa += (a[i]! - ma) ** 2
    sbb += (b[i]! - mb) ** 2
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0
}

// Scene 1 ── one source oscillates.
export function sine(frequencyHz: number, amplitude = 1): number[] {
  return TIMES.map((t) => amplitude * Math.sin(2 * Math.PI * frequencyHz * t))
}

// Scenes 2–4 ── sources on a line under electrodes on a line. Spread is how far one source's
// field reaches: 0 = each electrode hears only the source under it.
export const SOURCE_X = [0, 1, 2, 3]
export const ELECTRODE_X = [0, 1, 2, 3]

export function mixingWeights(spread: number): number[][] {
  const width = 0.15 + spread * 1.6
  return ELECTRODE_X.map((ex) => {
    const row = SOURCE_X.map((sx) => Math.exp(-(((ex - sx) / width) ** 2)))
    const total = row.reduce((a, b) => a + b, 0)
    return row.map((value) => value / total)
  })
}

export function mix(weights: number[][], sources: number[][]): number[][] {
  return weights.map((row) => TIMES.map((_, i) => row.reduce((sum, w, s) => sum + w * sources[s]![i]!, 0)))
}

/** Share of an electrode's variance that comes from one source (sources independent, unit variance). */
export function sourceShare(weights: number[][], electrode: number, source: number): number {
  const row = weights[electrode]!
  const total = row.reduce((a, w) => a + w * w, 0)
  return total ? row[source]! ** 2 / total : 0
}

/** Four independent rhythms; with coupling c, source B takes c of its signal from A. */
export function coupledSources(coupling: number): number[][] {
  const [a, b0, c, d] = [11, 23, 37, 53].map((seed) => bandNoise(seed).slice(0, TIMES.length))
  const b = b0!.map((value, i) => Math.sqrt(1 - coupling ** 2) * value + coupling * a![i]!)
  return [a!, b, c!, d!]
}

export interface ConnectionReading {
  sourceAB: number
  electrodeAB: number
  sourceCD: number
  electrodeCD: number
}

/** Scene 4: the A–B pair is coupled, the C–D pair never is. Electrodes see both as related. */
export function connectionReading(coupling: number, spread: number): ConnectionReading {
  const sources = coupledSources(coupling)
  const electrodes = mix(mixingWeights(spread), sources)
  return {
    sourceAB: correlation(sources[0]!, sources[1]!),
    electrodeAB: correlation(electrodes[0]!, electrodes[1]!),
    sourceCD: correlation(sources[2]!, sources[3]!),
    electrodeCD: correlation(electrodes[2]!, electrodes[3]!),
  }
}

// Scene 3 ── a blink rides on top and is projected out.
export function blinkWave(amplitude = 90): number[] {
  return TIMES.map((t) => amplitude * Math.exp(-(((t - 1) / 0.11) ** 2)))
}

/** Blink topography: strongest at the front electrode. */
export const BLINK_TOPO = [1, 0.55, 0.25, 0.1]

/**
 * Scene 3 result. Removal projects the electrode data off the blink's spatial pattern, which is
 * what dropping one ICA component does. A neural source whose pattern overlaps the blink's loses
 * the overlapping part as well.
 */
export function blinkRemoval(overlap: number) {
  const neuralTopo = BLINK_TOPO.map((value, i) => overlap * value + (1 - overlap) * [0.1, 0.3, 0.7, 1][i]!)
  const neural = bandNoise(71, 8, 12).slice(0, TIMES.length).map((value) => value * 20)
  const blink = blinkWave()
  const recorded = BLINK_TOPO.map((b, e) => TIMES.map((_, i) => b * blink[i]! + neuralTopo[e]! * neural[i]!))
  const norm = Math.sqrt(BLINK_TOPO.reduce((a, v) => a + v * v, 0))
  const unit = BLINK_TOPO.map((v) => v / norm)
  const cleaned = recorded.map((row) => row.slice())
  for (let i = 0; i < TIMES.length; i += 1) {
    const projection = unit.reduce((sum, u, e) => sum + u * recorded[e]![i]!, 0)
    unit.forEach((u, e) => { cleaned[e]![i] = recorded[e]![i]! - projection * u })
  }
  const topoNorm = Math.sqrt(neuralTopo.reduce((a, v) => a + v * v, 0))
  const cosine = neuralTopo.reduce((sum, v, e) => sum + v * unit[e]!, 0) / topoNorm
  // Fraction of the neural signal's energy (summed over electrodes) that removal takes with it.
  const neuralLoss = cosine ** 2
  return { recorded, cleaned, neural: neuralTopo.map((w) => neural.map((value) => w * value)), neuralLoss }
}

// Scene 5 ── going back from electrodes to sources blurs: a 1-D minimum-norm toy.
export const GRID = Array.from({ length: 41 }, (_, i) => i / 40)
export const SENSORS = Array.from({ length: 8 }, (_, i) => (i + 0.5) / 8)
const DEPTH = 0.12

export function leadField(): number[][] {
  return SENSORS.map((s) => GRID.map((g) => DEPTH / ((s - g) ** 2 + DEPTH ** 2)))
}

/** Solve A x = b by Gaussian elimination with partial pivoting (A is small and square). */
export function solve(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length
  const a = matrix.map((row, i) => [...row, rhs[i]!])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let r = col + 1; r < n; r += 1) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r
    ;[a[col], a[pivot]] = [a[pivot]!, a[col]!]
    for (let r = col + 1; r < n; r += 1) {
      const factor = a[r]![col]! / a[col]![col]!
      for (let c = col; c <= n; c += 1) a[r]![c]! -= factor * a[col]![c]!
    }
  }
  const x = Array.from({ length: n }, () => 0)
  for (let r = n - 1; r >= 0; r -= 1) {
    let sum = a[r]![n]!
    for (let c = r + 1; c < n; c += 1) sum -= a[r]![c]! * x[c]!
    x[r] = sum / a[r]![r]!
  }
  return x
}

/**
 * Minimum-norm estimate ĵ = Lᵀ(LLᵀ + λ²·tr(LLᵀ)/n·I)⁻¹x for a point source at `position`
 * (0–1 along the grid). λ is relative so the slider means the same at any scale.
 */
export function inverseProfile(position: number, lambda: number, noiseSeed = 5, noise = 0.02) {
  const L = leadField()
  const truthIndex = Math.round(position * (GRID.length - 1))
  const random = rng(noiseSeed)
  const x = L.map((row) => row[truthIndex]! + noise * (random() - 0.5) * 2)
  const n = SENSORS.length
  const gram = L.map((ri) => L.map((rj) => ri.reduce((sum, v, k) => sum + v * rj[k]!, 0)))
  const trace = gram.reduce((sum, row, i) => sum + row[i]!, 0) / n
  const regularized = gram.map((row, i) => row.map((v, j) => v + (i === j ? lambda ** 2 * trace : 0)))
  const w = solve(regularized, x)
  const estimate = GRID.map((_, g) => L.reduce((sum, row, e) => sum + row[g]! * w[e]!, 0))
  const peak = estimate.reduce((best, value, i) => (value > estimate[best]! ? i : best), 0)
  const half = estimate[peak]! / 2
  let left = peak
  let right = peak
  while (left > 0 && estimate[left - 1]! >= half) left -= 1
  while (right < GRID.length - 1 && estimate[right + 1]! >= half) right += 1
  return {
    estimate,
    truthIndex,
    peakIndex: peak,
    errorPct: Math.abs(GRID[peak]! - GRID[truthIndex]!) * 100,
    widthPct: (GRID[right]! - GRID[left]!) * 100,
  }
}

// Scene 7 ── direction: does the past of A help predict B?
export function drivenPair(lagMs: number, coupling = 0.8) {
  const base = bandNoise(97)
  const other = bandNoise(131)
  const shift = Math.round((Math.abs(lagMs) / 1000) * FS)
  const offset = 30
  const leader = base.slice(offset, offset + TIMES.length)
  // The follower copies the leader `shift` samples later, plus its own rhythm.
  const follower = TIMES.map((_, i) => coupling * base[offset + i - shift]! + Math.sqrt(1 - coupling ** 2) * other[offset + i]!)
  return lagMs >= 0 ? { a: leader, b: follower } : { a: follower, b: leader }
}

/** r(k) = corr(A(t), B(t + k)): a peak at positive k means A moves first. */
export function crossCorrelation(a: number[], b: number[], maxLagMs = 100, stepMs = 5) {
  const lags: number[] = []
  const values: number[] = []
  for (let lag = -maxLagMs; lag <= maxLagMs; lag += stepMs) {
    const k = Math.round((lag / 1000) * FS)
    const x = k >= 0 ? a.slice(0, a.length - k) : a.slice(-k)
    const y = k >= 0 ? b.slice(k) : b.slice(0, b.length + k)
    lags.push(lag)
    values.push(correlation(x, y))
  }
  const peak = values.reduce((best, value, i) => (value > values[best]! ? i : best), 0)
  return { lags, values, peakLagMs: lags[peak]!, peakValue: values[peak]! }
}
