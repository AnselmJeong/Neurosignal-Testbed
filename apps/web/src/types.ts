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
  matched_truth: string
  matched_correlation: number
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
  blink_component_index: number
  mean_matched_correlation: number
  icalabel_available: boolean
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
