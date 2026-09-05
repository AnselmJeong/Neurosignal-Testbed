// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectivityRecipe, ConnectivityResult, ConnectivitySimulation } from '../types'
import { ConnectivityWorkbench } from './ConnectivityWorkbench'

const api = vi.hoisted(() => ({ simulateConnectivity: vi.fn(), runConnectivity: vi.fn() }))
vi.mock('../lib/api', () => api)
vi.mock('@neurosignal/trace-viewer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@neurosignal/trace-viewer')>()
  return { ...actual, TraceViewer: (props: React.ComponentProps<typeof actual.TraceViewer>) => <actual.TraceViewer {...props} renderer="svg" /> }
})
const latentNames = ['Frontal L', 'Frontal R', 'Posterior L', 'Posterior R']
const sensorNames = ['Fp1', 'Fp2', 'F7', 'F8', 'C3', 'C4', 'O1', 'O2']
function simulation(recipe: ConnectivityRecipe): ConnectivitySimulation {
  const trace = (names: string[]) => ({ x: [0, 0.005, 0.01], series: Object.fromEntries(names.map(name => [name, [0, 1, 0]])), x_unit: 's', y_unit: 'a.u.' })
  return { recipe, epoch_index: 0, latent_trace: trace(latentNames), sensor_trace: trace(sensorNames), mixing_matrix: [] }
}
let count = 0
function result(recipe: ConnectivityRecipe): ConnectivityResult {
  const matrix = (names: string[], space: 'latent' | 'sensor' | 'truth') => ({ node_names: names, values: names.map((_, i) => names.map((_, j) => i === j ? 0 : recipe.coupling_strength)), space, metric: recipe.metric, band_hz: [8, 12] as [number, number] })
  const edge = { source: 'Fp1', target: 'Fp2', weight: recipe.coupling_strength, detected: recipe.coupling_strength > 0.3, is_true: null }
  return {
    run_id: `run-${++count}`, state: 'completed', recipe, simulation: simulation(recipe), warnings: [],
    latent: matrix(latentNames, 'latent'), sensor: matrix(sensorNames, 'sensor'), selected: matrix(sensorNames, 'sensor'), truth: matrix(latentNames, 'truth'),
    latent_edges: [{ ...edge, source: 'Frontal L', target: 'Frontal R', is_true: recipe.coupling_strength > 0 }], sensor_edges: [edge], thresholded_edges: [edge],
    latent_threshold: 0.3, sensor_threshold: 0.4, selected_threshold: 0.4, surrogate_percentile: 95, surrogate_values: [0.2], latent_surrogate_values: [0.1], sensor_surrogate_values: [0.2],
    mixing_matrix: [], sensor_positions: [], estimator_backend: 'mne-connectivity', estimator_family: 'functional', n_epochs_used: recipe.epoch_count,
    scores: { threshold: 0.3, true_positive: 1, false_positive: 0, false_negative: 0, precision: 1, recall: 1, strongest_edge_correct: true, weighted_truth_correlation: 1 },
    spectrum: { frequency_hz: [2, 10, 40], welch_power: [0.1, 1, 0.1], multitaper_power: [0.1, 1, 0.1], unit: 'power/Hz', frequency_resolution_hz: 0.5, parameterization: { backend: 'specparam', fit_low_hz: 2, fit_high_hz: 40, offset: 1, exponent: 1, peak_frequency_hz: 10, peak_power: 1, peak_bandwidth_hz: 1, r_squared: 0.98, mean_absolute_error: 0.1, aperiodic_power: [0.1, 0.1, 0.1], modeled_power: [0.1, 1, 0.1] } },
    provenance: { recipe_hash: 'test', created_at: '', engine_version: '0.2.5', numpy_version: '', scipy_version: '', seed: recipe.seed, sampling_rate_hz: recipe.sampling_rate_hz, units: 'a.u.', reference: recipe.reference, rank: 7 },
  }
}
async function makeA() {
  fireEvent.click(screen.getByRole('button', { name: '1 · Generate baseline EEG' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '2 · Estimate connectivity' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '2 · Estimate connectivity' }))
  await screen.findByRole('article', { name: 'A · saved baseline' })
}
async function makeB() {
  fireEvent.click(screen.getByRole('button', { name: '1 · Generate comparison EEG' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '2 · Estimate B' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '2 · Estimate B' }))
  await screen.findByRole('article', { name: 'B · latest estimate' })
}
afterEach(cleanup)
beforeEach(() => {
  count = 0
  api.simulateConnectivity.mockReset().mockImplementation(async recipe => simulation(recipe))
  api.runConnectivity.mockReset().mockImplementation(async recipe => result(recipe))
})

describe('connectivity teaching sequence', () => {
  it('shows the four-source model first and requires actual EEG before estimation', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    expect(screen.getByRole('img', { name: /Configured latent network/ })).toBeVisible()
    expect(screen.getByText(/Frontal L and R are two of those four sources/)).toBeVisible()
    expect(screen.getByRole('button', { name: '2 · Estimate connectivity' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '1 · Generate baseline EEG' }))
    await screen.findByRole('img', { name: 'Generated sensor EEG' })
    expect(screen.getByRole('img', { name: 'Generated latent source signals' })).toBeVisible()
    expect(api.runConnectivity).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('slider', { name: 'Phase offset' }), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: '2 · Estimate connectivity' })).toBeDisabled()
    expect(screen.getByText(/Previous generated settings/)).toBeVisible()
  })

  it('freezes A, compares a controlled B change, and can promote B', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    await makeA()
    fireEvent.click(screen.getByRole('button', { name: 'Remove shared alpha' }))
    expect(screen.getByRole('article', { name: 'A · saved baseline' })).toHaveTextContent('Shared weight 0.78')
    expect(screen.getByRole('img', { name: /Configured latent network: no shared alpha/ })).toBeVisible()
    await makeB()
    expect(screen.getByRole('article', { name: 'B · latest estimate' })).toHaveTextContent('Shared weight 0.00')
    expect(screen.getByRole('article', { name: 'A · saved baseline' })).toHaveTextContent('Shared weight 0.78')
    const [a, b] = api.runConnectivity.mock.calls.map(call => call[0])
    expect(b).toEqual({ ...a, coupling_strength: 0 })
    expect(screen.getByRole('heading', { name: 'Largest sensor changes · B − A' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Use B as the new A' }))
    expect(screen.queryByRole('article', { name: 'B · latest estimate' })).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'A · saved baseline' })).toHaveTextContent('Shared weight 0.00')
  })

  it('retains A on request failure and locks controls while a request is pending', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    await makeA()
    fireEvent.click(screen.getByRole('button', { name: 'Switch reference' }))
    let reject!: (error: Error) => void
    api.simulateConnectivity.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    fireEvent.click(screen.getByRole('button', { name: '1 · Generate comparison EEG' }))
    expect(screen.getByRole('slider', { name: 'Shared alpha weight' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Switch reference' })).toBeDisabled()
    await act(async () => reject(new Error('Service unavailable')))
    expect(screen.getByRole('alert')).toHaveTextContent('Service unavailable')
    expect(screen.getByRole('article', { name: 'A · saved baseline' })).toBeVisible()
    expect(screen.getByRole('button', { name: '1 · Generate comparison EEG' })).toBeEnabled()
  })

  it('reuses generated EEG when changing metric before the first estimate', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '1 · Generate baseline EEG' }))
    await screen.findByRole('img', { name: 'Generated sensor EEG' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Connectivity metric' }), { target: { value: 'plv' } })
    expect(screen.getByRole('button', { name: '2 · Estimate connectivity' })).toBeEnabled()
    expect(api.simulateConnectivity).toHaveBeenCalledTimes(1)
    expect(api.runConnectivity).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '2 · Estimate connectivity' }))
    await screen.findByRole('article', { name: 'A · saved baseline' })
    expect(api.runConnectivity.mock.lastCall?.[0].metric).toBe('plv')
  })

  it('re-estimates A alone on metric change without inventing a B', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    await makeA()
    expect(screen.queryByRole('group', { name: 'EEG snapshot' })).not.toBeInTheDocument()
    const original = api.runConnectivity.mock.calls[0]![0]
    fireEvent.change(screen.getByRole('combobox', { name: 'Connectivity metric' }), { target: { value: 'plv' } })
    await waitFor(() => expect(screen.getByRole('article', { name: 'A · saved baseline' })).toHaveTextContent('PLV'))
    expect(api.runConnectivity).toHaveBeenLastCalledWith({ ...original, metric: 'plv' })
    expect(api.simulateConnectivity).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('article', { name: 'B · latest estimate' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2 · Estimate B' })).toBeEnabled()
  })

  it('updates saved A/B together, preserving an unestimated B preview and draft', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    await makeA()
    fireEvent.click(screen.getByRole('button', { name: 'Remove shared alpha' }))
    await makeB()
    expect(screen.getByRole('button', { name: 'B - comparison EEG' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'A - baseline EEG' })).toBeVisible()
    const [a, b] = api.runConnectivity.mock.calls.map(call => call[0])
    fireEvent.change(screen.getByRole('slider', { name: 'Field spread' }), { target: { value: '0.2' } })
    fireEvent.click(screen.getByRole('button', { name: '1 · Generate comparison EEG' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '2 · Estimate B' })).toBeEnabled())
    let finishA!: (value: ConnectivityResult) => void
    let finishB!: (value: ConnectivityResult) => void
    api.runConnectivity.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishB = resolve }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Connectivity metric' }), { target: { value: 'plv' } })
    expect(api.runConnectivity.mock.calls.slice(2).map(call => call[0])).toEqual([{ ...a, metric: 'plv' }, { ...b, metric: 'plv' }])
    await act(async () => finishA(result({ ...a, metric: 'plv' })))
    expect(screen.getByRole('article', { name: 'A · saved baseline' })).toHaveTextContent('Coherence')
    expect(screen.getByRole('article', { name: 'B · latest estimate' })).toHaveTextContent('Coherence')
    expect(screen.getByRole('combobox', { name: 'Connectivity metric' })).toBeDisabled()
    await act(async () => finishB(result({ ...b, metric: 'plv' })))
    expect(screen.getByRole('article', { name: 'A · saved baseline' })).toHaveTextContent('PLV')
    expect(screen.getByRole('article', { name: 'B · latest estimate' })).toHaveTextContent('PLV')
    expect(screen.getByRole('slider', { name: 'Field spread' })).toHaveValue('0.2')
    expect(screen.getByRole('button', { name: '2 · Estimate B' })).toBeEnabled()
    expect(api.simulateConnectivity).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('heading', { name: 'Largest sensor changes · B − A' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Source estimates' }))
    expect(within(screen.getByRole('article', { name: 'B · latest estimate' })).getByText(/latent null threshold \(0.300\)/)).toBeVisible()
  })

  it('rolls back both saved results and the selector if one recalculation fails, then retries', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    await makeA()
    fireEvent.click(screen.getByRole('button', { name: 'Remove shared alpha' }))
    await makeB()
    api.runConnectivity.mockImplementationOnce(async recipe => result(recipe))
      .mockRejectedValueOnce(new Error('B failed'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Connectivity metric' }), { target: { value: 'plv' } })
    await screen.findByRole('alert')
    expect(screen.getByRole('combobox', { name: 'Connectivity metric' })).toHaveValue('coh')
    expect(screen.getByRole('article', { name: 'A · saved baseline' })).toHaveTextContent('Coherence')
    expect(screen.getByRole('article', { name: 'B · latest estimate' })).toHaveTextContent('Coherence')
    fireEvent.change(screen.getByRole('combobox', { name: 'Connectivity metric' }), { target: { value: 'plv' } })
    await waitFor(() => expect(screen.getByRole('article', { name: 'B · latest estimate' })).toHaveTextContent('PLV'))
    expect(screen.getByRole('article', { name: 'A · saved baseline' })).toHaveTextContent('PLV')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.simulateConnectivity).toHaveBeenCalledTimes(2)
  })

  it('applies spectral mode changes to both saved conditions', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    await makeA()
    fireEvent.click(screen.getByRole('button', { name: 'Switch reference' }))
    await makeB()
    fireEvent.click(screen.getByText('Signal and estimation details'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Spectral mode' }), { target: { value: 'fourier' } })
    await waitFor(() => expect(screen.getByRole('article', { name: 'B · latest estimate' })).toHaveTextContent('fourier'))
    expect(screen.getByRole('article', { name: 'A · saved baseline' })).toHaveTextContent('fourier')
    expect(api.runConnectivity.mock.calls.slice(2).map(call => call[0].spectral_mode)).toEqual(['fourier', 'fourier'])
    expect(api.simulateConnectivity).toHaveBeenCalledTimes(2)
  })
})
