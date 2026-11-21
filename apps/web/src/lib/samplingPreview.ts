// Browser-side preview of the Lab 01 pipeline, so sliders answer while they move.
//
// The server run stays the source of truth: when it returns, its values replace the preview.
// What matches the server exactly: the filter response (closed-form Butterworth and notch
// gains for the same bilinear-transformed designs), the source waveforms and mixing matrix,
// and the Welch settings. What is only approximate: the 1/f background uses a different
// random generator, and the zero-phase filter is applied in the frequency domain instead of
// with sosfiltfilt, so the first and last few hundred milliseconds can differ slightly.
import type { ExperimentRecipe, ExperimentResult, SourceSpec, WarningMessage } from '../types'

export interface SamplingPreview {
  recipe: ExperimentRecipe
  time: number[]
  channelNames: string[]
  raw: Record<string, number[]>
  filtered: Record<string, number[]>
  spectrumFrequency: number[]
  rawPower: Record<string, number[]>
  filteredPower: Record<string, number[]>
  responseFrequency: number[]
  responseGainDb: number[]
  mixingMatrix: number[][]
}

// ---------------------------------------------------------------------------------------------
// FFT: radix-2 in place, plus Bluestein for any other length (Welch segments are 2·fs long).

function fftRadix2(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    for (let start = 0; start < n; start += size) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < size / 2; k++) {
        const a = start + k
        const b = a + size / 2
        const tr = re[b]! * cr - im[b]! * ci
        const ti = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - tr
        im[b] = im[a]! - ti
        re[a] = re[a]! + tr
        im[a] = im[a]! + ti
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n
      im[i] = im[i]! / n
    }
  }
}

const nextPow2 = (value: number) => 2 ** Math.ceil(Math.log2(Math.max(1, value)))

/** Forward DFT of a real signal of any length. */
export function dft(values: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const n = values.length
  if ((n & (n - 1)) === 0) {
    const re = Float64Array.from(values)
    const im = new Float64Array(n)
    fftRadix2(re, im)
    return { re, im }
  }
  // Bluestein: express the length-n DFT as a convolution evaluated with power-of-two FFTs.
  const m = nextPow2(2 * n - 1)
  const chirpRe = new Float64Array(n)
  const chirpIm = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const angle = (Math.PI * ((k * k) % (2 * n))) / n
    chirpRe[k] = Math.cos(angle)
    chirpIm[k] = -Math.sin(angle)
  }
  const aRe = new Float64Array(m)
  const aIm = new Float64Array(m)
  for (let k = 0; k < n; k++) {
    aRe[k] = values[k]! * chirpRe[k]!
    aIm[k] = values[k]! * chirpIm[k]!
  }
  const bRe = new Float64Array(m)
  const bIm = new Float64Array(m)
  bRe[0] = chirpRe[0]!
  bIm[0] = -chirpIm[0]!
  for (let k = 1; k < n; k++) {
    bRe[k] = bRe[m - k] = chirpRe[k]!
    bIm[k] = bIm[m - k] = -chirpIm[k]!
  }
  fftRadix2(aRe, aIm)
  fftRadix2(bRe, bIm)
  for (let k = 0; k < m; k++) {
    const r = aRe[k]! * bRe[k]! - aIm[k]! * bIm[k]!
    const i = aRe[k]! * bIm[k]! + aIm[k]! * bRe[k]!
    aRe[k] = r
    aIm[k] = i
  }
  fftRadix2(aRe, aIm, true)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    re[k] = aRe[k]! * chirpRe[k]! - aIm[k]! * chirpIm[k]!
    im[k] = aRe[k]! * chirpIm[k]! + aIm[k]! * chirpRe[k]!
  }
  return { re, im }
}

// ---------------------------------------------------------------------------------------------
// Filter response: |H(f)|² of the server's zero-phase Butterworth + notch cascade.

export const NOTCH_QUALITY = 30

interface ActiveFilters {
  highpass: number | null
  lowpass: number | null
  notch: number | null
  order: number
}

/** Same rule as the server: a cutoff at or above Nyquist is skipped, not clamped. */
export function activeFilters(recipe: ExperimentRecipe): ActiveFilters {
  const nyquist = recipe.simulation.sampling_rate_hz / 2
  const { highpass_hz, lowpass_hz, notch_hz, filter_order } = recipe.preprocessing
  const usable = (value: number | null) => (value !== null && value < nyquist ? value : null)
  return { highpass: usable(highpass_hz), lowpass: usable(lowpass_hz), notch: usable(notch_hz), order: filter_order }
}

/**
 * Power gain |H|² of one filter pass at frequency f (Hz). The data see this gain twice in a
 * forward-backward filter, which is why the response is reported as 40·log10|H|.
 */
export function filterPowerGain(f: number, fs: number, filters: ActiveFilters): number {
  const warp = (hz: number) => Math.tan((Math.PI * hz) / fs)
  const w = warp(Math.min(f, fs / 2 - 1e-9))
  const n2 = 2 * filters.order
  let gain = 1
  const { highpass: low, lowpass: high } = filters
  if (low !== null && high !== null) {
    // scipy.signal.butter(..., btype="bandpass"): lowpass prototype → lp2bp on prewarped edges.
    const wl = warp(low)
    const wh = warp(high)
    const centre2 = wl * wh
    const width = wh - wl
    const x = w === 0 ? Infinity : Math.abs((w * w - centre2) / (width * w))
    gain = x === Infinity ? 0 : 1 / (1 + x ** n2)
  } else if (low !== null) {
    gain = w === 0 ? 0 : 1 / (1 + (warp(low) / w) ** n2)
  } else if (high !== null) {
    gain = 1 / (1 + (w / warp(high)) ** n2)
  }
  if (filters.notch !== null) {
    // scipy.signal.iirnotch(f0, Q, fs)
    const w0 = (2 * Math.PI * filters.notch) / fs
    const bw = w0 / NOTCH_QUALITY
    const g = 1 / (1 + Math.tan(bw / 2))
    const c = Math.cos(w0)
    const omega = (2 * Math.PI * f) / fs
    const z1r = Math.cos(omega), z1i = -Math.sin(omega)
    const z2r = Math.cos(2 * omega), z2i = -Math.sin(2 * omega)
    const br = g * (1 - 2 * c * z1r + z2r)
    const bi = g * (-2 * c * z1i + z2i)
    const ar = 1 - 2 * g * c * z1r + (2 * g - 1) * z2r
    const ai = -2 * g * c * z1i + (2 * g - 1) * z2i
    gain *= (br * br + bi * bi) / (ar * ar + ai * ai)
  }
  return gain
}

/** The server's filter_response: 512 points from 0 to just below Nyquist, in dB of |H|². */
export function filterResponse(recipe: ExperimentRecipe) {
  const fs = recipe.simulation.sampling_rate_hz
  const filters = activeFilters(recipe)
  const any = filters.highpass !== null || filters.lowpass !== null || filters.notch !== null
  const frequency = Array.from({ length: 512 }, (_, k) => any ? (k * fs) / 2 / 512 : (k * fs) / 2 / 511)
  const gainDb = frequency.map((f) => any ? 20 * Math.log10(Math.max(filterPowerGain(f, fs, filters), 1e-16)) : 0)
  return { frequency, gainDb }
}

// ---------------------------------------------------------------------------------------------
// Welch PSD with scipy.signal.welch defaults (Hann, 50 % overlap, constant detrend, density).

export function welchSegment(sampleCount: number, fs: number) {
  return Math.min(sampleCount, Math.max(256, Math.floor(fs * 2)))
}

export function welch(values: ArrayLike<number>, fs: number, nperseg = welchSegment(values.length, fs)) {
  const step = nperseg - Math.floor(nperseg / 2)
  const window = Array.from({ length: nperseg }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nperseg))
  const windowPower = window.reduce((sum, value) => sum + value * value, 0)
  const bins = Math.floor(nperseg / 2) + 1
  const power = new Float64Array(bins)
  let segments = 0
  for (let start = 0; start + nperseg <= values.length; start += step) {
    let mean = 0
    for (let i = 0; i < nperseg; i++) mean += values[start + i]!
    mean /= nperseg
    const segment = new Float64Array(nperseg)
    for (let i = 0; i < nperseg; i++) segment[i] = (values[start + i]! - mean) * window[i]!
    const { re, im } = dft(segment)
    for (let k = 0; k < bins; k++) {
      const scale = k === 0 || (nperseg % 2 === 0 && k === bins - 1) ? 1 : 2
      power[k] = power[k]! + (scale * (re[k]! ** 2 + im[k]! ** 2)) / (fs * windowPower)
    }
    segments++
  }
  return {
    frequency: Array.from({ length: bins }, (_, k) => (k * fs) / nperseg),
    power: Array.from(power, (value) => value / Math.max(1, segments)),
  }
}

// ---------------------------------------------------------------------------------------------
// Signal model: the same sources, envelope and mixing as simulation/engine.py.

function alphaEnvelope(time: number[]): number[] {
  const dt = time.length > 1 ? time[1]! - time[0]! : 0
  const duration = time.length > 1 ? time[time.length - 1]! + dt : 0
  const centres: number[] = []
  for (let c = 0.8; c < duration + 0.8 - 1e-12; c += 2.35) centres.push(c)
  const envelope = time.map((t) => {
    let value = 0.46 + 0.12 * Math.sin(2 * Math.PI * 0.12 * t + 0.4) + 0.07 * Math.sin(2 * Math.PI * 0.035 * t + 1.1)
    centres.forEach((centre, index) => {
      const width = 0.34 + 0.05 * (index % 3)
      const height = 0.32 + 0.06 * Math.sin(index * 1.7 + 0.3)
      value += height * Math.exp(-0.5 * ((t - centre) / width) ** 2)
    })
    return Math.min(1, Math.max(0.25, value))
  })
  const peak = Math.max(...envelope, Number.EPSILON)
  return envelope.map((value) => value / peak)
}

export function stableMixingMatrix(channelCount: number, sourceCount: number): number[][] {
  const linspace = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => n === 1 ? a : a + ((b - a) * i) / (n - 1))
  const channels = linspace(-1, 1, channelCount)
  const sources = linspace(-0.85, 0.85, sourceCount)
  const matrix = channels.map((cp, c) => sources.map((sp, s) => Math.exp(-1.7 * Math.abs(cp - sp)) * ((c + s) % 3 === 0 ? -1 : 1)))
  for (let s = 0; s < sourceCount; s++) {
    const norm = Math.max(Math.hypot(...matrix.map((row) => row[s]!)), Number.EPSILON)
    matrix.forEach((row) => { row[s] = row[s]! / norm })
  }
  return matrix
}

function sourceWaveform(source: SourceSpec, time: number[], duration: number, envelope: () => number[]): number[] {
  if (source.kind === 'blink') {
    const centre = duration * 0.48
    const width = Math.max(0.08, duration * 0.018)
    return time.map((t) => source.amplitude_uv * Math.exp(-0.5 * ((t - centre) / width) ** 2))
  }
  const phase = (source.phase_deg * Math.PI) / 180
  const wave = time.map((t) => source.amplitude_uv * Math.sin(2 * Math.PI * source.frequency_hz * t + phase))
  if (source.frequency_hz >= 8 && source.frequency_hz <= 13) {
    const env = envelope()
    return wave.map((value, i) => value * env[i]!)
  }
  return wave
}

function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normalSampler(seed: number) {
  const uniform = mulberry32(seed)
  return () => {
    const u = Math.max(uniform(), Number.EPSILON)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform())
  }
}

function normalize(values: number[]): number[] {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length)
  return values.map((value) => (value - mean) / Math.max(sd, Number.EPSILON))
}

/** Unit-RMS noise with a 1/f power spectrum, shaped in the frequency domain. */
function oneOverF(normal: () => number, sampleCount: number): number[] {
  const size = nextPow2(sampleCount)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  for (let k = 1; k < size / 2; k++) {
    const amplitude = (k / size) ** -0.5
    re[k] = normal() * amplitude
    im[k] = normal() * amplitude
    re[size - k] = re[k]!
    im[size - k] = -im[k]!
  }
  fftRadix2(re, im, true)
  return normalize(Array.from(re.subarray(0, sampleCount)))
}

/** Zero-phase filtering as a multiplication by |H|², with mirrored padding against wrap-around. */
function zeroPhaseFilter(values: number[], fs: number, filters: ActiveFilters): number[] {
  const n = values.length
  const pad = Math.min(n - 1, Math.round(fs))
  const size = nextPow2(n + 2 * pad)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    const j = i - pad
    // Odd extension, as scipy's filtfilt pads by default.
    re[i] = j < 0 ? 2 * values[0]! - values[Math.min(n - 1, -j)]!
      : j >= n ? 2 * values[n - 1]! - values[Math.max(0, 2 * (n - 1) - j)]!
      : values[j]!
  }
  fftRadix2(re, im)
  for (let k = 0; k <= size / 2; k++) {
    const gain = filterPowerGain((k * fs) / size, fs, filters)
    re[k] = re[k]! * gain
    im[k] = im[k]! * gain
    if (k > 0 && k < size / 2) {
      re[size - k] = re[size - k]! * gain
      im[size - k] = im[size - k]! * gain
    }
  }
  fftRadix2(re, im, true)
  return Array.from(re.subarray(pad, pad + n))
}

export function computeSamplingPreview(recipe: ExperimentRecipe): SamplingPreview {
  const { simulation, preprocessing } = recipe
  const fs = simulation.sampling_rate_hz
  const sampleCount = Math.round(simulation.duration_s * fs)
  const time = Array.from({ length: sampleCount }, (_, i) => i / fs)
  let cachedEnvelope: number[] | null = null
  const envelope = () => (cachedEnvelope ??= alphaEnvelope(time))
  const latent = simulation.sources.map((source) => sourceWaveform(source, time, simulation.duration_s, envelope))
  const mixing = stableMixingMatrix(simulation.channel_count, simulation.sources.length)
  const normal = normalSampler(simulation.seed)
  const shared = oneOverF(normal, sampleCount)
  const channelNames = Array.from({ length: simulation.channel_count }, (_, i) => `EEG ${String(i + 1).padStart(2, '0')}`)
  const sensor = channelNames.map((_, c) => {
    const independent = oneOverF(normal, sampleCount)
    const coloured = normalize(shared.map((value, i) => 0.42 * value + 0.91 * independent[i]!))
    const background = normalize(coloured.map((value) => 0.96 * value + 0.28 * normal()))
    return time.map((_, i) => latent.reduce((sum, wave, s) => sum + mixing[c]![s]! * wave[i]!, 0) + simulation.noise_uv * background[i]!)
  })
  const referenced = preprocessing.reference === 'average'
    ? sensor.map((row) => row.map((value, i) => value - sensor.reduce((sum, other) => sum + other[i]!, 0) / sensor.length))
    : sensor
  const filters = activeFilters(recipe)
  const anyFilter = filters.highpass !== null || filters.lowpass !== null || filters.notch !== null
  const filtered = referenced.map((row) => anyFilter ? zeroPhaseFilter(row, fs, filters) : row)
  const raw: Record<string, number[]> = {}
  const processed: Record<string, number[]> = {}
  const rawPower: Record<string, number[]> = {}
  const filteredPower: Record<string, number[]> = {}
  let spectrumFrequency: number[] = []
  channelNames.forEach((name, c) => {
    raw[name] = sensor[c]!
    processed[name] = filtered[c]!
    const before = welch(sensor[c]!, fs)
    rawPower[name] = before.power
    filteredPower[name] = welch(filtered[c]!, fs).power
    spectrumFrequency = before.frequency
  })
  const response = filterResponse(recipe)
  return {
    recipe, time, channelNames, raw, filtered: processed, spectrumFrequency, rawPower, filteredPower,
    responseFrequency: response.frequency, responseGainDb: response.gainDb, mixingMatrix: mixing,
  }
}


// ---------------------------------------------------------------------------------------------
// Warnings and the result shape, so the canvas can draw a preview exactly like a server run.

const fmt = (value: number) => String(Number(value.toPrecision(6)))

/** Port of preprocessing.filters.validate_recipe (same codes and wording). */
export function previewWarnings(recipe: ExperimentRecipe): WarningMessage[] {
  const { simulation, preprocessing } = recipe
  const nyquist = simulation.sampling_rate_hz / 2
  const warnings: WarningMessage[] = []
  const stages: [string, string, number | null][] = [
    ['High-pass', '고역 통과(High-pass)', preprocessing.highpass_hz],
    ['Low-pass', '저역 통과(Low-pass)', preprocessing.lowpass_hz],
    ['Notch', '노치(Notch)', preprocessing.notch_hz],
  ]
  for (const [label, korean, value] of stages) {
    if (value !== null && value >= nyquist) {
      warnings.push({
        code: `${label.toLowerCase().replace('-', '_')}_above_nyquist`,
        severity: label !== 'Notch' ? 'error' : 'warning',
        title: `${korean} 주파수가 Nyquist 이상입니다`,
        explanation: `표본화율 ${simulation.sampling_rate_hz} Hz에서는 ${fmt(value)} Hz를 따로 표현할 수 없어 이 필터 단계는 적용되지 않습니다.`,
        suggestion: `${fmt(nyquist)} Hz보다 낮은 주파수를 쓰거나 표본화율을 높이세요.`,
      })
    }
  }
  if (preprocessing.notch_hz !== null && preprocessing.lowpass_hz !== null && preprocessing.notch_hz > preprocessing.lowpass_hz) {
    warnings.push({
      code: 'redundant_notch',
      severity: 'info',
      title: '여기서는 60 Hz 노치가 중복입니다',
      explanation: '저역 통과(Low-pass)가 이미 60 Hz를 크게 줄이므로, 노치는 독립적인 정리 단계가 아닙니다.',
      suggestion: '비교용으로 남겨 두거나, 설정을 단순하게 하려면 끄세요.',
    })
  }
  const aliased = simulation.sources.filter((source) => source.frequency_hz > nyquist)
  if (aliased.length) {
    const names = aliased.map((source) => `${source.label} (${fmt(source.frequency_hz)} Hz)`).join(', ')
    warnings.push({
      code: 'source_aliasing',
      severity: 'warning',
      title: '심어 둔 원천이 접힙니다(aliasing)',
      explanation: `${names}이(가) Nyquist 주파수 ${fmt(nyquist)} Hz를 넘어서 관측 스펙트럼의 더 낮은 주파수로 접혀 나타납니다.`,
      suggestion: '정답을 공개하기 전에 접힌 주파수를 예측해 보세요.',
    })
  }
  return warnings
}

const PREVIEW_RUN_ID = 'preview'

export const isPreviewResult = (result: ExperimentResult | null) => result?.run_id === PREVIEW_RUN_ID

/** Wrap a preview in the ExperimentResult shape. run_id "preview" marks it as unconfirmed. */
export function previewAsResult(preview: SamplingPreview): ExperimentResult {
  const series: Record<string, number[]> = {}
  for (const name of preview.channelNames) {
    series[`Raw · ${name}`] = preview.raw[name]!
    series[`Filtered · ${name}`] = preview.filtered[name]!
  }
  const mean = (rows: Record<string, number[]>) => preview.spectrumFrequency.map((_, k) => preview.channelNames.reduce((sum, name) => sum + rows[name]![k]!, 0) / preview.channelNames.length)
  const variance = (rows: Record<string, number[]>) => {
    const values = preview.channelNames.flatMap((name) => rows[name]!)
    const average = values.reduce((sum, value) => sum + value, 0) / values.length
    return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length
  }
  const { recipe } = preview
  return {
    run_id: PREVIEW_RUN_ID,
    state: 'completed',
    recipe,
    warnings: previewWarnings(recipe),
    traces: { x: preview.time, series, x_unit: 's', y_unit: 'µV' },
    spectrum: {
      frequency_hz: preview.spectrumFrequency,
      raw_power: mean(preview.rawPower),
      filtered_power: mean(preview.filteredPower),
      raw_power_by_channel: preview.rawPower,
      filtered_power_by_channel: preview.filteredPower,
      unit: 'µV²/Hz',
    },
    filter_response: { frequency_hz: preview.responseFrequency, gain_db: preview.responseGainDb },
    mixing_matrix: preview.mixingMatrix,
    peak_frequencies_hz: [],
    truth_peaks_hz: recipe.simulation.sources.map((source) => source.frequency_hz).sort((a, b) => a - b),
    retained_variance_pct: Math.round((variance(preview.filtered) / Math.max(variance(preview.raw), Number.EPSILON)) * 1000) / 10,
    provenance: {
      recipe_hash: PREVIEW_RUN_ID, created_at: '', engine_version: 'browser-preview', numpy_version: '', scipy_version: '',
      seed: recipe.simulation.seed, sampling_rate_hz: recipe.simulation.sampling_rate_hz, units: 'µV',
      reference: recipe.preprocessing.reference, rank: preview.channelNames.length - (recipe.preprocessing.reference === 'average' ? 1 : 0),
    },
  } as ExperimentResult
}
