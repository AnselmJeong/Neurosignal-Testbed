// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSourceModelRecipe, type SourceModelResult, type SourceModelSimulation } from '../types'
import { SourceModelWorkbench } from './SourceModelWorkbench'

const api = vi.hoisted(() => ({ runSourceModel: vi.fn(), simulateSourceModel: vi.fn() }))
vi.mock('../lib/api', () => api)
vi.mock('./StackedEegBrowser', () => ({ StackedEegBrowser: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> }))
const channels = ['Fp1', 'Fp2', 'F3', 'F4', 'C3', 'C4', 'P3', 'P4', 'O1', 'O2', 'Fz', 'Cz', 'Pz', 'Oz']
const trace = (names: string[], unit: string) => ({ x: [0, 0.01, 0.02], series: Object.fromEntries(names.map((name) => [name, [0, 1, 0]])), x_unit: 's', y_unit: unit })
const positions: [number, number, number][] = [[-40, 0, 40], [0, 0, 40], [40, 0, 40]]
const rois = [
  { id: 'left', label: 'Planted left', position_mm: positions[0]!, frequency_hz: 10, amplitude_nam: 20, phase_deg: 0 },
  { id: 'right', label: 'Planted right', position_mm: positions[2]!, frequency_hz: 10, amplitude_nam: 17.6, phase_deg: 55 },
]
const simulation: SourceModelSimulation = {
  run_id: 'input', state: 'completed', recipe: defaultSourceModelRecipe, template_description: 'sphere',
  rois, candidate_positions_mm: positions, sensor_trace: trace(channels, 'µV'), sensor_positions: [],
  provenance: { recipe_hash: 'test', created_at: '', engine_version: '0.2.5', numpy_version: '', scipy_version: '', seed: 2718, sampling_rate_hz: 100, units: 'µV display / V analysis', reference: 'average', rank: 13 },
}
const result: SourceModelResult = {
  ...simulation, run_id: 'result', warnings: [], forward_method: 'MNE forward', inverse_method: 'MNE minimum norm',
  power_maps: [{
    id: 'alpha', label: 'Alpha · 8–13 Hz', low_hz: 8, high_hz: 13,
    power_nam2: [1, 3, 1], relative_power: [1 / 3, 1, 1 / 3],
    peaks: [{ id: 'alpha-v1', vertex_index: 1, position_mm: positions[1]!, power_nam2: 3, relative_power: 1 }],
  }],
  candidate_time_courses: trace(['v0', 'v1', 'v2'], 'nAm'),
  evaluation: {
    match_radius_mm: 40, matched_count: 1, missed_count: 1, unmatched_peak_count: 0,
    mean_error_mm: 40, max_error_mm: 40, outside_band_roi_ids: [],
    bands: [{ band_id: 'alpha', matches: [{ roi_id: 'left', peak_id: 'alpha-v1', distance_mm: 40 }], missed_roi_ids: ['right'], unmatched_peak_ids: [], mean_error_mm: 40 }],
  },
  latent_roi_time_courses: trace(rois.map((r) => r.label), 'nAm'),
  reconstructed_roi_time_courses: trace(rois.map((r) => r.label), 'nAm'),
  sensor_topographies: positions.map((_, i) => ({ roi_id: 'v' + i, label: 'Candidate ' + i, values: channels.map((__, j) => j % 2 ? -.5 : .5) })),
  scores: { mean_roi_correlation: .9, roi_correlations: { left: .9, right: .9 }, max_roi_cross_talk: .1, leakage_matrix: [[1, .1], [.1, 1]] },
}
afterEach(cleanup)
beforeEach(() => {
  api.simulateSourceModel.mockReset().mockResolvedValue(structuredClone(simulation))
  api.runSourceModel.mockReset().mockResolvedValue(structuredClone(result))
})
async function estimate() {
  fireEvent.click(screen.getByRole('button', { name: '1 · Generate sensor EEG' }))
  await screen.findByRole('img', { name: /forward-projected sensor EEG/i })
  fireEvent.click(screen.getByRole('button', { name: '2 · Estimate sources' }))
  await screen.findByRole('heading', { name: '1 detected peak' })
}

describe('Source localization workflow', () => {
  it('requires EEG generation and teaches inference without a preset count', async () => {
    render(<SourceModelWorkbench activeLab="source" onLabChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: '2 · Estimate sources' })).toBeDisabled()
    expect(screen.getByRole('heading', { name: /let the estimate find its own peaks/i })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '1 · Generate sensor EEG' }))
    await screen.findByRole('img', { name: /forward-projected sensor EEG/i })
    expect(api.runSourceModel).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: 'Sensor EEG' })).toHaveAttribute('aria-selected', 'true')
  })

  it('hides truth-derived labels and evaluation until explicit reveal', async () => {
    render(<SourceModelWorkbench activeLab="source" onLabChange={vi.fn()} />)
    await estimate()
    expect(screen.queryByText(/Planted left/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Revealed localization evaluation')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Truth diagnostics' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Peak 1 · v1/ })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Reveal and evaluate' }))
    expect(screen.getByLabelText('Revealed localization evaluation')).toHaveTextContent('Missed: Planted right')
    expect(screen.getByText('Matched / planted')).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Truth diagnostics' })).toBeEnabled()
  })

  it('lets users inspect arbitrary candidates rather than four truth ROIs', async () => {
    render(<SourceModelWorkbench activeLab="source" onLabChange={vi.fn()} />)
    await estimate()
    fireEvent.change(screen.getByLabelText('Inspect source candidate'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Candidate trace' }))
    expect(screen.getByRole('img', { name: 'Selected candidate current estimated from EEG' })).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'Forward map' }))
    expect(screen.getByRole('heading', { name: 'Candidate v2 · 40, 0, 40 mm' })).toBeVisible()
    expect(screen.queryByText(/Planted right/)).not.toBeInTheDocument()
  })

  it('re-estimates the same simulation after inverse changes and resets revealed scores', async () => {
    render(<SourceModelWorkbench activeLab="source" onLabChange={vi.fn()} />)
    await estimate()
    fireEvent.click(screen.getByRole('button', { name: 'Reveal and evaluate' }))
    fireEvent.change(screen.getByRole('slider', { name: 'Peak threshold' }), { target: { value: '80' } })
    expect(screen.queryByText('Matched / planted')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reveal and evaluate' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '2 · Estimate sources' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '2 · Estimate sources' }))
    await screen.findByRole('heading', { name: '1 detected peak' })
    expect(api.simulateSourceModel).toHaveBeenCalledTimes(1)
    expect(api.runSourceModel.mock.calls[1]![0]).toEqual({ ...simulation.recipe, inverse: { ...simulation.recipe.inverse, peak_threshold: .8 } })
  })

  it('reports no peak and no match without displaying a fabricated zero error', async () => {
    const empty = structuredClone(result)
    empty.power_maps[0]!.peaks = []
    empty.evaluation = { ...empty.evaluation, matched_count: 0, missed_count: 2, mean_error_mm: null, max_error_mm: null, bands: [{ band_id: 'alpha', matches: [], missed_roi_ids: ['left', 'right'], unmatched_peak_ids: [], mean_error_mm: null }] }
    api.runSourceModel.mockResolvedValue(empty)
    render(<SourceModelWorkbench activeLab="source" onLabChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '1 · Generate sensor EEG' }))
    await screen.findByRole('img', { name: /forward-projected sensor EEG/i })
    fireEvent.click(screen.getByRole('button', { name: '2 · Estimate sources' }))
    await screen.findByRole('heading', { name: '0 detected peaks' })
    fireEvent.click(screen.getByRole('button', { name: 'Reveal and evaluate' }))
    expect(screen.getByText('No matches')).toBeVisible()
    expect(screen.getByText(/No distinct peak passed these rules/)).toBeVisible()
  })

  it('keeps controls locked during estimation and offers retry after an error', async () => {
    api.runSourceModel.mockRejectedValueOnce(new Error('Test inverse failure'))
    render(<SourceModelWorkbench activeLab="source" onLabChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '1 · Generate sensor EEG' }))
    await screen.findByRole('img', { name: /forward-projected sensor EEG/i })
    fireEvent.click(screen.getByRole('button', { name: '2 · Estimate sources' }))
    expect(screen.getByRole('slider', { name: 'Sensor noise' })).toBeDisabled()
    expect(await screen.findByRole('alert')).toHaveTextContent('Test inverse failure')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('heading', { name: '1 detected peak' })
  })
})
