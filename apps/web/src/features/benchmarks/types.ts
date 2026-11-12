// JR benchmark contracts as served by apps/api/neurobridge_api/routes/benchmarks.py.
// Field names mirror the API JSON exactly; optional fields are ones the API omits for some entries.

export type MetricDevStatus = 'implemented' | 'planned'
export type ProfileKind = 'preview' | 'core-comparison' | 'full-metrics' | 'sensitivity'
export type ReferenceKind = 'none' | 'average'
export type AnalysisSpace = 'source' | 'sensor'
export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface MetricCapability {
  id: string
  name: string
  family: string
  plan_section: string
  backend_candidate: string
  dependency_group: string
  dependency_modules: string[]
  input_requirements: string
  signed: boolean
  value_domain: string
  status: MetricDevStatus | string
  variants: string[]
  default_variant: string
  dependency_available: boolean
  missing_modules: string[]
}

export interface QuestionPreset {
  id: string
  title: string
  question?: string
  status: MetricDevStatus | string
  primary_metrics: string[]
  secondary_metrics?: string[]
  primary_contrasts?: string[]
  held_fixed?: string[]
  notes?: string[]
  required_length?: Record<string, number>
  observation_gain?: number
  observation_gain_note?: string
}

export interface BenchmarkCapabilities {
  metric_ids: string[]
  metrics: Record<string, MetricCapability>
  dependency_groups: Record<string, boolean>
  presets: QuestionPreset[]
  limits: { max_window_samples: number; max_window_channels: number }
}

export interface BenchmarkCost {
  n_seeds: number
  n_coupling_levels: number
  n_simulations: number
  n_observations: number
  n_epoch_sets: number
  n_metric_tasks: number
  n_tasks: number
  simulated_seconds: number
  estimated_runtime_s: number
  estimated_bytes: number
  basis: string
}

export interface ValidationReport {
  experiment_id: string
  ok: boolean
  errors: string[]
  warnings: string[]
  cost: BenchmarkCost | null
}

export interface JobTasks {
  total: number
  completed: number
  failed: number
  skipped: number
  reused: number
}

export interface JobFailure {
  task_id: string
  reason_code: string | null
  message: string | null
}

export interface WorkerInfo {
  pid: number | null
  alive: boolean
  exitcode: number | null
}

export interface BenchmarkJob {
  schema_version?: string
  job_id: string
  experiment_id: string
  state: JobState
  stage: string | null
  tasks: JobTasks
  completed_artifact_ids: string[]
  failures: JobFailure[]
  cancel_requested: boolean
  created_at: string
  updated_at: string
  worker?: WorkerInfo | null
}

export interface RunHandle {
  experiment_id: string
  job_id: string
  job: BenchmarkJob
  cost: BenchmarkCost
  warnings: string[]
}

export interface MetricSpec {
  id: string
  variant: string
  backend: string | null
  input_spaces: AnalysisSpace[]
  params: Record<string, unknown>
  required: boolean
}

export interface ObservationRecipe {
  schema_version: '1.0'
  kind: 'identity_probe' | 'eeg_forward'
  n_sensors: number
  gain: number
  gain_units: string
  baseline: number
  baseline_units: string
  reference: ReferenceKind
  sensor_noise_std: number
  sensor_noise_units: string
  mixing: null
}

export interface BenchmarkRecipe {
  recipe_version: string
  kind: 'jr-benchmark'
  title: string
  status?: string | null
  notes: string[]
  calibration_seeds: number[]
  conditions: Record<string, { G: number; observation: string }> | null
  benchmark: {
    schema_version: '1.0'
    question_preset: string
    factors: { G: number[]; observation: string[] }
    held_fixed: { reference: ReferenceKind; sensor_noise_std: number; epoch_s: number; preprocessing: string }
    seeds: number[]
    metrics: MetricSpec[]
    profile: ProfileKind
    budget: {
      max_tasks: number | null
      max_runtime_s: number | null
      max_disk_bytes: number | null
      n_surrogates: number
      n_bootstrap: number
    }
  }
  simulation: {
    schema_version: '1.0'
    preset: string
    version: string
    n_nodes: number
    node_params: Record<string, unknown>
    C: number[][]
    D: number[][]
    G: number
    input_noise: { kind: 'gaussian_white'; mean: number; std: number; units: string; independent_per_node: boolean }
    dt_ms: number
    monitor_hz: number
    output_fs: number
    burn_in_s: number
    duration_s: number
    seeds: { root: number }
  }
  observations: Record<string, ObservationRecipe>
}

export interface PlannedCondition {
  label: string
  G: number
  observation: string
  observation_kind: string
  analysis_space: AnalysisSpace
}

export interface MetricResultRow {
  seed: number
  condition: string
  analysis_space: AnalysisSpace
  metric_id: string
  variant: string
  status: string
  reason_code: string | null
  artifact_id: string | null
  n_epochs: number | null
  units: string | null
  validity_flags: string[]
}

export interface PerSeedValue {
  seed: number
  value_a: number | null
  value_b: number | null
  difference: number | null
}

export interface ContrastDefinition {
  metric_id: string
  variant: string
  analysis_space: AnalysisSpace
  condition_a: string
  condition_b: string
  estimand: string
  direction: string
  pairing: string
  feature: string
}

export interface PairedEffect {
  contrast: ContrastDefinition
  status: string
  reason_code: string | null
  independent_n: number
  estimate: number | null
  ci_low: number | null
  ci_high: number | null
  ci_level: number
  null_family: string
  test_family: string
  p_value: number | null
  per_seed_values: PerSeedValue[]
}

export interface ComparisonEntry {
  artifact_id: string
  metric_id: string
  variant: string
  analysis_space: AnalysisSpace
  status?: string
  reason_code?: string | null
  metric_cell_statuses?: Record<string, number>
  seeds?: number[]
  feature_labels?: string[]
  summary?: PairedEffect[]
  edges?: PairedEffect[]
  companions?: PairedEffect[]
  statistics?: Record<string, unknown>
}

export interface ObservationInfo {
  kind: string
  observation_name: string
  analysis_space: AnalysisSpace
  units: string
  reference_label: string
  gain: number
  source_artifact_id: string
  source_checksum: string
}

export interface ExperimentResults {
  experiment_id: string
  preset: string
  profile: string
  seeds: number[]
  coupling_levels: number[]
  conditions: PlannedCondition[]
  gain_source?: Record<string, string>
  cost: BenchmarkCost
  warnings: string[]
  job: BenchmarkJob | null
  metric_results: MetricResultRow[]
  observations: Record<string, ObservationInfo>
  comparisons: ComparisonEntry[]
  evaluation?: unknown[]
  recipe: BenchmarkRecipe
  jobs: BenchmarkJob[]
  artifacts?: unknown[]
}

/** Editable designer state; `buildRecipe` turns it into a BenchmarkRecipe. */
export interface BenchmarkDraft {
  preset: string
  profile: 'preview' | 'core-comparison'
  nNodes: number
  gOn: number
  seedStart: number
  seedCount: number
  durationS: number
  burnInS: number
  eegSensors: number
  reference: ReferenceKind
  sensorNoiseUv: number
  epochS: number
  metrics: string[]
  nBootstrap: number
  nSurrogates: number
}
