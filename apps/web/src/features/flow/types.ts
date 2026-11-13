// Information-flow lab contracts as served by apps/api/neurobridge_api/routes/flow.py.
// Field names mirror the API JSON. Numbers that the pipeline could not compute are null (never 0).

export type FlowJobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type FlowReference = 'none' | 'average'
export type Applicability = 'applicable' | 'conditional' | 'not_applicable'
export type ConceptKind = 'concept' | 'method' | 'level' | 'caveat'

/** MetricStatus values used by the pipeline (ok, not_applicable, invalid_input, failed, ...). */
export type MethodStatus = string

export type Matrix = (number | null)[][]

// ------------------------------------------------------------------ concepts

export interface ConceptEntry {
  id: string
  kind: ConceptKind | string
  short_name: string
  title: string
  question_answered: string
  formula: string | null
  intuition: string
  what_this_simulation_can_show: string
  limitations: string[]
  related_metric_id: string | null
  flow_id: string | null
  level: number | null
  applicability: { status: Applicability | string; reason: string }
  pipeline_methods: string[]
  related_concepts: string[]
  source_section: string
}

export interface ConceptCatalog {
  version: string
  source_document: string
  summary: string
  framework: string[]
  entries: ConceptEntry[]
  method_concepts: Record<string, string>
}

// ------------------------------------------------------------------ recipe

export interface FlowNode { id: string; label: string; role: string }

export interface FlowRecipe {
  recipe_version: '1.0'
  kind: 'flow-pipeline'
  title: string
  profile: 'preview' | 'full'
  status?: string
  notes?: string[]
  graph: {
    nodes: FlowNode[]
    edges: [string, string][]
    weight: number
    delay_ms: number
    normalize_rows: boolean
  }
  simulation: { G: number; control_G: number; duration_s: number; burn_in_s: number; seed: number; output_fs: number }
  observation: { n_sensors: number; references: FlowReference[]; sensor_noise_std: number; gain: number; include_source_native: boolean }
  preprocessing: {
    detrend: boolean
    highpass_hz: number | null
    highpass_order: number
    highpass_phase: 'causal' | 'zero_phase'
    highpass_settle_s: number
    decimate: number
  }
  methods: {
    alpha: number
    gc: { criterion: 'bic' | 'aic'; max_order: number; min_obs_per_param: number; pairwise_order: 'conditional' | 'per_pair'; time_reversed: boolean }
    te: { k_hist: number; l_hist: number; lag: number; ksg: boolean; k_neighbors: number; theiler: number; n_surrogates: number; seed: number }
    effective: { lowpass_hz: number | null; whiteness_lags: number; order?: number | null; max_order?: number }
    activity_flow: { activity: 'envelope' | 'raw'; band: [number, number] | number[]; train_fraction: number; gap_s: number; ridge_alpha: number; neighbor_radius_m: number }
    pid: { lag: number; history: number; teaching_examples: boolean }
  }
  analysis: {
    motifs: Record<string, string[]>
    control_pairs: [string, string][]
    model_comparisons: { name: string; nodes: string[]; driver: string | null }[]
    pid_triplets: { name: string; sources: string[]; target: string }[]
  }
}

// ------------------------------------------------------------------ validation / runs

export interface FlowCost {
  n_conditions: number
  n_datasets: number
  dataset_channels: number[]
  simulated_seconds: number
  analysed_samples_per_dataset: number
  analysis_sfreq: number
  estimated_wall_s: number
  estimate_basis: string
}

export interface FlowValidationReport {
  ok: boolean
  errors: string[]
  warnings: string[]
  cost: FlowCost
  recipe_sha256: string
}

export interface FlowJob {
  job_id: string
  experiment_id: string
  state: FlowJobState
  stage: string | null
  tasks: { total: number; completed: number; failed: number; skipped: number; reused: number }
  failures: { task_id: string; reason_code: string | null; message: string | null }[]
  cancel_requested: boolean
  created_at: string
  updated_at: string
  worker?: { pid: number | null; alive: boolean; exitcode: number | null } | null
}

export interface FlowRunHandle {
  run_id: string
  job_id: string
  job: FlowJob
  cost: FlowCost
  warnings: string[]
}

export interface FlowRunStatus {
  run_id: string
  state: FlowJobState | 'unknown'
  stage: string | null
  job: FlowJob | null
  meta: { run_id: string; title: string; profile: string; recipe_sha256: string; created_at: string; cost: FlowCost } | null
  recipe: FlowRecipe | null
  has_result: boolean
  result: FlowResult | null
}

export interface FlowRunSummary {
  run_id: string
  title: string | null
  profile: string | null
  created_at: string | null
  job_id: string
  state: FlowJobState
  stage: string | null
  has_result: boolean
}

export interface FlowCancelResponse {
  run_id: string
  state: FlowJobState
  cancel_requested: boolean
  active: boolean
  job: FlowJob | null
}

// ------------------------------------------------------------------ result

export interface Significance {
  n_tested: number
  alpha: number
  bonferroni_threshold: number
  n_significant_bonferroni: number
  n_significant_uncorrected: number
}

export interface MethodBase {
  method_id: string
  concept_id: string
  flow_id: string | null
  related_metric_id: string | null
  status: MethodStatus
  reason_code: string | null
  message: string | null
  units?: string
  axes?: string[]
  values?: Matrix
  p_values?: Matrix
  significance?: Significance
  diagnostics?: Record<string, unknown>
  artifact_ref?: string | null
  wall_s?: number
}

export interface GcMethod extends MethodBase {
  order?: number | null
  conditioning?: string
  order_policy?: string
}

export interface TimeReversedMethod extends MethodBase {
  mode?: string
  reading?: string
}

export interface TeGaussianMethod extends MethodBase {
  p_value_method?: string
  parameters?: { k_hist: number; l_hist: number; lag: number }
  gc_te_identity?: { status: string; pair?: string; order?: number; gaussian_te_k_eq_l_eq_order?: number | null; half_pairwise_gc?: number | null; note?: string }
}

export interface KsgPair {
  source_node: string
  target_node: string
  source: number
  target: number
  te: number | null
  p_value: number | null
  null_mean: number | null
}

export interface TeKsgMethod extends MethodBase {
  p_value_method?: string
  pairs?: KsgPair[]
  flags?: string[]
  bias_note?: string
  pair_selection?: string
  parameters?: Record<string, number>
}

export interface ModelEvidence {
  name: string
  status: string
  reason: string | null
  posterior: number | null
  bic: number | null
  aic: number | null
  log_likelihood: number | null
  n_params: number | null
  shared_noise: boolean
}

export interface ModelComparison {
  name: string
  nodes: string[]
  driver_node: string | null
  channels: number[]
  driver_channel: number | null
  hypothesis_labels: Record<string, string>
  var_order?: number | null
  var_order_selection?: Record<string, unknown>
  status: string
  reason_code: string | null
  message: string | null
  best_model: string | null
  question?: string
  models: ModelEvidence[]
}

export interface EffectiveMethod extends MethodBase {
  comparisons?: ModelComparison[]
  flags?: string[]
  misspecified_comparisons?: string[]
  method_note?: string
  stable?: boolean
  conversion?: string
}

export interface PredictionSummary {
  mean_r: number | null
  mean_r2: number | null
  r: (number | null)[]
  r2: (number | null)[]
  channel_status: string[]
}

export interface ActivityFlowMethod extends MethodBase {
  activity?: string
  band?: number[]
  neighbor_exclusion?: { radius_m: number } | null
  summary?: {
    best_method: string
    comparison: Record<string, { mean_r: number | null; mean_r2: number | null }>
    predictions: Record<string, PredictionSummary>
    train_samples: number[]
    test_samples: number[]
    gap_samples: number
    example_channel: number
    example_actual: (number | null)[]
    example_predicted: Record<string, (number | null)[]>
    n_excluded_predictors: number
  }
  without_neighbor_exclusion?: { comparison: Record<string, { mean_r: number | null; mean_r2: number | null }>; best_method: string }
  primary_score?: string
  score_note?: string
  method_note?: string
}

export interface PidValues {
  units: string
  i_s1_t: number | null
  i_s2_t: number | null
  i_s12_t: number | null
  redundancy: number | null
  unique_s1: number | null
  unique_s2: number | null
  synergy: number | null
  co_information?: number | null
  interaction_information?: number | null
}

export interface PidTriplet {
  name: string
  source_nodes: string[]
  target_node: string
  channels?: { source_a: number; source_b: number; target: number }
  status: string
  reason_code: string | null
  message: string | null
  measure: string
  estimator?: string
  nats?: PidValues
  bits?: PidValues
  notes?: string[]
}

export interface PidMethod extends MethodBase {
  measure?: string
  triplets?: PidTriplet[]
}

export interface FlowMethods {
  gc_conditional: GcMethod
  gc_pairwise: GcMethod
  gc_time_reversed: TimeReversedMethod
  te_gaussian: TeGaussianMethod
  te_ksg: TeKsgMethod
  effective_model: EffectiveMethod
  activity_flow: ActivityFlowMethod
  pid: PidMethod
  level2_content_decoding: MethodBase
}

export interface FlowDataset {
  dataset_id: string
  space: 'source' | 'sensor'
  condition: 'coupled' | 'control' | string
  G: number
  observation: string
  reference: string
  reference_label: string
  units: string
  channel_names: string[]
  node_channels: Record<string, number>
  sfreq: number
  n_samples: number
  wall_s?: number
  methods: Partial<FlowMethods> & Record<string, MethodBase>
}

export interface PidTeachingExample {
  description: string
  status: string
  reason_code: string | null
  message: string | null
  measure: string
  bits?: PidValues
  notes?: string[]
}

export interface EdgeDirectionScore { edge: string; forward: number | null; backward: number | null; correct: boolean | null }

export interface SourceScore {
  label: string
  score: string
  edge_auc?: { status: string; auc?: number | null; n_edges_scored?: number; n_non_edges_scored?: number; reason_code?: string; structural_auc?: number | null; note?: string } | null
  direction?: { status: string; accuracy: number | null; n_edges: number; edges: EdgeDirectionScore[] } | null
  significance?: { correction: string; threshold: number; n_tested: number; true_positives: number; false_positives: number; n_edges_tested: number; n_non_edges_tested: number } | null
}

export interface SourceEvaluation {
  dataset_id: string
  condition: string
  G: number
  n_active_edges: number
  scores: Record<string, SourceScore>
  model_comparisons?: { name: string; expected_model: string; best_model: string | null; match: boolean | null; posterior_of_expected: number | null; status: string; residuals_not_white?: boolean }[]
  pid?: { name: string; status: string; target_receives_from: Record<string, boolean>; redundancy: number | null; unique_a: number | null; unique_b: number | null; synergy: number | null; joint_mi: number | null }[]
  activity_flow?: Record<string, { mean_r: number | null; mean_r2: number | null }>
  fork_spurious?: SpuriousCheck[]
  chain_indirect?: SpuriousCheck[]
}

/** Pairwise vs conditional GC on node pairs with no direct edge (fork siblings, chain ends). */
export interface SpuriousCheck {
  kind: string
  driver?: string
  via?: string
  pair: string[]
  spurious_detected_pairwise: boolean | null
  spurious_detected_conditional: boolean | null
  conditional_weaker_both_directions: boolean | null
}

export interface SensorEvaluation {
  dataset_id: string
  condition: string
  G: number
  reference: string
  truth_scoring: string
  gc_pairwise?: { status: string; mean_offdiag?: number | null; max_offdiag?: number | null; n_significant_bonferroni?: number; fraction_significant_bonferroni?: number | null }
  gc_conditional?: { status: string; mean_offdiag?: number | null; max_offdiag?: number | null; n_significant_bonferroni?: number; fraction_significant_bonferroni?: number | null }
  te_gaussian?: { status: string; mean_offdiag?: number | null; max_offdiag?: number | null; n_significant_bonferroni?: number; fraction_significant_bonferroni?: number | null }
  gc_time_reversed?: { status: string; mean_net?: number | null; fraction_net_positive?: number | null }
}

export interface FlowResult {
  schema_version: string
  kind: 'flow-pipeline-result' | string
  run_id: string
  title: string
  profile: string
  recipe_sha256: string
  recipe: FlowRecipe
  truth_isolation: { frozen_analysis_sha256: string; evaluation_space?: string; analysis_inputs?: string }
  display_channels: { mapping: Record<string, { channel_index: number; channel: string; distance_m: number }>; has_duplicate_channels: boolean; note: string } | null
  datasets: FlowDataset[]
  pid_teaching: { discrete_williams_beer: Record<string, PidTeachingExample> } | null
  simulation: { node_names: string[]; fs: number; conditions: Record<string, { G: number; psd_peak_hz?: (number | null)[] }> }
  preprocessing: { steps: string[]; sfreq_out: number }
  evaluation: {
    truth_scope: string
    alpha: number
    true_edges: string[]
    source: SourceEvaluation[]
    sensor: SensorEvaluation[]
    lessons: string[]
  } | null
  timings_s?: Record<string, number>
}
