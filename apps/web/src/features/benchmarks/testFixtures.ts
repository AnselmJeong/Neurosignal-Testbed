// Test-only fixtures shaped like the real /benchmarks responses (see p4-api-examples.json).
import type { BenchmarkCapabilities, BenchmarkJob, ComparisonEntry, ExperimentResults, MetricCapability, PairedEffect } from './types'
import { buildRecipe, defaultDraft } from './model'

const IDS = ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M11', 'M12', 'M13', 'M14', 'M15', 'M16', 'M17', 'M18', 'M19', 'M20',
  'M21', 'M22', 'M23', 'M24', 'M25', 'M26', 'M27', 'M28', 'M29', 'M30', 'M31', 'M32', 'M33']
const IMPLEMENTED = new Set(['M11', 'M12', 'M13', 'M14', 'M15', 'M16', 'M17', 'M18', 'M19', 'M20', 'M22', 'M23'])
const NAMES: Record<string, string> = { M11: 'Pearson correlation', M14: 'PLV', M17: 'wPLI', M23: 'wSMI', M21: 'Continuous mutual information' }
const SIGNED = new Set(['M05', 'M06', 'M11', 'M13', 'M15', 'M18', 'M19', 'M20', 'M31'])

function metric(id: string): MetricCapability {
  const information = id === 'M21' || id === 'M28'
  return {
    id,
    name: NAMES[id] ?? `Metric ${id}`,
    family: id === 'M23' ? 'information' : 'phase',
    plan_section: '3.2',
    backend_candidate: 'test',
    dependency_group: information ? 'information' : 'core',
    dependency_modules: [],
    input_requirements: `${id} input requirements`,
    signed: SIGNED.has(id),
    value_domain: SIGNED.has(id) ? '[-1, 1]' : '[0, 1]',
    status: IMPLEMENTED.has(id) ? 'implemented' : 'planned',
    variants: ['default'],
    default_variant: 'default',
    dependency_available: !information,
    missing_modules: information ? ['idtxl'] : [],
  }
}

export const capabilitiesFixture: BenchmarkCapabilities = {
  metric_ids: IDS,
  metrics: Object.fromEntries(IDS.map((id) => [id, metric(id)])),
  dependency_groups: { core: true, simulation: true, metrics: true, pac: true, information: false },
  presets: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'].map((id) => ({
    id,
    title: `${id} · title`,
    status: id === 'Q1' ? 'implemented' : 'planned',
    primary_metrics: id === 'Q1' ? ['M14', 'M17', 'M23'] : [],
    required_length: { epoch_s: 8, min_duration_s: 40, recommended_duration_s: 120, min_seeds_for_ci: 2 },
  })),
  limits: { max_window_samples: 16384, max_window_channels: 64 },
}

export function jobFixture(overrides: Partial<BenchmarkJob> = {}): BenchmarkJob {
  return {
    schema_version: '1.0',
    job_id: 'job-0000000000000000000000000000abcd',
    experiment_id: 'jr-new0000000000000',
    state: 'running',
    stage: 'simulate',
    tasks: { total: 85, completed: 0, failed: 0, skipped: 0, reused: 0 },
    completed_artifact_ids: [],
    failures: [],
    cancel_requested: false,
    created_at: '2026-11-12T14:42:25Z',
    updated_at: '2026-11-12T14:42:25Z',
    worker: { pid: 11869, alive: true, exitcode: null },
    ...overrides,
  }
}

const SEEDS = [100, 101]
const BANDS = ['band=delta', 'band=theta']

function effect(metricId: string, space: 'sensor' | 'source', a: string, b: string, feature: string, va: number[], vb: number[], estimand = 'paired_mean_difference'): PairedEffect {
  const diffs = va.map((value, i) => (vb[i] ?? 0) - value)
  const estimate = diffs.reduce((s, v) => s + v, 0) / diffs.length
  return {
    contrast: { metric_id: metricId, variant: 'default', analysis_space: space, condition_a: a, condition_b: b, estimand, direction: 'b_minus_a', pairing: 'seed_paired', feature },
    status: 'ok', reason_code: null, independent_n: SEEDS.length, estimate,
    ci_low: Math.min(...diffs), ci_high: Math.max(...diffs), ci_level: 0.95,
    null_family: 'seed_sign_flip_exact(B=3)', test_family: `${space}:${metricId}:default`, p_value: 0.5,
    per_seed_values: SEEDS.map((seed, i) => ({ seed, value_a: va[i] ?? null, value_b: vb[i] ?? null, difference: diffs[i] ?? null })),
  }
}

/** Per-condition seed values; `scale` shifts one experiment's numbers so tests can tell two apart. */
function sensorComparison(metricId: string, scale: number): ComparisonEntry {
  const v: Record<string, number[]> = { A: [0.40, 0.41], B: [0.47, 0.40], C: [0.70, 0.72], D: [0.74, 0.73] }
  const s = (key: string, band: number) => (v[key] ?? []).map((x) => +(x * scale + band * 0.05).toFixed(4))
  const summary: PairedEffect[] = []
  BANDS.forEach((band, bi) => {
    const f = `${band};summary=offdiag_mean`
    summary.push(effect(metricId, 'sensor', 'A', 'B', f, s('A', bi), s('B', bi)))
    summary.push(effect(metricId, 'sensor', 'C', 'D', f, s('C', bi), s('D', bi)))
    summary.push(effect(metricId, 'sensor', 'A', 'C', f, s('A', bi), s('C', bi)))
    summary.push(effect(metricId, 'sensor', 'B', 'D', f, s('B', bi), s('D', bi)))
    const ba = s('B', bi).map((x, i) => x - (s('A', bi)[i] ?? 0))
    const dc = s('D', bi).map((x, i) => x - (s('C', bi)[i] ?? 0))
    summary.push(effect(metricId, 'sensor', 'B-A', 'D-C', f, ba, dc, 'paired_difference_of_differences'))
  })
  return {
    artifact_id: `compare-sensor-${metricId}-${scale}`, metric_id: metricId, variant: 'default', analysis_space: 'sensor',
    seeds: SEEDS, feature_labels: BANDS, summary, edges: [],
    companions: [effect('welch_peak_hz', 'sensor', 'A', 'B', 'channel_mean', [7.0, 7.1], [10.3, 10.4])],
    statistics: { unit: 'simulation seed', ci: 'percentile bootstrap over seeds (B=199), level 0.95', p_value: '(b+1)/(B+1)' },
  }
}

function sourceComparison(metricId: string, scale: number): ComparisonEntry {
  const nodes = ['n00', 'n01', 'n02']
  const edges: PairedEffect[] = []
  BANDS.forEach((band) => {
    for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
      edges.push(effect(metricId, 'source', 'source_off', 'source_on', `${band};edge=${nodes[i]}-${nodes[j]}`, [0.3 * scale, 0.32 * scale], [0.6 * scale, 0.58 * scale]))
    }
  })
  return {
    artifact_id: `compare-source-${metricId}-${scale}`, metric_id: metricId, variant: 'default', analysis_space: 'source',
    seeds: SEEDS, feature_labels: BANDS,
    summary: BANDS.map((band) => effect(metricId, 'source', 'source_off', 'source_on', `${band};summary=offdiag_mean`, [0.3 * scale, 0.32 * scale], [0.6 * scale, 0.58 * scale])),
    edges, companions: [], statistics: {},
  }
}

export function resultsFixture(experimentId: string, scale = 1, metricIds = ['M14', 'M17']): ExperimentResults {
  const recipe = buildRecipe({ ...defaultDraft(), seedCount: 2, metrics: metricIds })
  const conditions = [
    { label: 'A', G: 0, observation: 'identity_probe', observation_kind: 'identity_probe', analysis_space: 'sensor' as const },
    { label: 'B', G: 10, observation: 'identity_probe', observation_kind: 'identity_probe', analysis_space: 'sensor' as const },
    { label: 'C', G: 0, observation: 'eeg_forward', observation_kind: 'eeg_forward', analysis_space: 'sensor' as const },
    { label: 'D', G: 10, observation: 'eeg_forward', observation_kind: 'eeg_forward', analysis_space: 'sensor' as const },
    { label: 'source_off', G: 0, observation: 'source_native', observation_kind: 'source_native', analysis_space: 'source' as const },
    { label: 'source_on', G: 10, observation: 'source_native', observation_kind: 'source_native', analysis_space: 'source' as const },
  ]
  return {
    experiment_id: experimentId,
    preset: 'Q1',
    profile: 'preview',
    seeds: SEEDS,
    coupling_levels: [0, 10],
    conditions,
    cost: { n_seeds: 2, n_coupling_levels: 2, n_simulations: 4, n_observations: 12, n_epoch_sets: 12, n_metric_tasks: 36, n_tasks: 85, simulated_seconds: 169, estimated_runtime_s: 128.9, estimated_bytes: 17315840, basis: 'pilot estimate' },
    warnings: [],
    job: jobFixture({ experiment_id: experimentId, state: 'completed', stage: 'evaluate', tasks: { total: 85, completed: 84, failed: 0, skipped: 0, reused: 1 }, worker: null }),
    metric_results: conditions.flatMap((c) => metricIds.flatMap((m) => SEEDS.map((seed) => ({
      seed, condition: c.label, analysis_space: c.analysis_space, metric_id: m, variant: 'default', status: 'ok', reason_code: null,
      artifact_id: `metric-${c.label}-${m}-${seed}`, n_epochs: 5, units: 'dimensionless', validity_flags: [],
    })))),
    observations: {},
    comparisons: metricIds.flatMap((m) => [sensorComparison(m, scale), sourceComparison(m, scale)]),
    recipe,
    jobs: [],
  }
}
