import type {
  BenchmarkDraft,
  BenchmarkJob,
  BenchmarkRecipe,
  ComparisonEntry,
  JobState,
  MetricCapability,
  MetricSpec,
  PairedEffect,
} from './types'

// ---------------------------------------------------------------- designer → recipe

export const PRIMARY_Q1_METRICS = ['M14', 'M17', 'M23'] as const

export const PROFILE_DEFAULTS: Record<BenchmarkDraft['profile'], Omit<BenchmarkDraft, 'preset' | 'profile' | 'gOn' | 'reference' | 'sensorNoiseUv' | 'epochS' | 'metrics'>> = {
  // fixtures/recipes/jr-core-preview.json
  preview: { nNodes: 8, seedStart: 100, seedCount: 3, durationS: 40, burnInS: 10, eegSensors: 32, nBootstrap: 999, nSurrogates: 49 },
  // fixtures/recipes/jr-core-comparison.json
  'core-comparison': { nNodes: 32, seedStart: 1000, seedCount: 30, durationS: 120, burnInS: 10, eegSensors: 32, nBootstrap: 999, nSurrogates: 999 },
}

export function defaultDraft(profile: BenchmarkDraft['profile'] = 'preview'): BenchmarkDraft {
  return {
    preset: 'Q1',
    profile,
    gOn: 10,
    reference: 'none',
    sensorNoiseUv: 0,
    epochS: 8,
    metrics: [...PRIMARY_Q1_METRICS],
    ...PROFILE_DEFAULTS[profile],
  }
}

/** Row-normalised ring lattice (k = 2), the default_alpha_preset structure; C is [target][source]. */
export function ringLattice(n: number): { C: number[][]; D: number[][] } {
  const C = Array.from({ length: n }, (_, i) => {
    const row = Array.from({ length: n }, (_, j): number => {
      if (i === j) return 0
      const distance = Math.min(Math.abs(i - j), n - Math.abs(i - j))
      return distance <= 2 ? 1 : 0
    })
    const degree = row.reduce((sum, value) => sum + value, 0)
    return row.map((value) => (degree ? value / degree : 0))
  })
  const D = C.map((row) => row.map((value) => (value > 0 ? 8 : 0)))
  return { C, D }
}

const metricSpec = (id: string): MetricSpec => ({
  id, variant: 'default', backend: null, input_spaces: ['source', 'sensor'], params: {}, required: true,
})

const PROFILE_TITLES: Record<BenchmarkDraft['profile'], string> = {
  preview: 'JR core comparison · preview',
  'core-comparison': 'JR core comparison · 4 conditions',
}

export function buildRecipe(draft: BenchmarkDraft): BenchmarkRecipe {
  const seeds = Array.from({ length: draft.seedCount }, (_, index) => draft.seedStart + index)
  const { C, D } = ringLattice(draft.nNodes)
  const noiseV = draft.sensorNoiseUv * 1e-6
  const observation = (kind: 'identity_probe' | 'eeg_forward', nSensors: number) => ({
    schema_version: '1.0' as const,
    kind,
    n_sensors: nSensors,
    gain: 1.0,
    gain_units: 'A·m/mV',
    baseline: 0.0,
    baseline_units: 'mV',
    reference: draft.reference,
    sensor_noise_std: noiseV,
    sensor_noise_units: 'V',
    mixing: null,
  })
  return {
    recipe_version: '1.0',
    kind: 'jr-benchmark',
    title: PROFILE_TITLES[draft.profile],
    status: 'unvalidated_starting_values',
    notes: ['Built in the web JR Benchmark lab from plan §2.4 starting values; not validated physiology.'],
    calibration_seeds: Array.from({ length: 10 }, (_, index) => index),
    conditions: {
      A: { G: 0, observation: 'identity_probe' },
      B: { G: draft.gOn, observation: 'identity_probe' },
      C: { G: 0, observation: 'eeg_forward' },
      D: { G: draft.gOn, observation: 'eeg_forward' },
    },
    benchmark: {
      schema_version: '1.0',
      question_preset: 'jr-coupling-x-observation',
      factors: { G: [0, draft.gOn], observation: ['identity_probe', 'eeg_forward'] },
      held_fixed: { reference: draft.reference, sensor_noise_std: noiseV, epoch_s: draft.epochS, preprocessing: 'none' },
      seeds,
      metrics: draft.metrics.map(metricSpec),
      profile: draft.profile,
      budget: { max_tasks: null, max_runtime_s: null, max_disk_bytes: null, n_surrogates: draft.nSurrogates, n_bootstrap: draft.nBootstrap },
    },
    simulation: {
      schema_version: '1.0',
      preset: 'jr-alpha-default',
      version: '0.1',
      n_nodes: draft.nNodes,
      node_params: {},
      C,
      D,
      G: draft.gOn,
      input_noise: { kind: 'gaussian_white', mean: 0.22, std: 0.022, units: '1/ms', independent_per_node: true },
      dt_ms: 0.1220703125,
      monitor_hz: 1024,
      output_fs: 256,
      burn_in_s: draft.burnInS,
      duration_s: draft.durationS,
      seeds: { root: seeds[0] ?? draft.seedStart },
    },
    observations: {
      identity_probe: observation('identity_probe', draft.nNodes),
      eeg_forward: observation('eeg_forward', draft.eegSensors),
    },
  }
}

/** Best-effort inverse of buildRecipe for a stored recipe; null when the recipe is not designer-shaped. */
export function draftFromRecipe(recipe: BenchmarkRecipe | null | undefined): BenchmarkDraft | null {
  if (!recipe?.benchmark || !recipe.simulation || !recipe.observations) return null
  const b = recipe.benchmark
  const seeds = b.seeds ?? []
  const contiguous = seeds.every((seed, index) => seed === (seeds[0] ?? 0) + index)
  const profile = b.profile === 'core-comparison' ? 'core-comparison' : b.profile === 'preview' ? 'preview' : null
  const gOn = b.factors?.G?.[1]
  const eeg = recipe.observations.eeg_forward
  if (!profile || !contiguous || !seeds.length || gOn === undefined || !eeg) return null
  return {
    preset: 'Q1',
    profile,
    nNodes: recipe.simulation.n_nodes,
    gOn,
    seedStart: seeds[0] ?? 0,
    seedCount: seeds.length,
    durationS: recipe.simulation.duration_s,
    burnInS: recipe.simulation.burn_in_s,
    eegSensors: eeg.n_sensors,
    reference: b.held_fixed?.reference ?? 'none',
    sensorNoiseUv: Math.round((b.held_fixed?.sensor_noise_std ?? 0) * 1e6 * 1e6) / 1e6,
    epochS: b.held_fixed?.epoch_s ?? 8,
    metrics: b.metrics.map((metric) => metric.id),
    nBootstrap: b.budget?.n_bootstrap ?? 999,
    nSurrogates: b.budget?.n_surrogates ?? 49,
  }
}

export function sameDraft(a: BenchmarkDraft | null, b: BenchmarkDraft | null): boolean {
  if (!a || !b) return false
  const normal = (draft: BenchmarkDraft) => JSON.stringify(
    Object.entries({ ...draft, metrics: [...draft.metrics].sort() }).sort(([x], [y]) => x.localeCompare(y)),
  )
  return normal(a) === normal(b)
}

// ---------------------------------------------------------------- job state

export const TERMINAL_STATES: readonly JobState[] = ['completed', 'failed', 'cancelled', 'interrupted']

export const isTerminal = (state: JobState) => TERMINAL_STATES.includes(state)

/** API contract: done when the state is terminal and the worker is unknown or has exited. */
export const jobSettled = (job: BenchmarkJob) => isTerminal(job.state) && (!job.worker || !job.worker.alive)

export const jobActive = (job: BenchmarkJob | null | undefined) => !!job && (job.state === 'queued' || job.state === 'running')

// ---------------------------------------------------------------- comparison shaping

/** "band=delta;summary=offdiag_mean" → { feature: "band=delta", edge: null } */
export function splitFeature(raw: string): { feature: string; edge: string | null } {
  const parts = raw.split(';')
  const edgePart = parts.find((part) => part.startsWith('edge='))
  const feature = parts.filter((part) => !part.startsWith('edge=') && !part.startsWith('summary=')).join(';') || 'all'
  return { feature, edge: edgePart ? edgePart.slice(5) : null }
}

export function featureLabel(feature: string): string {
  const [key, value] = feature.split('=')
  if (key === 'band' && value) return value
  if (key === 'tau' && value) return `τ=${value}`
  return feature === 'all' ? '전체' : feature
}

const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value)

export function mean(values: (number | null | undefined)[]): number | null {
  const ok = values.filter(finite)
  return ok.length ? ok.reduce((sum, value) => sum + value, 0) / ok.length : null
}

export interface ConditionFeatureValue {
  mean: number | null
  perSeed: { seed: number; value: number | null }[]
}

/**
 * Per-condition, per-feature off-diagonal means recovered from the seed-paired summary rows:
 * in a contrast A→B, `value_a` is condition A's value for that seed and `value_b` is B's.
 */
export function conditionFeatureValues(comparison: ComparisonEntry | undefined): Map<string, Map<string, ConditionFeatureValue>> {
  const out = new Map<string, Map<string, Map<number, number | null>>>()
  for (const row of comparison?.summary ?? []) {
    if (row.contrast.estimand !== 'paired_mean_difference') continue
    const { feature } = splitFeature(row.contrast.feature)
    for (const [condition, key] of [[row.contrast.condition_a, 'value_a'], [row.contrast.condition_b, 'value_b']] as const) {
      const byFeature = out.get(condition) ?? new Map<string, Map<number, number | null>>()
      const bySeed = byFeature.get(feature) ?? new Map<number, number | null>()
      for (const seedRow of row.per_seed_values) {
        if (!bySeed.has(seedRow.seed) || !finite(bySeed.get(seedRow.seed))) bySeed.set(seedRow.seed, seedRow[key])
      }
      byFeature.set(feature, bySeed)
      out.set(condition, byFeature)
    }
  }
  const result = new Map<string, Map<string, ConditionFeatureValue>>()
  for (const [condition, byFeature] of out) {
    const shaped = new Map<string, ConditionFeatureValue>()
    for (const [feature, bySeed] of byFeature) {
      const perSeed = [...bySeed.entries()].sort((a, b) => a[0] - b[0]).map(([seed, value]) => ({ seed, value }))
      shaped.set(feature, { mean: mean(perSeed.map((item) => item.value)), perSeed })
    }
    result.set(condition, shaped)
  }
  return result
}

export interface NodeMatrix {
  nodes: string[]
  values: (number | null)[][]
}

export interface SourceFeatureMatrices {
  off: NodeMatrix
  on: NodeMatrix
  difference: NodeMatrix
}

/** Source-space node×node matrices (seed mean) rebuilt from the per-edge source contrasts. */
export function sourceMatrices(comparison: ComparisonEntry | undefined): Map<string, SourceFeatureMatrices> {
  const byFeature = new Map<string, PairedEffect[]>()
  for (const edge of comparison?.edges ?? []) {
    const { feature, edge: pair } = splitFeature(edge.contrast.feature)
    if (!pair) continue
    byFeature.set(feature, [...(byFeature.get(feature) ?? []), edge])
  }
  const result = new Map<string, SourceFeatureMatrices>()
  for (const [feature, edges] of byFeature) {
    const nodes = [...new Set(edges.flatMap((edge) => splitFeature(edge.contrast.feature).edge?.split('-') ?? []))].sort()
    const index = new Map(nodes.map((node, i) => [node, i]))
    const empty = () => nodes.map(() => nodes.map((): number | null => null))
    const off = empty()
    const on = empty()
    const difference = empty()
    for (const edge of edges) {
      const [left, right] = splitFeature(edge.contrast.feature).edge?.split('-') ?? []
      const i = index.get(left ?? '')
      const j = index.get(right ?? '')
      if (i === undefined || j === undefined) continue
      const a = mean(edge.per_seed_values.map((row) => row.value_a))
      const b = mean(edge.per_seed_values.map((row) => row.value_b))
      const d = edge.status === 'ok' ? edge.estimate : null
      for (const [r, c] of [[i, j], [j, i]] as const) {
        off[r]![c] = a
        on[r]![c] = b
        difference[r]![c] = d
      }
    }
    result.set(feature, { off: { nodes, values: off }, on: { nodes, values: on }, difference: { nodes, values: difference } })
  }
  return result
}

export function featuresOf(comparisons: ComparisonEntry[]): string[] {
  const labels: string[] = []
  for (const comparison of comparisons) {
    for (const label of comparison.feature_labels ?? []) if (!labels.includes(label)) labels.push(label)
  }
  return labels
}

// ---------------------------------------------------------------- colour scales

export interface ColorRange {
  lo: number
  hi: number
  diverging: boolean
}

function domainBounds(domain: string): [number, number] | null {
  const match = /^\s*[[(]\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*[\])]/.exec(domain)
  return match ? [Number(match[1]), Number(match[2])] : null
}

/**
 * One fixed range per metric (all conditions and bands share it). Signed metrics use a symmetric
 * diverging range. A finite value domain is used when the data stay inside it; the range always
 * covers the data so no value is clipped.
 */
export function metricRange(values: (number | null)[], capability: Pick<MetricCapability, 'signed' | 'value_domain'> | undefined): ColorRange {
  const data = values.filter(finite)
  const dataLo = data.length ? Math.min(...data) : 0
  const dataHi = data.length ? Math.max(...data) : 1
  const bounds = capability ? domainBounds(capability.value_domain) : null
  if (capability?.signed) {
    const extent = Math.max(Math.abs(dataLo), Math.abs(dataHi), bounds ? Math.max(Math.abs(bounds[0]), Math.abs(bounds[1])) : 0) || 1
    return { lo: -extent, hi: extent, diverging: true }
  }
  let lo = bounds ? Math.min(bounds[0], dataLo) : Math.min(0, dataLo)
  let hi = bounds ? Math.max(bounds[1], dataHi) : dataHi
  if (!(hi > lo)) hi = lo + 1
  if (!Number.isFinite(lo)) lo = 0
  return { lo, hi, diverging: false }
}

/** Symmetric diverging range for differences (signed by construction). */
export function differenceRange(values: (number | null)[]): ColorRange {
  const extent = Math.max(0, ...values.filter(finite).map(Math.abs)) || 1
  return { lo: -extent, hi: extent, diverging: true }
}

const mix = (a: number[], b: number[], t: number) => a.map((value, i) => Math.round(value + ((b[i] ?? value) - value) * t))
const WHITE = [248, 248, 244]
const TEAL = [8, 127, 131]
const RUST = [199, 101, 60]
const DEEP = [27, 52, 74]

export function colorFor(value: number | null | undefined, range: ColorRange): string {
  if (!finite(value)) return 'transparent'
  const t = Math.max(0, Math.min(1, (value - range.lo) / (range.hi - range.lo)))
  let rgb: number[]
  if (range.diverging) {
    rgb = t < 0.5 ? mix(RUST, WHITE, t / 0.5) : mix(WHITE, TEAL, (t - 0.5) / 0.5)
  } else {
    rgb = t < 0.6 ? mix(WHITE, TEAL, t / 0.6) : mix(TEAL, DEEP, (t - 0.6) / 0.4)
  }
  return `rgb(${rgb.join(',')})`
}

export function formatValue(value: number | null | undefined, digits = 3): string {
  if (!finite(value)) return '—'
  if (value !== 0 && Math.abs(value) < 10 ** -digits) return value.toExponential(1)
  return value.toFixed(digits)
}

export const formatSigned = (value: number | null | undefined, digits = 3) =>
  finite(value) ? `${value > 0 ? '+' : ''}${formatValue(value, digits)}` : '—'

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`
}

export function formatDuration(seconds: number): string {
  if (seconds >= 3600) return `약 ${(seconds / 3600).toFixed(1)}시간`
  if (seconds >= 60) return `약 ${Math.round(seconds / 60)}분`
  return `약 ${Math.max(1, Math.round(seconds))}초`
}
