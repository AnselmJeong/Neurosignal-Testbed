// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultQeegRecipe, type QeegResult, type QeegSimulation } from '../lib/qeeg'
import { QeegWorkbench } from './QeegWorkbench'

const api = vi.hoisted(() => ({ generateQeegEeg: vi.fn(), simulateQeeg: vi.fn() }))
vi.mock('../lib/qeeg', async (original) => ({ ...await original<typeof import('../lib/qeeg')>(), ...api }))
vi.mock('./StackedEegBrowser', () => ({ StackedEegBrowser: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} /> }))
vi.mock('./QeegTopomap', () => ({ QeegTopomap: () => <div /> }))
const simulation: QeegSimulation = {
  recipe: { ...defaultQeegRecipe }, channel_names: ['O1', 'O2'], positions_2d: [[-.3, -.5], [.3, -.5]],
  positions_m: [], source_positions_m: [], leadfield_v_per_am: [], conductivities_s_m: [.33, 1, .004, .33],
  time_s: [0, .01], eeg_uv: [[0, 1], [0, -1]], source_nam: [],
  provenance: { engine: 'test', mne: 'test', numpy: '', scipy: '', sfreq: 128, duration_s: 32 },
}
const norm = { subject: [[1, 1]], mean: [[1, 1]], sd: [[1, 1]], z: [[0, 0]], percentile: [[50, 50]], cohort_values: [[[1, 1]]] }
const result: QeegResult = {
  ...simulation, provenance: { ...simulation.provenance, welch_segments: 15 },
  metrics: { frequency_hz: [10], psd: [[1], [1]], absolute: [[1, 1]], relative: [[1, 1]], theta_beta: [1, 1], alpha_peak_hz: [10, 10], median_hz: [10, 10], sef95_hz: [10, 10], entropy: [0, 0] },
  atlas_absolute: [[1, 2]], atlas_relative: [[.1, .2]], bands: [{ name: 'alpha', low: 8, high: 13 }],
  norms: { absolute: norm, relative: norm, theta_beta: norm }, coherence: [[1, 0], [0, 1]], plv: [[1, 0], [0, 1]], frontal_alpha_asymmetry: 0,
}
afterEach(cleanup)
beforeEach(() => {
  api.generateQeegEeg.mockReset().mockResolvedValue(structuredClone(simulation))
  api.simulateQeeg.mockReset().mockResolvedValue(structuredClone(result))
})
const mount = () => render(<QeegWorkbench activeLab="qeeg" onLabChange={vi.fn()} />)
async function generate() {
  fireEvent.click(screen.getByRole('button', { name: '1 · Generate EEG' }))
  await screen.findByText('EEG ready. Inspect the traces, then generate QEEG maps.')
}
async function maps() {
  fireEvent.click(screen.getByRole('button', { name: '2 · Generate QEEG maps' }))
  await screen.findByText('Maps ready. Explore power, metrics and synthetic norms.')
}
describe('QEEG staged workflow', () => {
  it('waits for explicit generation, opens EEG first and analyzes only on the second action', async () => {
    mount()
    expect(api.generateQeegEeg).not.toHaveBeenCalled()
    expect(api.simulateQeeg).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '2 · Generate QEEG maps' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: 'Atlas' })).toBeDisabled()
    await generate()
    expect(api.simulateQeeg).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: 'EEG' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('img', { name: 'Simulated QEEG multichannel recording' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Geometry' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: 'Norms' })).toBeDisabled()
    await maps()
    expect(api.simulateQeeg).toHaveBeenCalledExactlyOnceWith(simulation.recipe)
    expect(screen.getByRole('tab', { name: 'Atlas' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Norms' })).toBeEnabled()
  })

  it('requires new EEG after settings change and clears the previous maps on generation', async () => {
    mount(); await generate(); await maps()
    fireEvent.change(screen.getByLabelText('Subject seed'), { target: { value: '43' } })
    expect(screen.getByRole('button', { name: '2 · Generate QEEG maps' })).toBeDisabled()
    api.generateQeegEeg.mockResolvedValue({ ...simulation, recipe: { ...simulation.recipe, seed: 43 } })
    await generate()
    expect(screen.getByRole('tab', { name: 'Atlas' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: 'EEG' })).toHaveAttribute('aria-selected', 'true')
    expect(api.generateQeegEeg.mock.calls[1]![0].seed).toBe(43)
    expect(api.simulateQeeg).toHaveBeenCalledTimes(1)
    await maps()
    expect(api.simulateQeeg.mock.calls[1]![0].seed).toBe(43)
  })

  it('keeps the recording inspectable after analysis failure and retries only analysis', async () => {
    mount(); await generate()
    api.simulateQeeg.mockRejectedValueOnce(new Error('Analysis unavailable'))
    fireEvent.click(screen.getByRole('button', { name: '2 · Generate QEEG maps' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Analysis unavailable')
    expect(screen.getByRole('tab', { name: 'Atlas' })).toBeDisabled()
    expect(screen.getByRole('img', { name: 'Simulated QEEG multichannel recording' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Maps ready. Explore power, metrics and synthetic norms.')
    expect(api.generateQeegEeg).toHaveBeenCalledTimes(1)
    expect(api.simulateQeeg).toHaveBeenCalledTimes(2)
  })

  it('locks both actions and settings during generation and supports retry on failure', async () => {
    let reject!: (reason: Error) => void
    api.generateQeegEeg.mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
    mount()
    fireEvent.click(screen.getByRole('button', { name: '1 · Generate EEG' }))
    expect(screen.getByRole('button', { name: '1 · Generating EEG…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '2 · Generate QEEG maps' })).toBeDisabled()
    expect(screen.getByLabelText('Subject seed')).toBeDisabled()
    reject(new Error('Generation unavailable'))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('EEG ready. Inspect the traces, then generate QEEG maps.')
    expect(api.simulateQeeg).not.toHaveBeenCalled()
  })
})
