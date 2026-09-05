export interface QeegRecipe {
  seed: number
  montage: '19' | '32'
  reference: 'average' | 'linked_mastoids'
  head_model: 'standard' | 'conductive_skull'
  alpha_amplitude: number
  theta_amplitude: number
  beta_amplitude: number
  alpha_hz: number
  right_alpha_gain: number
  cohort_size: number
  cohort_seed: number
}
export const defaultQeegRecipe: QeegRecipe = {
  seed: 42, montage: '19', reference: 'average', head_model: 'standard',
  alpha_amplitude: 18, theta_amplitude: 9, beta_amplitude: 7, alpha_hz: 10,
  right_alpha_gain: 1, cohort_size: 80, cohort_seed: 2026,
}
export interface NormSummary {
  subject: number[][]; mean: number[][]; sd: number[][]; z: number[][]
  percentile: number[][]; cohort_values: number[][][]
}
export interface QeegResult {
  recipe: QeegRecipe
  channel_names: string[]
  positions_2d: [number, number][]
  positions_m: number[][]
  source_positions_m: number[][]
  leadfield_v_per_am: number[][]
  conductivities_s_m: number[]
  time_s: number[]; eeg_uv: number[][]; source_nam: number[][]
  metrics: {
    frequency_hz: number[]; psd: number[][]; absolute: number[][]; relative: number[][]
    theta_beta: number[]; alpha_peak_hz: number[]; median_hz: number[]
    sef95_hz: number[]; entropy: number[]
  }
  atlas_absolute: number[][]; atlas_relative: number[][]
  bands: { name: string; low: number; high: number }[]
  norms: Record<'absolute' | 'relative' | 'theta_beta', NormSummary>
  coherence: number[][]; plv: number[][]; frontal_alpha_asymmetry: number
  provenance: { engine: string; mne: string; numpy: string; scipy: string; sfreq: number; duration_s: number; welch_segments: number }
}
export async function simulateQeeg(recipe: QeegRecipe): Promise<QeegResult> {
  const response = await fetch(`${import.meta.env.VITE_API_URL ?? '/api'}/qeeg/simulate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(recipe),
  })
  if (!response.ok) throw new Error('Simulation could not finish. Check the local API and recipe values, then retry.')
  return response.json() as Promise<QeegResult>
}
