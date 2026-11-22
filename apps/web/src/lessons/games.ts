// P2-2: practice games. Every question is generated from a seed, so there are endlessly many,
// the answer is always known, and "today's question" is the same for everyone in a class.
import { correlation, crossCorrelation, inverseProfile, rng, GRID, mix, mixingWeights, standardize, TIMES as JOURNEY_TIMES, FS as JOURNEY_FS } from './journey'

export const GAME_FS = 250
export const CLIP_S = 3
const N = GAME_FS * CLIP_S
export const CLIP_TIMES = Array.from({ length: N }, (_, i) => i / GAME_FS)

export const CHANNELS_19 = ['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'T7', 'C3', 'Cz', 'C4', 'T8', 'P7', 'P3', 'Pz', 'P4', 'P8', 'O1', 'O2']
// Same flat-head layout as ScalpTopography (x right, y towards the back).
const POS: Record<string, [number, number]> = {
  Fp1: [39, 18], Fp2: [61, 18], F7: [20, 34], F3: [35, 37], Fz: [50, 37], F4: [65, 37], F8: [80, 34],
  T7: [16, 55], C3: [33, 55], Cz: [50, 55], C4: [67, 55], T8: [84, 55],
  P7: [20, 76], P3: [35, 73], Pz: [50, 73], P4: [65, 73], P8: [80, 76], O1: [39, 91], O2: [61, 91],
}

function gauss(random: () => number) {
  const u = Math.max(random(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
}

/** Sum of random sinusoids in a band, unit standard deviation. */
function band(random: () => number, lo: number, hi: number, n = N, fs = GAME_FS, parts = 30): number[] {
  const waves = Array.from({ length: parts }, () => ({ f: lo + random() * (hi - lo), p: random() * 2 * Math.PI, a: 0.5 + random() }))
  return standardize(Array.from({ length: n }, (_, i) => waves.reduce((s, w) => s + w.a * Math.sin(2 * Math.PI * w.f * (i / fs) + w.p), 0)))
}

/** Background EEG: 1/f-ish mix of theta, alpha and beta, about 10 µV. */
function background(random: () => number): number[] {
  const theta = band(random, 4, 7)
  const alpha = band(random, 8, 12)
  const beta = band(random, 14, 25)
  return theta.map((v, i) => 6 * v + 7 * alpha[i]! + 3 * beta[i]! + 1.5 * gauss(random))
}

// ── Artifact quiz ──────────────────────────────────────────────────────────────────────────────

export type ArtifactKind = 'blink' | 'muscle' | 'line' | 'drift' | 'pop'

export const ARTIFACTS: Record<ArtifactKind, { label: string; english: string; tell: string[] }> = {
  blink: {
    label: '눈 깜박임', english: 'Eye blink',
    tell: ['0.2–0.4초 동안 한쪽으로 크게 솟는 둥근 파형입니다.', '스펙트럼은 5 Hz 아래 낮은 주파수에 몰립니다.', '지형도는 앞쪽(Fp1·Fp2)이 가장 크고 뒤로 갈수록 작아집니다.'],
  },
  muscle: {
    label: '근전도', english: 'Muscle (EMG)',
    tell: ['가늘고 빽빽한 떨림이 폭발처럼 나타났다 사라집니다.', '스펙트럼은 20 Hz 위로 넓게 올라가며, 뇌파 대역보다 높은 쪽이 두껍습니다.', '지형도는 관자놀이(T7·T8) 한쪽이 큽니다. 턱을 악물면 생깁니다.'],
  },
  line: {
    label: '전원 잡음', english: 'Line noise',
    tell: ['파형이 일정한 굵기로 두꺼워 보이고, 확대하면 아주 규칙적인 빠른 진동입니다.', '스펙트럼에 60 Hz(지역에 따라 50 Hz) 한 줄이 뾰족하게 섭니다.', '지형도는 넓게 퍼져 있고, 접촉이 나쁜 전극 하나가 특히 클 수 있습니다.'],
  },
  drift: {
    label: '느린 표류', english: 'Drift (sweat)',
    tell: ['기준선이 몇 초에 걸쳐 천천히 오르내립니다.', '스펙트럼은 1 Hz 아래가 매우 큽니다.', '지형도는 이웃한 몇 전극에 걸쳐 있습니다. 땀이나 전극 젤이 마르며 생깁니다.'],
  },
  pop: {
    label: '전극 튐', english: 'Electrode pop',
    tell: ['한순간 수직으로 뛰었다가 천천히 돌아옵니다.', '스펙트럼은 낮은 주파수 쪽으로 넓게 퍼질 뿐 뚜렷한 봉우리가 없습니다.', '지형도는 전극 하나만 크고 이웃은 조용합니다. 생리 신호는 이렇게 한 점에만 있을 수 없습니다.'],
  },
}

export const ARTIFACT_KINDS = Object.keys(ARTIFACTS) as ArtifactKind[]

export interface ArtifactClip {
  kind: ArtifactKind
  channels: string[]
  data: number[][]
  /** Channel shown in the waveform clues: where the artifact is largest. */
  focus: number
  /** Centre of the artifact, for the short first clue. */
  centerS: number
  /** Artifact amplitude per channel, signed and scaled to [-1, 1], for the topography clue. */
  topography: number[]
}

export function artifactClip(seed: number, kind?: ArtifactKind): ArtifactClip {
  const random = rng(seed * 7919 + 17)
  const chosen = kind ?? ARTIFACT_KINDS[Math.floor(random() * ARTIFACT_KINDS.length)]!
  const base = CHANNELS_19.map(() => background(random))
  const center = 0.9 + random() * 1.2
  const art: number[] = Array.from({ length: N }, () => 0)
  let weights = CHANNELS_19.map(() => 0)

  if (chosen === 'blink') {
    const amp = 90 + random() * 60
    CLIP_TIMES.forEach((t, i) => { art[i] = amp * Math.exp(-(((t - center) / 0.12) ** 2)) })
    weights = CHANNELS_19.map((ch) => Math.exp(-(POS[ch]![1] - 18) / 18))
  } else if (chosen === 'muscle') {
    const right = random() < 0.5
    const emg = band(random, 25, 110, N, GAME_FS, 60)
    CLIP_TIMES.forEach((t, i) => { art[i] = 45 * emg[i]! * Math.exp(-(((t - center) / 0.45) ** 4)) })
    const [cx, cy] = POS[right ? 'T8' : 'T7']!
    weights = CHANNELS_19.map((ch) => Math.exp(-(((POS[ch]![0] - cx) ** 2 + (POS[ch]![1] - cy) ** 2) / 260)))
  } else if (chosen === 'line') {
    const hz = random() < 0.5 ? 60 : 50
    const phase = random() * 2 * Math.PI
    CLIP_TIMES.forEach((t, i) => { art[i] = 18 * Math.sin(2 * Math.PI * hz * t + phase) })
    const bad = Math.floor(random() * CHANNELS_19.length)
    weights = CHANNELS_19.map((_, c) => (c === bad ? 1 : 0.25 + 0.15 * random()))
  } else if (chosen === 'drift') {
    const f = 0.2 + random() * 0.25
    const phase = random() * 2 * Math.PI
    CLIP_TIMES.forEach((t, i) => { art[i] = 70 * Math.sin(2 * Math.PI * f * t + phase) })
    const centerCh = CHANNELS_19[Math.floor(random() * CHANNELS_19.length)]!
    const [cx, cy] = POS[centerCh]!
    weights = CHANNELS_19.map((ch) => Math.exp(-(((POS[ch]![0] - cx) ** 2 + (POS[ch]![1] - cy) ** 2) / 500)))
  } else {
    const sign = random() < 0.5 ? -1 : 1
    CLIP_TIMES.forEach((t, i) => { art[i] = t < center ? 0 : sign * 160 * Math.exp(-(t - center) / 0.35) })
    const bad = Math.floor(random() * CHANNELS_19.length)
    weights = CHANNELS_19.map((_, c) => (c === bad ? 1 : 0))
  }

  const data = base.map((row, c) => row.map((v, i) => v + weights[c]! * art[i]!))
  const focus = weights.reduce((best, w, c) => (w > weights[best]! ? c : best), 0)
  const peak = Math.max(...weights)
  return { kind: chosen, channels: CHANNELS_19, data, focus, centerS: chosen === 'drift' || chosen === 'line' ? CLIP_S / 2 : center, topography: weights.map((w) => w / peak) }
}

/** Amplitude spectrum in 1 Hz bins (Hann window, plain DFT: the clip is short). */
export function amplitudeSpectrum(values: number[], fs = GAME_FS, maxHz = 100): { hz: number[]; amp: number[] } {
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n
  const windowed = values.map((v, i) => (v - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))))
  const hz: number[] = []
  const amp: number[] = []
  for (let f = 0.5; f <= maxHz; f += 0.5) {
    let re = 0
    let im = 0
    for (let i = 0; i < n; i += 1) {
      const angle = (2 * Math.PI * f * i) / fs
      re += windowed[i]! * Math.cos(angle)
      im -= windowed[i]! * Math.sin(angle)
    }
    hz.push(f)
    amp.push((2 * Math.hypot(re, im)) / (n / 2))
  }
  return { hz, amp }
}

/** Points for answering at clue stage 0–3: an earlier answer is a bolder read. */
export const CLUE_POINTS = [4, 3, 2, 1]

// ── Is this peak real? ─────────────────────────────────────────────────────────────────────────

export interface ConnectionQuestion {
  kind: 'connection'
  /** Electrodes asked about (0–3 along the line). */
  pair: [number, number]
  real: boolean
  spread: number
  lagMs: number
  electrode: ReturnType<typeof crossCorrelation>
  source: ReturnType<typeof crossCorrelation>
}

/**
 * Four sources on a line; one adjacent pair is coupled with a lag, the other pair never is.
 * The learner sees the electrode cross-correlation over lags and decides: planted coupling or
 * volume conduction? Field spread makes the zero-lag peak; real coupling has a lagged one.
 */
export function connectionQuestion(seed: number): ConnectionQuestion {
  // Short random rhythms correlate by chance. Keep only draws that read cleanly, so the question
  // is fair: a fake pair must show a clear zero-lag peak, a real pair its planted lag.
  let question = buildConnection(seed, 0)
  for (let attempt = 1; attempt < 30 && !readsCleanly(question); attempt += 1) question = buildConnection(seed, attempt)
  return question
}

function readsCleanly(question: ConnectionQuestion) {
  return question.real ? question.electrode.peakLagMs === question.lagMs : question.electrode.peakLagMs === 0 && question.electrode.peakValue >= 0.35
}

function buildConnection(seed: number, attempt: number): ConnectionQuestion {
  const random = rng(seed * 104729 + 3 + attempt * 7919)
  const coupledFirst = random() < 0.5
  const real = random() < 0.5
  const spread = 0.3 + random() * 0.25
  const lagMs = (random() < 0.5 ? -1 : 1) * (20 + Math.round(random() * 6) * 5)
  const shift = Math.round((Math.abs(lagMs) / 1000) * JOURNEY_FS)
  const n = JOURNEY_TIMES.length
  const raw = [0, 1, 2, 3].map(() => band(random, 4, 30, n + 40, JOURNEY_FS))
  const sources = raw.map((row) => row.slice(20, 20 + n))
  const [lead, follow] = coupledFirst ? [0, 1] : [2, 3]
  const leader = lagMs > 0 ? lead : follow
  const follower = lagMs > 0 ? follow : lead
  sources[follower] = sources[follower]!.map((v, i) => 0.45 * v + 0.9 * raw[leader]![20 + i - shift]!)
  const pair: [number, number] = real === coupledFirst ? [0, 1] : [2, 3]
  const electrodes = mix(mixingWeights(spread), sources)
  return {
    kind: 'connection', pair, real, spread, lagMs,
    electrode: crossCorrelation(electrodes[pair[0]]!, electrodes[pair[1]]!, 80, 5),
    source: crossCorrelation(sources[pair[0]]!, sources[pair[1]]!, 80, 5),
  }
}

export interface SourceQuestion {
  kind: 'source'
  estimate: number[]
  /** Grid index the learner is asked about. */
  probe: number
  truthIndex: number
  real: boolean
}

/** One true source; the probe sits either on it or on the blurred flank. Flank ≠ source. */
export function sourceQuestion(seed: number): SourceQuestion {
  const random = rng(seed * 15485863 + 11)
  const position = 0.2 + random() * 0.6
  const lambda = 0.3 + random() * 0.5
  const result = inverseProfile(position, lambda, seed)
  const real = random() < 0.5
  const offset = (random() < 0.5 ? -1 : 1) * (3 + Math.floor(random() * 3))
  const probe = real ? result.truthIndex : Math.min(GRID.length - 1, Math.max(0, result.truthIndex + offset))
  return { kind: 'source', estimate: result.estimate, probe, truthIndex: result.truthIndex, real }
}

// ── Sandbox: add noise, restore, get a score ───────────────────────────────────────────────────

const SANDBOX_S = 4
const SN = GAME_FS * SANDBOX_S
export const SANDBOX_TIMES = Array.from({ length: SN }, (_, i) => i / GAME_FS)

export function sandboxClean(): number[] {
  const random = rng(2024)
  const alpha = band(random, 9.5, 10.5, SN, GAME_FS, 6)
  const theta = band(random, 5.5, 6.5, SN, GAME_FS, 6)
  return alpha.map((v, i) => 14 * v + 7 * theta[i]!)
}

export interface NoiseSettings { line: number; drift: number; muscle: number }
export interface FilterSettings { highPass: number; lowPass: number; notch: boolean }

export function sandboxNoise({ line, drift, muscle }: NoiseSettings): number[] {
  const random = rng(77)
  const emg = band(random, 30, 110, SN, GAME_FS, 60)
  return SANDBOX_TIMES.map((t, i) => line * Math.sin(2 * Math.PI * 60 * t + 0.4) + drift * Math.sin(2 * Math.PI * 0.25 * t + 1.1) + muscle * emg[i]!)
}

/** RBJ cookbook biquad coefficients, normalised by a0. */
function biquad(type: 'lowpass' | 'highpass' | 'notch', f0: number, q: number, fs = GAME_FS) {
  const w = (2 * Math.PI * f0) / fs
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  let b: number[]
  if (type === 'lowpass') b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
  else if (type === 'highpass') b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
  else b = [1, -2 * cos, 1]
  const a = [1 + alpha, -2 * cos, 1 - alpha]
  return { b: b.map((v) => v / a[0]!), a: [1, a[1]! / a[0]!, a[2]! / a[0]!] }
}

function runBiquad(values: number[], { b, a }: { b: number[]; a: number[] }): number[] {
  const out: number[] = []
  let x1 = values[0]!, x2 = values[0]!, y1 = 0, y2 = 0
  // Start from a steady state on the first sample so the edges do not ring.
  const gain = (b[0]! + b[1]! + b[2]!) / (1 + a[1]! + a[2]!)
  y1 = y2 = gain * values[0]!
  for (const x of values) {
    const y = b[0]! * x + b[1]! * x1 + b[2]! * x2 - a[1]! * y1 - a[2]! * y2
    x2 = x1; x1 = x; y2 = y1; y1 = y
    out.push(y)
  }
  return out
}

/** Zero-phase (forward then backward) 2nd-order filtering, like filtfilt. */
function zeroPhase(values: number[], coeffs: ReturnType<typeof biquad>): number[] {
  return runBiquad(runBiquad(values, coeffs).reverse(), coeffs).reverse()
}

export function applyFilters(values: number[], { highPass, lowPass, notch }: FilterSettings): number[] {
  let out = values
  if (highPass > 0) out = zeroPhase(out, biquad('highpass', highPass, Math.SQRT1_2))
  if (lowPass > 0) out = zeroPhase(out, biquad('lowpass', lowPass, Math.SQRT1_2))
  if (notch) out = zeroPhase(out, biquad('notch', 60, 10))
  return out
}

const rms = (values: number[]) => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length)

/**
 * Restoration score: how much of the added error was removed (0–100), and how much of the clean
 * signal survived (correlation). Both matter: a filter that kills everything removes the noise too.
 */
export function restorationScore(clean: number[], noisy: number[], restored: number[]) {
  const before = rms(noisy.map((v, i) => v - clean[i]!))
  const after = rms(restored.map((v, i) => v - clean[i]!))
  const errorRemoved = before > 1e-9 ? Math.max(0, Math.min(1, 1 - after / before)) : after < 0.5 ? 1 : 0
  return { errorRemoved, errorUv: after, kept: correlation(clean, restored), score: Math.round(100 * Math.max(0, 1 - after / rms(clean))) }
}

// ── Today's question ───────────────────────────────────────────────────────────────────────────

/** Seed from the local calendar date, so a whole class gets the same question on the same day. */
export function dailySeed(date: Date): number {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate()
}

export type DailyGame = 'artifact' | 'connection' | 'source'

export function dailyGame(seed: number): DailyGame {
  return (['artifact', 'connection', 'source'] as const)[seed % 3]!
}
