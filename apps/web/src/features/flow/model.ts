import { colorFor, formatValue, type ColorRange } from '../benchmarks/model'
import type { FlowDataset, FlowJob, FlowJobState, FlowRecipe, FlowReference, FlowResult, Matrix } from './types'

export { colorFor, formatValue, type ColorRange }

// ------------------------------------------------------------------ recipe draft

/**
 * The analysis plan and the known graph come from fixtures/recipes/flow-preview.json. The web draft
 * only changes simulation/observation knobs; graph.edges are generation truth and analysis.* never
 * carry edge directions.
 */
export const BASE_RECIPE: FlowRecipe = {
  recipe_version: '1.0',
  kind: 'flow-pipeline',
  title: 'Information flow lab · web',
  profile: 'preview',
  status: 'unvalidated_starting_values',
  notes: [
    'Web lab recipe derived from fixtures/recipes/flow-preview.json (shorter duration, max GC order 8).',
    'graph.edges are generation truth; they are used only by the simulation and the source-space evaluation.',
  ],
  graph: {
    nodes: [
      { id: 'P1', label: 'pair source', role: 'pair' },
      { id: 'P2', label: 'pair target', role: 'pair' },
      { id: 'A', label: 'chain start', role: 'chain' },
      { id: 'B', label: 'chain middle', role: 'chain' },
      { id: 'C', label: 'chain end / fork driver', role: 'chain+fork' },
      { id: 'D', label: 'fork branch', role: 'fork' },
      { id: 'E', label: 'fork branch', role: 'fork' },
      { id: 'F', label: 'convergence target', role: 'convergence' },
    ],
    edges: [['P1', 'P2'], ['A', 'B'], ['B', 'C'], ['C', 'D'], ['C', 'E'], ['P1', 'F'], ['A', 'F']],
    weight: 1.0,
    delay_ms: 8.0,
    normalize_rows: true,
  },
  simulation: { G: 10, control_G: 0, duration_s: 30, burn_in_s: 2, seed: 7, output_fs: 256 },
  observation: { n_sensors: 32, references: ['none'], sensor_noise_std: 25.0, gain: 1.0, include_source_native: true },
  preprocessing: { detrend: true, highpass_hz: 0.5, highpass_order: 2, highpass_phase: 'causal', highpass_settle_s: 2.0, decimate: 2 },
  methods: {
    alpha: 0.05,
    gc: { criterion: 'bic', max_order: 8, min_obs_per_param: 10, pairwise_order: 'conditional', time_reversed: true },
    te: { k_hist: 2, l_hist: 2, lag: 1, ksg: true, k_neighbors: 4, theiler: 0, n_surrogates: 0, seed: 0 },
    effective: { lowpass_hz: null, whiteness_lags: 20 },
    activity_flow: { activity: 'envelope', band: [5, 13], train_fraction: 0.6, gap_s: 1, ridge_alpha: 1, neighbor_radius_m: 0.05 },
    pid: { lag: 1, history: 2, teaching_examples: true },
  },
  analysis: {
    motifs: { pair: ['P1', 'P2'], chain: ['A', 'B', 'C'], fork: ['C', 'D', 'E'], convergence: ['P1', 'A', 'F'] },
    control_pairs: [['P2', 'D'], ['F', 'E']],
    model_comparisons: [
      { name: 'pair_P1_P2', nodes: ['P1', 'P2'], driver: null },
      { name: 'chain_A_B', nodes: ['A', 'B'], driver: null },
      { name: 'fork_D_E', nodes: ['D', 'E'], driver: 'C' },
      { name: 'convergence_P1_F', nodes: ['P1', 'F'], driver: null },
    ],
    pid_triplets: [
      { name: 'convergence_F', sources: ['P1', 'A'], target: 'F' },
      { name: 'fork_D', sources: ['C', 'E'], target: 'D' },
    ],
  },
}

export type ReferenceChoice = FlowReference | 'both'

export interface FlowDraft {
  G: number
  durationS: number
  nSensors: number
  reference: ReferenceChoice
  includeSource: boolean
  highpassPhase: 'causal' | 'zero_phase'
  seed: number
}

export const defaultFlowDraft = (): FlowDraft => ({
  G: 10, durationS: 30, nSensors: 32, reference: 'none', includeSource: true, highpassPhase: 'causal', seed: 7,
})

export function buildFlowRecipe(draft: FlowDraft): FlowRecipe {
  const recipe = structuredClone(BASE_RECIPE)
  recipe.simulation = { ...recipe.simulation, G: draft.G, duration_s: draft.durationS, seed: draft.seed }
  recipe.observation = {
    ...recipe.observation,
    n_sensors: draft.nSensors,
    references: draft.reference === 'both' ? ['none', 'average'] : [draft.reference],
    include_source_native: draft.includeSource,
  }
  recipe.preprocessing = { ...recipe.preprocessing, highpass_phase: draft.highpassPhase }
  return recipe
}

export function draftFromRecipe(recipe: FlowRecipe | null | undefined): FlowDraft | null {
  if (!recipe?.simulation || !recipe.observation) return null
  const refs = recipe.observation.references ?? ['none']
  return {
    G: recipe.simulation.G,
    durationS: recipe.simulation.duration_s,
    nSensors: recipe.observation.n_sensors,
    reference: refs.length > 1 ? 'both' : refs[0] ?? 'none',
    includeSource: recipe.observation.include_source_native,
    highpassPhase: recipe.preprocessing?.highpass_phase ?? 'causal',
    seed: recipe.simulation.seed,
  }
}

export const sameDraft = (a: FlowDraft | null, b: FlowDraft | null) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b)

// ------------------------------------------------------------------ job state

export const TERMINAL_STATES: readonly FlowJobState[] = ['completed', 'failed', 'cancelled', 'interrupted']
export const isTerminal = (state: string) => (TERMINAL_STATES as readonly string[]).includes(state)
/** Terminal and the worker process has exited (or is unknown to this server). */
export const jobSettled = (job: FlowJob) => isTerminal(job.state) && (!job.worker || !job.worker.alive)
export const jobActive = (job: FlowJob | null | undefined) => !!job && (job.state === 'queued' || job.state === 'running')

/** Dataset ids in the order the pipeline analyses them (conditions outer, views inner). */
export function expectedDatasetIds(recipe: FlowRecipe | null | undefined): string[] {
  if (!recipe) return []
  const views = [
    ...(recipe.observation.include_source_native ? ['source'] : []),
    ...recipe.observation.references.map((ref) => `sensor-${ref}`),
  ]
  return ['coupled', 'control'].flatMap((condition) => views.map((view) => `${view}/${condition}`))
}

export interface StageProgress { label: string; fraction: number }

/** Map the pipeline's real stage string to a Korean label and an approximate completed fraction. */
export function stageProgress(stage: string | null, state: string, recipe: FlowRecipe | null | undefined): StageProgress {
  if (state === 'completed') return { label: '완료', fraction: 1 }
  if (!stage || stage === 'queued') return { label: '대기 중 · worker 시작 (약 5초)', fraction: 0.02 }
  if (stage.startsWith('simulate')) return { label: 'JR 소스 시뮬레이션 · 결합 + G=0 대조', fraction: 0.08 }
  const analyse = /^analyse (\S+) \((\d+) channels\)/.exec(stage)
  if (analyse) {
    const ids = expectedDatasetIds(recipe)
    const index = ids.indexOf(analyse[1] ?? '')
    const total = Math.max(ids.length, 1)
    const fraction = index >= 0 ? 0.45 + (0.5 * index) / total : 0.5
    return { label: `분석 ${index >= 0 ? `${index + 1}/${total}` : ''} · ${datasetLabel(analyse[1] ?? '')} (${analyse[2]}채널)`, fraction }
  }
  if (stage.startsWith('evaluate')) return { label: '평가 · 정답은 소스 공간에서만 사용', fraction: 0.96 }
  if (stage === 'done') return { label: '저장 완료', fraction: 1 }
  return { label: stage, fraction: 0.5 }
}

// ------------------------------------------------------------------ datasets

export const SPACE_LABELS: Record<string, string> = {
  source: '소스 (JR 노드)',
  'sensor-none': '센서 · reference 없음',
  'sensor-average': '센서 · 평균 reference',
}

export const CONDITION_LABELS: Record<string, string> = { coupled: '결합 켬', control: '결합 끔 (G=0 대조)' }

export function datasetLabel(datasetId: string): string {
  const [space = '', condition = ''] = datasetId.split('/')
  return `${SPACE_LABELS[space] ?? space} · ${CONDITION_LABELS[condition] ?? condition}`
}

export const spaceKey = (dataset: FlowDataset) => dataset.dataset_id.split('/')[0] ?? dataset.space

export function spacesOf(result: FlowResult): string[] {
  const spaces: string[] = []
  for (const dataset of result.datasets) {
    const key = spaceKey(dataset)
    if (!spaces.includes(key)) spaces.push(key)
  }
  return spaces
}

export const findDataset = (result: FlowResult, space: string, condition: string) =>
  result.datasets.find((dataset) => dataset.dataset_id === `${space}/${condition}`) ?? null

/** Axis labels: source channels are named by their JR node; sensor channels keep electrode names. */
export function channelLabels(dataset: FlowDataset): string[] {
  if (dataset.space !== 'source') return dataset.channel_names
  const labels = [...dataset.channel_names]
  for (const [node, index] of Object.entries(dataset.node_channels)) labels[index] = node
  return labels
}

/**
 * Active truth edges as `${targetIndex}:${sourceIndex}` cells — source space only (sensor channels are
 * not sources) and only when G > 0 (at G = 0 the structural edges carry no coupling).
 */
export function truthCells(dataset: FlowDataset, edges: [string, string][]): Set<string> {
  const cells = new Set<string>()
  if (dataset.space !== 'source' || !(dataset.G > 0)) return cells
  for (const [source, target] of edges) {
    const s = dataset.node_channels[source]
    const t = dataset.node_channels[target]
    if (s !== undefined && t !== undefined) cells.add(`${t}:${s}`)
  }
  return cells
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function offDiagonal(matrix: Matrix | undefined): number[] {
  if (!matrix) return []
  return matrix.flatMap((row, i) => row.filter((value, j) => i !== j && isFiniteNumber(value)) as number[])
}

/** Colour range that always covers the data (nothing clipped); signed data get a symmetric diverging range. */
export function valueRange(values: number[], signed: boolean): ColorRange {
  if (signed) {
    const extent = Math.max(0, ...values.map((value) => Math.abs(value))) || 1
    return { lo: -extent, hi: extent, diverging: true }
  }
  const lo = Math.min(0, ...values)
  const hi = values.length ? Math.max(...values) : 1
  return { lo, hi: hi > lo ? hi : lo + 1, diverging: false }
}

export const matrixRange = (matrix: Matrix | undefined, signed: boolean): ColorRange => valueRange(offDiagonal(matrix), signed)

export interface NetFlow {
  from: string
  to: string
  forward: number
  backward: number
  net: number
  significant: boolean
}

/**
 * Net directed flow between every node pair of a source-space dataset: values are [target][source],
 * so a→b is values[b][a]. Only the dominant direction is reported; `significant` uses the
 * Bonferroni threshold on that direction's p value.
 */
export function netFlows(dataset: FlowDataset, values: Matrix | undefined, pValues: Matrix | undefined, threshold: number | null): NetFlow[] {
  if (!values) return []
  const nodes = Object.entries(dataset.node_channels)
  const flows: NetFlow[] = []
  for (let a = 0; a < nodes.length; a += 1) {
    for (let b = a + 1; b < nodes.length; b += 1) {
      const [nameA, ia] = nodes[a]!
      const [nameB, ib] = nodes[b]!
      if (ia === ib) continue
      const ab = values[ib]?.[ia]
      const ba = values[ia]?.[ib]
      if (!isFiniteNumber(ab) || !isFiniteNumber(ba)) continue
      const forwardWins = ab >= ba
      const p = forwardWins ? pValues?.[ib]?.[ia] : pValues?.[ia]?.[ib]
      flows.push({
        from: forwardWins ? nameA : nameB,
        to: forwardWins ? nameB : nameA,
        forward: forwardWins ? ab : ba,
        backward: forwardWins ? ba : ab,
        net: Math.abs(ab - ba),
        significant: threshold !== null && isFiniteNumber(p) && p <= threshold,
      })
    }
  }
  return flows.sort((x, y) => y.net - x.net)
}

/** Fraction of tested ordered pairs significant after Bonferroni, or null when not computed. */
export function significantFraction(method: { status: string; significance?: { n_tested: number; n_significant_bonferroni: number } } | undefined): number | null {
  if (!method || method.status !== 'ok' || !method.significance || method.significance.n_tested <= 0) return null
  return method.significance.n_significant_bonferroni / method.significance.n_tested
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  return isFiniteNumber(value) ? `${(value * 100).toFixed(digits)}%` : '—'
}

export function formatProbability(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return '—'
  if (value !== 0 && value < 1e-3) return value.toExponential(1)
  return value.toFixed(3)
}

export function formatSeconds(seconds: number | null | undefined): string {
  if (!isFiniteNumber(seconds)) return '—'
  if (seconds >= 60) return `약 ${Math.round(seconds / 60)}분`
  return `약 ${Math.max(1, Math.round(seconds))}초`
}

// ------------------------------------------------------------------ formula rendering

const LATEX_SYMBOLS: [RegExp, string][] = [
  [/\\left(?![a-z])|\\right(?![a-z])/g, ''],
  [/\s*\\(?:quad|qquad)\s*/g, '\u2003'],
  [/\\[;:]/g, ' '],
  [/\\[,!]/g, ''],
  [/\\not\s*\\perp\s*/g, '⊥\u0338'],
  [/\\perp\s*/g, '⊥'],
  [/\\top\b/g, '⊤'],
  [/\\Delta\b\s*/g, 'Δ'],
  [/\s*\\Rightarrow\s*/g, ' ⇒ '],
  [/\\rightarrow\s*|\\to\b\s*/g, '→'],
  [/\\leftarrow\s*/g, '←'],
  [/\\sum\s*/g, 'Σ'],
  [/\\neq?\b\s*/g, '≠'],
  [/\\geq?\b\s*/g, '≥'],
  [/\\leq?\b\s*/g, '≤'],
  [/\s*\\approx\s*/g, ' ≈ '],
  [/\\propto\s*/g, '∝'],
  [/\s*\\mid\s*/g, ' | '],
  [/\\cdot\s*/g, '·'],
  [/\\times\s*/g, '×'],
  [/\\(?:var)?epsilon\b\s*/g, 'ε'],
  [/\\tau\b\s*/g, 'τ'],
  [/\\alpha\b\s*/g, 'α'],
  [/\\infty\b\s*/g, '∞'],
  [/\\in\b\s*/g, '∈'],
  [/\\\{/g, '{'],
  [/\\\}/g, '}'],
  [/\\(ln|log|min|max|exp|var)\b/g, '$1'],
  // Anything not covered above: drop the backslash so the command name stays readable.
  [/\\([A-Za-z]+)/g, '$1'],
]

/** Replace a `\cmd{...}` group (balanced braces) by `render(inner)`. */
function replaceGroup(input: string, command: string, render: (inner: string) => string): string {
  let output = input
  for (let guard = 0; guard < 50; guard += 1) {
    const start = output.indexOf(`\\${command}{`)
    if (start < 0) break
    let depth = 0
    let end = -1
    for (let i = start + command.length + 1; i < output.length; i += 1) {
      if (output[i] === '{') depth += 1
      else if (output[i] === '}') { depth -= 1; if (depth === 0) { end = i; break } }
    }
    if (end < 0) break
    const inner = output.slice(start + command.length + 2, end)
    output = output.slice(0, start) + render(inner) + output.slice(end + 1)
  }
  return output
}

function takeGroup(input: string, from: number): [string, number] | null {
  if (input[from] !== '{') return null
  let depth = 0
  for (let i = from; i < input.length; i += 1) {
    if (input[i] === '{') depth += 1
    else if (input[i] === '}') { depth -= 1; if (depth === 0) return [input.slice(from + 1, i), i + 1] }
  }
  return null
}

/**
 * Readable plain-text form of the catalog's LaTeX (KaTeX is not a dependency). Sub/superscripts stay
 * as `_{…}` / `^{…}` so a renderer can turn them into <sub>/<sup>.
 */
export function simplifyLatex(latex: string): string {
  let text = latex
  for (const command of ['operatorname', 'mathrm', 'text', 'mathbf', 'mathit', 'boldsymbol']) {
    text = replaceGroup(text, command, (inner) => inner)
  }
  text = text.replace(/\\mathbf\s+([A-Za-z0-9])/g, '$1')
  text = replaceGroup(text, 'dot', (inner) => `${inner}\u0307`)
  text = replaceGroup(text, 'hat', (inner) => `${inner}\u0302`)
  text = text.replace(/\\dot\s*([A-Za-z])/g, '$1\u0307').replace(/\\hat\s*([A-Za-z])/g, '$1\u0302')
  text = text.replace(/\\[dt]frac\{/g, '\\frac{')
  for (let guard = 0; guard < 20 && text.includes('\\frac{'); guard += 1) {
    const start = text.indexOf('\\frac{')
    const num = takeGroup(text, start + 5)
    const den = num ? takeGroup(text, num[1]) : null
    if (!num || !den) break
    const wrap = (part: string) => (/^[\w.]+$/.test(part) ? part : `(${part})`)
    text = `${text.slice(0, start)}${wrap(num[0])}/${wrap(den[0])} ${text.slice(den[1])}`
  }
  for (const [pattern, replacement] of LATEX_SYMBOLS) text = text.replace(pattern, replacement)
  return text.replace(/[ \t]{2,}/g, ' ').replace(/ \)/g, ')').trim()
}

export interface FormulaPart { kind: 'text' | 'sub' | 'sup'; text: string }

/** Split simplified formula text into plain, subscript and superscript runs (one level deep). */
export function formulaParts(latex: string): FormulaPart[] {
  const text = simplifyLatex(latex)
  const parts: FormulaPart[] = []
  let buffer = ''
  const flush = () => { if (buffer) { parts.push({ kind: 'text', text: buffer }); buffer = '' } }
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!
    if ((char === '_' || char === '^') && i + 1 < text.length) {
      const group = takeGroup(text, i + 1)
      const content = group ? group[0] : text[i + 1]!
      flush()
      parts.push({ kind: char === '_' ? 'sub' : 'sup', text: content.replace(/[{}]/g, '') })
      i = group ? group[1] - 1 : i + 1
      continue
    }
    buffer += char
  }
  flush()
  return parts
}

// ------------------------------------------------------------------ graph layout

/** Hand-placed layout for the bundled 8-node graph (pair, chain, fork, convergence). */
const FIXED_LAYOUT: Record<string, [number, number]> = {
  P1: [44, 44], P2: [44, 156], F: [120, 100], A: [196, 44], B: [268, 44], C: [306, 112], D: [246, 168], E: [330, 176],
}

export function graphLayout(nodes: string[], width = 360, height = 210): Record<string, [number, number]> {
  if (nodes.every((node) => FIXED_LAYOUT[node])) {
    return Object.fromEntries(nodes.map((node) => [node, FIXED_LAYOUT[node]!]))
  }
  const radius = Math.min(width, height) / 2 - 28
  return Object.fromEntries(nodes.map((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2
    return [node, [width / 2 + radius * Math.cos(angle), height / 2 + radius * Math.sin(angle)]]
  }))
}
