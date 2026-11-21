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
  fireEvent.click(screen.getByRole('button', { name: '1 · 기준 EEG 생성(Generate)' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '2 · 연결성 추정(Estimate)' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '2 · 연결성 추정(Estimate)' }))
  await screen.findByRole('article', { name: 'A · 저장한 기준' })
}
async function makeB() {
  fireEvent.click(screen.getByRole('button', { name: '1 · 비교용 EEG 생성(Generate)' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '2 · B 추정(Estimate)' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '2 · B 추정(Estimate)' }))
  await screen.findByRole('article', { name: 'B · 최근 추정' })
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
    expect(screen.getByRole('img', { name: /설정한 잠재 원천 네트워크/ })).toBeVisible()
    expect(screen.getByText(/Frontal L과 R은 네 원천 중 둘이며/)).toBeVisible()
    expect(screen.getByRole('button', { name: '2 · 연결성 추정(Estimate)' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '1 · 기준 EEG 생성(Generate)' }))
    await screen.findByRole('img', { name: '생성한 센서 EEG' })
    expect(screen.getByRole('img', { name: '생성한 잠재 원천 신호' })).toBeVisible()
    expect(api.runConnectivity).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('slider', { name: 'Phase offset' }), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: '2 · 연결성 추정(Estimate)' })).toBeDisabled()
    expect(screen.getByText(/이전에 생성한 설정/)).toBeVisible()
  })

  it('freezes A, compares a controlled B change, and can promote B', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    await makeA()
    fireEvent.click(screen.getByRole('button', { name: '공유 알파 빼기' }))
    expect(screen.getByRole('article', { name: 'A · 저장한 기준' })).toHaveTextContent('공유 가중치 0.78')
    expect(screen.getByRole('img', { name: /설정한 잠재 원천 네트워크: 공유 알파 성분 없음/ })).toBeVisible()
    await makeB()
    expect(screen.getByRole('article', { name: 'B · 최근 추정' })).toHaveTextContent('공유 가중치 0.00')
    expect(screen.getByRole('article', { name: 'A · 저장한 기준' })).toHaveTextContent('공유 가중치 0.78')
    const [a, b] = api.runConnectivity.mock.calls.map(call => call[0])
    expect(b).toEqual({ ...a, coupling_strength: 0 })
    expect(screen.getByRole('heading', { name: '가장 크게 바뀐 센서 쌍 · B − A' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'B를 새 A로 쓰기' }))
    expect(screen.queryByRole('article', { name: 'B · 최근 추정' })).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'A · 저장한 기준' })).toHaveTextContent('공유 가중치 0.00')
  })

  it('retains A on request failure and locks controls while a request is pending', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    await makeA()
    fireEvent.click(screen.getByRole('button', { name: '기준전극 바꾸기' }))
    let reject!: (error: Error) => void
    api.simulateConnectivity.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    fireEvent.click(screen.getByRole('button', { name: '1 · 비교용 EEG 생성(Generate)' }))
    expect(screen.getByRole('slider', { name: 'Shared alpha weight' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '기준전극 바꾸기' })).toBeDisabled()
    await act(async () => reject(new Error('Service unavailable')))
    expect(screen.getByRole('alert')).toHaveTextContent('Service unavailable')
    expect(screen.getByRole('article', { name: 'A · 저장한 기준' })).toBeVisible()
    expect(screen.getByRole('button', { name: '1 · 비교용 EEG 생성(Generate)' })).toBeEnabled()
  })

  it('reuses generated EEG when changing metric before the first estimate', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '1 · 기준 EEG 생성(Generate)' }))
    await screen.findByRole('img', { name: '생성한 센서 EEG' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Connectivity metric' }), { target: { value: 'plv' } })
    expect(screen.getByRole('button', { name: '2 · 연결성 추정(Estimate)' })).toBeEnabled()
    expect(api.simulateConnectivity).toHaveBeenCalledTimes(1)
    expect(api.runConnectivity).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '2 · 연결성 추정(Estimate)' }))
    await screen.findByRole('article', { name: 'A · 저장한 기준' })
    expect(api.runConnectivity.mock.lastCall?.[0].metric).toBe('plv')
  })

  it('re-estimates A alone on metric change without inventing a B', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    await makeA()
    expect(screen.queryByRole('group', { name: 'EEG 스냅숏' })).not.toBeInTheDocument()
    const original = api.runConnectivity.mock.calls[0]![0]
    fireEvent.change(screen.getByRole('combobox', { name: 'Connectivity metric' }), { target: { value: 'plv' } })
    await waitFor(() => expect(screen.getByRole('article', { name: 'A · 저장한 기준' })).toHaveTextContent('PLV'))
    expect(api.runConnectivity).toHaveBeenLastCalledWith({ ...original, metric: 'plv' })
    expect(api.simulateConnectivity).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('article', { name: 'B · 최근 추정' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2 · B 추정(Estimate)' })).toBeEnabled()
  })

  it('updates saved A/B together, preserving an unestimated B preview and draft', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    await makeA()
    fireEvent.click(screen.getByRole('button', { name: '공유 알파 빼기' }))
    await makeB()
    expect(screen.getByRole('button', { name: 'B - 비교 EEG' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'A - 기준 EEG' })).toBeVisible()
    const [a, b] = api.runConnectivity.mock.calls.map(call => call[0])
    fireEvent.change(screen.getByRole('slider', { name: 'Field spread' }), { target: { value: '0.2' } })
    fireEvent.click(screen.getByRole('button', { name: '1 · 비교용 EEG 생성(Generate)' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '2 · B 추정(Estimate)' })).toBeEnabled())
    let finishA!: (value: ConnectivityResult) => void
    let finishB!: (value: ConnectivityResult) => void
    api.runConnectivity.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishB = resolve }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Connectivity metric' }), { target: { value: 'plv' } })
    expect(api.runConnectivity.mock.calls.slice(2).map(call => call[0])).toEqual([{ ...a, metric: 'plv' }, { ...b, metric: 'plv' }])
    await act(async () => finishA(result({ ...a, metric: 'plv' })))
    expect(screen.getByRole('article', { name: 'A · 저장한 기준' })).toHaveTextContent('Coherence')
    expect(screen.getByRole('article', { name: 'B · 최근 추정' })).toHaveTextContent('Coherence')
    expect(screen.getByRole('combobox', { name: 'Connectivity metric' })).toBeDisabled()
    await act(async () => finishB(result({ ...b, metric: 'plv' })))
    expect(screen.getByRole('article', { name: 'A · 저장한 기준' })).toHaveTextContent('PLV')
    expect(screen.getByRole('article', { name: 'B · 최근 추정' })).toHaveTextContent('PLV')
    expect(screen.getByRole('slider', { name: 'Field spread' })).toHaveValue('0.2')
    expect(screen.getByRole('button', { name: '2 · B 추정(Estimate)' })).toBeEnabled()
    expect(api.simulateConnectivity).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('heading', { name: '가장 크게 바뀐 센서 쌍 · B − A' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '원천 추정' }))
    expect(within(screen.getByRole('article', { name: 'B · 최근 추정' })).getByText(/원천 귀무 임계값\(0.300\)/)).toBeVisible()
  })

  it('rolls back both saved results and the selector if one recalculation fails, then retries', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    await makeA()
    fireEvent.click(screen.getByRole('button', { name: '공유 알파 빼기' }))
    await makeB()
    api.runConnectivity.mockImplementationOnce(async recipe => result(recipe))
      .mockRejectedValueOnce(new Error('B failed'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Connectivity metric' }), { target: { value: 'plv' } })
    await screen.findByRole('alert')
    expect(screen.getByRole('combobox', { name: 'Connectivity metric' })).toHaveValue('coh')
    expect(screen.getByRole('article', { name: 'A · 저장한 기준' })).toHaveTextContent('Coherence')
    expect(screen.getByRole('article', { name: 'B · 최근 추정' })).toHaveTextContent('Coherence')
    fireEvent.change(screen.getByRole('combobox', { name: 'Connectivity metric' }), { target: { value: 'plv' } })
    await waitFor(() => expect(screen.getByRole('article', { name: 'B · 최근 추정' })).toHaveTextContent('PLV'))
    expect(screen.getByRole('article', { name: 'A · 저장한 기준' })).toHaveTextContent('PLV')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.simulateConnectivity).toHaveBeenCalledTimes(2)
  })

  it('applies spectral mode changes to both saved conditions', async () => {
    render(<ConnectivityWorkbench activeLab="connectivity" onLabChange={vi.fn()} />)
    await makeA()
    fireEvent.click(screen.getByRole('button', { name: '기준전극 바꾸기' }))
    await makeB()
    fireEvent.click(screen.getByText('신호와 추정의 세부 설정'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Spectral mode' }), { target: { value: 'fourier' } })
    await waitFor(() => expect(screen.getByRole('article', { name: 'B · 최근 추정' })).toHaveTextContent('fourier'))
    expect(screen.getByRole('article', { name: 'A · 저장한 기준' })).toHaveTextContent('fourier')
    expect(api.runConnectivity.mock.calls.slice(2).map(call => call[0].spectral_mode)).toEqual(['fourier', 'fourier'])
    expect(api.simulateConnectivity).toHaveBeenCalledTimes(2)
  })
})
