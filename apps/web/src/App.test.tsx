// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExperimentRecipe, ExperimentResult } from './types'
import App from './App'

const api = vi.hoisted(() => ({ checkHealth: vi.fn(), runRecipe: vi.fn() }))
vi.mock('./lib/api', () => api)
vi.mock('@neurosignal/trace-viewer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@neurosignal/trace-viewer')>()
  return { ...actual, TraceViewer: (props: React.ComponentProps<typeof actual.TraceViewer>) => <actual.TraceViewer {...props} renderer="svg" /> }
})

const channels = ['EEG 01', 'EEG 02', 'EEG 03', 'EEG 04']
function fakeResult(recipe: ExperimentRecipe): ExperimentResult {
  const frequency = [0, 2, 10, 40, 50]
  const raw = [1, 10, 100, 10, 1]
  const filtered = [1, 10, 100, 1, 1]
  const series = (scale: number) => Object.fromEntries(channels.map((name) => [name, [0, scale, 0, -scale]]))
  return {
    run_id: 'run-1', state: 'completed', recipe, warnings: [],
    traces: { x: [0, 0.01, 0.02, 0.03], series: { ...series(1), ...Object.fromEntries(channels.map((name) => [`${name} raw`, [0, 2, 0, -2]])) }, x_unit: 's', y_unit: 'µV' },
    spectrum: {
      frequency_hz: frequency, raw_power: raw, filtered_power: filtered,
      raw_power_by_channel: Object.fromEntries(channels.map((name) => [name, raw])),
      filtered_power_by_channel: Object.fromEntries(channels.map((name) => [name, filtered])),
      unit: 'µV²/Hz',
    },
    filter_response: { frequency_hz: frequency, gain_db: [-40, 0, 0, -3, -40] },
    mixing_matrix: channels.map(() => [0.5, 0.5, 0.5]),
    peak_frequencies_hz: [2, 10, 40], truth_peaks_hz: [2, 10, 60], retained_variance_pct: 90,
    provenance: { recipe_hash: 'test', created_at: '', engine_version: 'test', numpy_version: '', scipy_version: '', seed: 1, sampling_rate_hz: recipe.simulation.sampling_rate_hz, units: 'µV', reference: recipe.preprocessing.reference, rank: 4 },
  } as unknown as ExperimentResult
}

describe('Lab 01 prediction loop', () => {
  beforeEach(() => {
    window.localStorage.clear()
    api.checkHealth.mockResolvedValue(true)
    api.runRecipe.mockImplementation(async (recipe: ExperimentRecipe) => fakeResult(recipe))
  })
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('requires a prediction or an explicit skip before generating', () => {
    render(<App />)
    const generate = screen.getByRole('button', { name: /EEG 생성\(Generate\)/ })
    expect(generate).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /예측 없이 진행/ }))
    expect(generate).toBeEnabled()
  })

  it('applies a Try this card, grades the prediction and marks the card complete', async () => {
    render(<App />)
    const tryThis = screen.getByRole('region', { name: /실험 과제/ })
    fireEvent.click(within(tryThis).getByRole('button', { name: /표본화율을 100 Hz로 낮추기/ }))
    expect(screen.getByText('표본화율을 100 Hz로 낮추면 처리 전(Raw) 스펙트럼의 60 Hz 봉우리는?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: '40 Hz에 나타난다' }))
    fireEvent.click(screen.getByRole('button', { name: /EEG 생성\(Generate\)/ }))
    await waitFor(() => expect(api.runRecipe).toHaveBeenCalledTimes(1))
    expect(api.runRecipe.mock.calls[0]![0].simulation.sampling_rate_hz).toBe(100)

    const reveal = await screen.findByRole('button', { name: /예측과 대조하기/ })
    await waitFor(() => expect(reveal).toBeEnabled())
    fireEvent.click(reveal)
    expect(await screen.findByText('예측이 맞았습니다')).toBeInTheDocument()
    expect(within(tryThis).getByText('1 / 7 완료')).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem('neurosignal-lab01-completed-experiments') ?? '[]')).toContain('alias-100')
  })

  it('keeps sliders silent before reveal, then previews instantly and confirms with the server', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('radio', { name: /2 Hz와 10 Hz는 남고/ }))
    fireEvent.click(screen.getByRole('button', { name: /EEG 생성\(Generate\)/ }))
    await waitFor(() => expect(api.runRecipe).toHaveBeenCalledTimes(1))
    const reveal = await screen.findByRole('button', { name: /예측과 대조하기/ })
    await waitFor(() => expect(reveal).toBeEnabled())
    expect(screen.getByText(/예측을 공개하고 나면 슬라이더가 즉시 반응합니다/)).toBeInTheDocument()

    fireEvent.click(reveal)
    fireEvent.change(screen.getByRole('slider', { name: 'Sampling rate' }), { target: { value: '100' } })
    expect(await screen.findByText('미리보기 · 브라우저 계산')).toBeInTheDocument()
    expect(screen.getByText(/60 Hz →/).textContent).toContain('40 Hz')
    expect(screen.getByText('심어 둔 원천이 접힙니다(aliasing)')).toBeInTheDocument()

    await waitFor(() => expect(api.runRecipe).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(api.runRecipe.mock.calls[1]![0].simulation.sampling_rate_hz).toBe(100)
    await waitFor(() => expect(screen.queryByText('미리보기 · 브라우저 계산')).not.toBeInTheDocument())
    // The graded feedback from before exploring stays as it was.
    expect(screen.getByText('예측이 맞았습니다')).toBeInTheDocument()
  })
})
