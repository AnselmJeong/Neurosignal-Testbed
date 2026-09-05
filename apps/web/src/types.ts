export type Severity = 'info' | 'warning' | 'error'

export interface SourceSpec {
  id: string
  label: string
  frequency_hz: number
  amplitude_uv: number
  phase_deg: number
  kind: 'sine' | 'blink'
}

export interface ExperimentRecipe {
  recipe_version: '1.0'
  title: string
  simulation: {
    schema_version: '1.0'
    seed: number
    duration_s: number
    sampling_rate_hz: number
    channel_count: number
    noise_uv: number
    sources: SourceSpec[]
  }
  preprocessing: {
    highpass_hz: number | null
    lowpass_hz: number | null
    notch_hz: number | null
    filter_order: number
    reference: 'average' | 'none'
  }
}

export interface WarningMessage {
  code: string
  severity: Severity
  title: string
  explanation: string
  suggestion: string | null
}

export interface ExperimentResult {
  run_id: string
  state: 'completed' | 'partial' | 'failed'
  recipe: ExperimentRecipe
  warnings: WarningMessage[]
  traces: {
    x: number[]
    series: Record<string, number[]>
    x_unit: string
    y_unit: string
  }
  spectrum: {
    frequency_hz: number[]
    raw_power: number[]
    filtered_power: number[]
    raw_power_by_channel: Record<string, number[]>
    filtered_power_by_channel: Record<string, number[]>
    unit: string
  }
  filter_response: {
    frequency_hz: number[]
    gain_db: number[]
  }
  mixing_matrix: number[][]
  peak_frequencies_hz: number[]
  truth_peaks_hz: number[]
  retained_variance_pct: number
  provenance: {
    recipe_hash: string
    created_at: string
    engine_version: string
    numpy_version: string
    scipy_version: string
    seed: number
    sampling_rate_hz: number
    units: string
    reference: string
    rank: number
  }
}

export type RequestState =
  | { status: 'idle' }
  | { status: 'loading'; stage: string; progress: number }
  | { status: 'success'; data: ExperimentResult }
  | { status: 'error'; message: string }

export const defaultRecipe: ExperimentRecipe = {
  recipe_version: '1.0',
  title: 'Sampling & filtering · first run',
  simulation: {
    schema_version: '1.0',
    seed: 42,
    duration_s: 8,
    sampling_rate_hz: 250,
    channel_count: 4,
    noise_uv: 4,
    sources: [
      { id: 'delta', label: 'Slow drift', frequency_hz: 2, amplitude_uv: 8, phase_deg: 0, kind: 'sine' },
      { id: 'alpha', label: 'Alpha rhythm', frequency_hz: 10, amplitude_uv: 24, phase_deg: 0, kind: 'sine' },
      { id: 'line', label: 'Line noise', frequency_hz: 60, amplitude_uv: 12, phase_deg: 0, kind: 'sine' },
    ],
  },
  preprocessing: {
    highpass_hz: 1,
    lowpass_hz: 40,
    notch_hz: 60,
    filter_order: 4,
    reference: 'average',
  },
}

export interface IcaRecipe {
  recipe_version: '1.0'
  title: string
  seed: number
  duration_s: number
  sampling_rate_hz: number
  blink_amplitude_uv: number
  sensor_noise_uv: number
  reference: 'average' | 'none'
  fit_highpass_hz: number
  fit_lowpass_hz: number
  algorithm: 'fastica' | 'infomax'
  component_count: number
}

export interface IcaComponentSummary {
  index: number
  suggested_label: string
  suggestion_probability: number
  explained_variance_pct: number
  matched_truth: string | null
  matched_correlation: number | null
  time_s: number[]
  trace: number[]
  frequency_hz: number[]
  power: number[]
  topography: number[]
}

export interface IcaFitResult {
  run_id: string
  state: 'completed' | 'failed'
  recipe: IcaRecipe
  warnings: WarningMessage[]
  raw_trace: {
    x: number[]
    series: Record<string, number[]>
    x_unit: string
    y_unit: string
  }
  components: IcaComponentSummary[]
  compatibility: {
    fingerprint: string
    channel_names: string[]
    bad_channels: string[]
    reference: string
    rank: number
    fit_highpass_hz: number
  }
  blink_component_index: number | null
  mean_matched_correlation: number
  icalabel_available: boolean
  provenance: ExperimentResult['provenance']
}

export interface IcaSimulationResult {
  run_id: string
  state: 'completed' | 'failed'
  recipe: IcaRecipe
  sensor_trace: {
    x: number[]
    series: Record<string, number[]>
    x_unit: string
    y_unit: string
  }
  source_labels: string[]
  channel_names: string[]
  rank: number
  provenance: ExperimentResult['provenance']
}

export interface IcaApplyResult {
  run_id: string
  state: 'completed' | 'failed'
  excluded_components: number[]
  before_after_trace: {
    x: number[]
    series: Record<string, number[]>
    x_unit: string
    y_unit: string
  }
  artifact_attenuation_db: number
  neural_distortion_pct: number
  neural_retention_pct: number
  compatibility_verified: boolean
  warnings: WarningMessage[]
}

export const defaultIcaRecipe: IcaRecipe = {
  recipe_version: '1.0',
  title: 'ICA artifact recovery · planted blink',
  seed: 97,
  duration_s: 12,
  sampling_rate_hz: 250,
  blink_amplitude_uv: 90,
  sensor_noise_uv: 0.25,
  reference: 'average',
  fit_highpass_hz: 1,
  fit_lowpass_hz: 100,
  algorithm: 'infomax',
  component_count: 4,
}

export type ConnectivityMetric = 'pearson' | 'coh' | 'imcoh' | 'plv' | 'ppc' | 'pli' | 'wpli'
export type ConnectivitySpace = 'sensor' | 'latent'

export interface ConnectivityRecipe {
  recipe_version: '1.0'
  title: string
  seed: number
  sampling_rate_hz: number
  epoch_count: number
  epoch_duration_s: number
  alpha_frequency_hz: number
  phase_lag_deg: number
  coupling_strength: number
  noise_sd: number
  volume_conduction: number
  reference: 'average' | 'none'
  analysis_space: ConnectivitySpace
  metric: ConnectivityMetric
  spectral_mode: 'multitaper' | 'fourier'
  band_low_hz: number
  band_high_hz: number
  surrogate_count: number
}

export interface ConnectivityMatrix {
  node_names: string[]
  values: number[][]
  space: ConnectivitySpace | 'truth'
  metric: string
  band_hz: [number, number]
}

export interface ConnectivityEdge {
  source: string
  target: string
  weight: number
  detected: boolean
  is_true: boolean | null
}

export interface ConnectivitySimulation {
  recipe: ConnectivityRecipe
  epoch_index: number
  latent_trace: { x: number[]; series: Record<string, number[]>; x_unit: string; y_unit: string }
  sensor_trace: { x: number[]; series: Record<string, number[]>; x_unit: string; y_unit: string }
  mixing_matrix: number[][]
}

export interface ConnectivityResult {
  simulation: ConnectivitySimulation
  run_id: string
  state: 'completed' | 'failed'
  recipe: ConnectivityRecipe
  warnings: WarningMessage[]
  spectrum: {
    frequency_hz: number[]
    welch_power: number[]
    multitaper_power: number[]
    unit: string
    frequency_resolution_hz: number
    parameterization: {
      backend: 'specparam'
      fit_low_hz: number
      fit_high_hz: number
      offset: number
      exponent: number
      peak_frequency_hz: number | null
      peak_power: number | null
      peak_bandwidth_hz: number | null
      r_squared: number
      mean_absolute_error: number
      aperiodic_power: number[]
      modeled_power: number[]
    }
  }
  latent: ConnectivityMatrix
  sensor: ConnectivityMatrix
  selected: ConnectivityMatrix
  truth: ConnectivityMatrix
  latent_edges: ConnectivityEdge[]
  sensor_edges: ConnectivityEdge[]
  thresholded_edges: ConnectivityEdge[]
  surrogate_values: number[]
  latent_surrogate_values: number[]
  sensor_surrogate_values: number[]
  selected_threshold: number
  latent_threshold: number
  sensor_threshold: number
  surrogate_percentile: number
  scores: {
    threshold: number
    true_positive: number
    false_positive: number
    false_negative: number
    precision: number
    recall: number
    strongest_edge_correct: boolean
    weighted_truth_correlation: number
  }
  mixing_matrix: number[][]
  sensor_positions: [number, number][]
  estimator_backend: 'mne-connectivity' | 'numpy'
  estimator_family: 'functional' | 'lag-sensitive'
  n_epochs_used: number
  provenance: ExperimentResult['provenance']
}

export type ConnectivityRequestState =
  | { status: 'idle' }
  | { status: 'loading'; stage: string; progress: number }
  | { status: 'success'; data: ConnectivityResult }
  | { status: 'error'; message: string }

export const defaultConnectivityRecipe = {
  recipe_version: '1.0',
  title: 'Connectivity truth challenge · alpha network',
  seed: 314,
  sampling_rate_hz: 200,
  epoch_count: 24,
  epoch_duration_s: 2,
  alpha_frequency_hz: 10,
  phase_lag_deg: 60,
  coupling_strength: 0.78,
  noise_sd: 0.55,
  volume_conduction: 0.72,
  reference: 'average',
  analysis_space: 'sensor',
  metric: 'coh',
  spectral_mode: 'multitaper',
  band_low_hz: 8,
  band_high_hz: 12,
  surrogate_count: 48,
} satisfies ConnectivityRecipe

export interface SourceModelRecipe {
  recipe_version: '1.0'
  title: string
  seed: number
  sampling_rate_hz: number
  duration_s: number
  alpha_frequency_hz: number
  phase_lag_deg: number
  source_amplitude_nam: number
  sensor_noise_uv: number
  inverse_method: 'MNE'
  montage: 'standard_1020_14'
  grid_spacing_mm: 20 | 40
  inverse: { lambda2: number; peak_threshold: number; peak_separation_mm: number }
}

export interface SourceModelResult {
  run_id: string
  state: 'completed' | 'failed'
  recipe: SourceModelRecipe
  warnings: WarningMessage[]
  template_description: string
  forward_method: string
  inverse_method: string
  rois: SourceRoi[]
  candidate_positions_mm: [number, number, number][]
  power_maps: SourcePowerMap[]
  candidate_time_courses: ExperimentResult['traces']
  evaluation: SourceEvaluation
  sensor_trace: ExperimentResult['traces']
  latent_roi_time_courses: ExperimentResult['traces']
  reconstructed_roi_time_courses: ExperimentResult['traces']
  sensor_topographies: { roi_id: string; label: string; values: number[] }[]
  sensor_positions: [number, number][]
  scores: {
    mean_roi_correlation: number
    roi_correlations: Record<string, number>
    max_roi_cross_talk: number
    leakage_matrix: number[][]
  }
  provenance: ExperimentResult['provenance']
}

export interface SourcePeak {
  id: string
  vertex_index: number
  position_mm: [number, number, number]
  power_nam2: number
  relative_power: number
}

export interface SourcePowerMap {
  id: string
  label: string
  low_hz: number
  high_hz: number
  power_nam2: number[]
  relative_power: number[]
  peaks: SourcePeak[]
}

export interface SourceEvaluation {
  match_radius_mm: number
  bands: {
    band_id: string
    matches: { roi_id: string; peak_id: string; distance_mm: number }[]
    missed_roi_ids: string[]
    unmatched_peak_ids: string[]
    mean_error_mm: number | null
  }[]
  matched_count: number
  missed_count: number
  unmatched_peak_count: number
  mean_error_mm: number | null
  max_error_mm: number | null
  outside_band_roi_ids: string[]
}

export interface SourceRoi {
  id: string
  label: string
  position_mm: [number, number, number]
  frequency_hz: number
  amplitude_nam: number
  phase_deg: number
}

export interface SourceModelSimulation {
  run_id: string
  state: 'completed' | 'failed'
  recipe: SourceModelRecipe
  template_description: string
  rois: SourceRoi[]
  candidate_positions_mm: [number, number, number][]
  sensor_trace: ExperimentResult['traces']
  sensor_positions: [number, number][]
  provenance: ExperimentResult['provenance']
}

export type SourceModelRequestState =
  | { status: 'idle' }
  | { status: 'loading'; stage: string; progress: number }
  | { status: 'success'; data: SourceModelResult }
  | { status: 'error'; message: string }

export const defaultSourceModelRecipe = {
  recipe_version: '1.0',
  title: 'Source modeling · template ROI benchmark',
  seed: 2718,
  sampling_rate_hz: 100,
  duration_s: 4,
  alpha_frequency_hz: 10,
  phase_lag_deg: 55,
  source_amplitude_nam: 20,
  sensor_noise_uv: 0.08,
  inverse_method: 'MNE',
  montage: 'standard_1020_14',
  grid_spacing_mm: 20,
  inverse: { lambda2: 1 / 9, peak_threshold: 0.35, peak_separation_mm: 40 },
} satisfies SourceModelRecipe

export interface LocalImportRequest {
  source_path: string
  project_name: string
}

export interface RecordingInspection {
  source_name: string
  format: 'fif' | 'edf' | 'bdf' | 'brainvision' | 'eeglab'
  source_sha256: string
  channel_count: number
  eeg_channel_count: number
  channel_names: string[]
  channel_types: Record<string, number>
  sampling_rate_hz: number
  duration_s: number
  highpass_hz: number | null
  lowpass_hz: number | null
  annotation_count: number
  digitization_point_count: number
  montage_present: boolean
  warnings: WarningMessage[]
}

export interface RealDataProject {
  project_id: string
  schema_version: number
  migration_status: 'current' | 'migrated' | 'recovered'
  project_name: string
  source_name: string
  source_format: 'fif' | 'edf' | 'bdf' | 'brainvision' | 'eeglab'
  working_copy_name: string
  imported_at: string
}

export interface RealDataImportResult {
  project: RealDataProject
  inspection: RecordingInspection
  qc: {
    channel_count: number
    eeg_channel_count: number
    duration_s: number
    sampling_rate_hz: number
    bad_channels: string[]
    flat_channels: string[]
    annotation_count: number
    alpha_relative_power: number | null
    warnings: WarningMessage[]
  }
  report_available: boolean
}

export interface EegbciLessonStatus {
  state: 'cached' | 'not_cached'
  cache_directory: string
  available_runs: number[]
  message: string
}

export interface EegbciImportRequest {
  run: 1 | 2
  project_name: string
}

export interface ReportExportResult {
  project_id: string
  report_name: string
  download_path: string
  generated_at: string
}

export interface RealDataQeegRequest {
  schema_version: '1.0'
  highpass_hz: number
  lowpass_hz: number
  notch_hz: number | null
  reference: 'average' | 'none'
  duration_limit_s: number
  epoch_duration_s: number
  reject_by_annotation: boolean
  ica_enabled: boolean
  ica_method: 'fastica' | 'infomax'
  ica_component_count: number
  ica_exclude_components: number[]
  connectivity_band: 'theta' | 'alpha' | 'beta'
  max_connectivity_channels: number
}

export const defaultRealDataQeegRequest: RealDataQeegRequest = {
  schema_version: '1.0',
  highpass_hz: 1,
  lowpass_hz: 40,
  notch_hz: null,
  reference: 'average',
  duration_limit_s: 120,
  epoch_duration_s: 2,
  reject_by_annotation: true,
  ica_enabled: false,
  ica_method: 'fastica',
  ica_component_count: 12,
  ica_exclude_components: [],
  connectivity_band: 'alpha',
  max_connectivity_channels: 12,
}

export interface QeegBandPower {
  name: 'delta' | 'theta' | 'alpha' | 'beta' | 'gamma'
  low_hz: number
  high_hz: number
  mean_absolute_power_uv2: number
  mean_relative_power: number
  absolute_power_by_channel_uv2: number[]
  relative_power_by_channel: number[]
}

export interface QeegConnectivityMatrix {
  method: 'coh' | 'plv'
  band: 'theta' | 'alpha' | 'beta'
  band_hz: [number, number]
  channel_names: string[]
  values: number[][]
  epoch_count: number
}

export interface RealDataQeegResult {
  run_id: string
  state: 'completed' | 'partial'
  request: RealDataQeegRequest
  channel_names: string[]
  sampling_rate_hz: number
  analyzed_duration_s: number
  trace: { x: number[]; series: Record<string, number[]>; x_unit: string; y_unit: string }
  frequency_hz: number[]
  mean_psd_uv2_hz: number[]
  psd_by_channel_uv2_hz: Record<string, number[]>
  band_powers: QeegBandPower[]
  theta_beta_ratio_by_channel: Record<string, number | null>
  mean_theta_beta_ratio: number | null
  topomaps: {
    band: QeegBandPower['name']
    channel_names: string[]
    relative_power: number[]
    sensor_positions: [number, number][]
    available: boolean
  }[]
  coherence: QeegConnectivityMatrix
  plv: QeegConnectivityMatrix
  ica_components: {
    index: number
    explained_variance_pct: number
    topography: number[]
    peak_frequency_hz: number | null
  }[]
  ica_excluded_components: number[]
  cleaned_fif_path: string
  result_json_path: string
  warnings: WarningMessage[]
  provenance: {
    created_at: string
    mne_version: string
    mne_connectivity_version: string
    source_working_copy: string
    source_sha256: string
    analyzed_duration_s: number
    recipe_hash: string
  }
}
