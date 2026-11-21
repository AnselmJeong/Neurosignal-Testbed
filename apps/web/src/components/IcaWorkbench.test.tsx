// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultIcaRecipe } from '../types'
import { IcaWorkbench } from './IcaWorkbench'
import { StackedEegBrowser, StackedEegComparison } from './StackedEegBrowser'

// Exercise the real viewer with its SVG renderer: jsdom has no Canvas context.
vi.mock('@neurosignal/trace-viewer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@neurosignal/trace-viewer')>()
  return { ...actual, TraceViewer: (props: React.ComponentProps<typeof actual.TraceViewer>) => <actual.TraceViewer {...props} renderer="svg" /> }
})

const simulateIcaMock = vi.fn()
const fitIcaMock = vi.fn()

vi.mock('../lib/api', () => ({
  applyIca: vi.fn(),
  fitIca: (...args: unknown[]) => fitIcaMock(...args),
  simulateIca: (...args: unknown[]) => simulateIcaMock(...args),
}))

describe('IcaWorkbench flow', () => {
  afterEach(cleanup)
  beforeEach(() => {
    simulateIcaMock.mockReset()
    fitIcaMock.mockReset()
    simulateIcaMock.mockResolvedValue({
      run_id: 'ica_input_test',
      state: 'completed',
      recipe: defaultIcaRecipe,
      sensor_trace: {
        x: [0, 0.004, 0.008],
        series: {
          Fp1: [0, 4, 0], Fp2: [0, 3.8, 0], F7: [0, 2, 0], F8: [0, 1.8, 0],
          C3: [0, 1, 0], C4: [0, 0.9, 0], O1: [0, 0.5, 0], O2: [0, 0.4, 0],
        },
        x_unit: 's',
        y_unit: 'µV',
      },
      source_labels: ['alpha', 'theta', 'beta', 'blink'],
      channel_names: ['Fp1', 'Fp2', 'F7', 'F8', 'C3', 'C4', 'O1', 'O2'],
      rank: 7,
      provenance: {},
    })
    fitIcaMock.mockResolvedValue({
      run_id: 'ica_fit_control_test',
      state: 'completed',
      recipe: { ...defaultIcaRecipe, blink_amplitude_uv: 0 },
      warnings: [],
      raw_trace: { x: [0, 0.004, 0.008], series: { 'Contaminated · Fp1': [0, 0.1, 0] }, x_unit: 's', y_unit: 'µV' },
      components: [{
        index: 0,
        suggested_label: 'brain',
        suggestion_probability: 0.9,
        explained_variance_pct: 0.13,
        matched_truth: null,
        matched_correlation: null,
        time_s: [0, 0.004, 0.008],
        trace: [0, 0.1, 0],
        frequency_hz: [1, 2, 3],
        power: [0.1, 0.01, 0.001],
        topography: [0.1, -0.1, 0.2, -0.2, 0.1, -0.1, 0.05, -0.05],
      }],
      compatibility: {
        fingerprint: 'control',
        channel_names: ['Fp1', 'Fp2', 'F7', 'F8', 'C3', 'C4', 'O1', 'O2'],
        bad_channels: [],
        reference: 'average',
        rank: 7,
        fit_highpass_hz: 1,
      },
      blink_component_index: null,
      mean_matched_correlation: 0.98,
      icalabel_available: true,
      provenance: {},
    })
  })

  it('requires generated EEG before ICA fit and has no duplicate fit action', async () => {
    render(<IcaWorkbench activeLab="ica" onLabChange={vi.fn()} />)

    expect(screen.getByRole('button', { name: '생성한 EEG에 ICA 적합(Fit ICA)' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Fit default decomposition/i })).not.toBeInTheDocument()
    expect(screen.getByText('정리할 EEG부터 만듭니다.')).toBeVisible()
    expect(screen.getByText('네 단계로 신호를 따라갑니다.')).toBeVisible()
    expect(screen.queryByText(/NOW/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '시뮬레이션 EEG 생성(Generate)' }))

    expect(await screen.findByText('시뮬레이션 EEG · ICA 전에 살펴보기')).toBeVisible()
    expect(await screen.findByRole('img', { name: 'Eight-channel simulated contaminated EEG browser' })).toBeVisible()
    expect(screen.getByText('8채널 · 공통 이득')).toBeVisible()
    expect(simulateIcaMock).toHaveBeenCalledWith(defaultIcaRecipe)
    // Predict (or explicitly skip) before the fit that the truth will grade.
    expect(screen.getByRole('button', { name: '생성한 EEG에 ICA 적합(Fit ICA)' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /예측 없이 진행/ }))
    expect(screen.getByRole('button', { name: '생성한 EEG에 ICA 적합(Fit ICA)' })).toBeEnabled()
  })

  it('keeps ICA activation in arbitrary units', async () => {
    render(<StackedEegBrowser x={[0, 0.5, 1]} series={{ 'IC 1': [0, 2, 0] }} unit="a.u." ariaLabel="IC activation" />)
    expect(await screen.findByRole('img', { name: 'IC activation' })).toBeVisible()
    expect(screen.getByText(/SOURCE ±2.*a.u./)).toBeVisible()
  })

  it('shows an unmatched residual instead of a blink truth in the no-artifact control', async () => {
    window.localStorage.clear()
    render(<IcaWorkbench activeLab="ica" onLabChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /아티팩트 없는 대조군깜박임 진폭/ }))
    fireEvent.click(screen.getByRole('radio', { name: '한 성분은 대응하는 원천이 없다' }))
    fireEvent.click(screen.getByRole('button', { name: '시뮬레이션 EEG 생성(Generate)' }))
    expect(await screen.findByText('심어 둔 아티팩트')).toBeVisible()
    expect(screen.getByText('없음', { selector: '.simulation-summary span' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '생성한 EEG에 ICA 적합(Fit ICA)' }))
    fireEvent.click(await screen.findByRole('button', { name: '원천 정체 공개(Reveal)' }))

    expect(await screen.findByText('심어 둔 원천 없음')).toBeVisible()
    expect(screen.getByText(/남은 센서 잡음이나 분해 잔여분/)).toBeVisible()
    expect(screen.queryByText(/blink · r 0\.00/i)).not.toBeInTheDocument()
    expect(fitIcaMock).toHaveBeenCalledWith(expect.objectContaining({ blink_amplitude_uv: 0 }))
    expect(screen.getByText('예측이 맞았습니다')).toBeVisible()
    expect(screen.getByText(/대응하는 원천이 없습니다/)).toBeVisible()
    expect(screen.getByText('1 / 5 완료')).toBeVisible()
  })

  it('renders every channel in the before and after EEG comparison', async () => {
    const channelNames = ['Fp1', 'Fp2', 'F7', 'F8', 'C3', 'C4', 'O1', 'O2']
    const series = Object.fromEntries(channelNames.flatMap((channel) => [
      [`Before · ${channel}`, [0, 2, 0]],
      [`After · ${channel}`, [0, 1, 0]],
    ]))

    render(
      <StackedEegComparison
        x={[0, 0.5, 1]}
        series={series}
        channelNames={channelNames}
        ariaLabel="Eight-channel comparison test"
      />,
    )

    const comparison = await screen.findByRole('img', { name: 'Eight-channel comparison test' })
    expect(comparison).toBeVisible()
    channelNames.forEach((channel) => expect(within(comparison).getByText(channel)).toBeVisible())
    expect(screen.getByText('처리 전 · 생성한 EEG')).toBeVisible()
    expect(screen.getByText('처리 후 · 정리한 EEG')).toBeVisible()
    expect(screen.getByText('LOCKED SCALE')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Increase amplitude gain' }))
    expect(screen.getByText(/EEG ±1.*µV.*2×/)).toBeVisible()
  })
})
