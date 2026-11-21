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
    expect(screen.getByText('1 / 7 완료')).toBeVisible()
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
  it('runs the mixed-component card: four checks, composition and the cost of one exclusion', async () => {
    const channels = ['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'T7', 'C3', 'Cz', 'C4', 'T8', 'P7', 'P3', 'Pz', 'P4', 'P8', 'O1', 'O2']
    const multiRecipe = { ...defaultIcaRecipe, scenario: 'multi_artifact' as const, component_count: 10, mixed_component: true }
    simulateIcaMock.mockResolvedValue({
      run_id: 'ica_input_multi', state: 'completed', recipe: multiRecipe,
      sensor_trace: { x: [0, 0.004], series: Object.fromEntries(channels.map((name) => [name, [0, 1]])), x_unit: 's', y_unit: 'µV' },
      source_labels: ['alpha', 'theta', 'beta', 'blink', 'horizontal eye', 'muscle', 'heartbeat', 'bad electrode'],
      channel_names: channels, rank: 18, provenance: {},
    })
    const base = { time_s: [0, 0.004], trace: [0, 1], frequency_hz: [1, 2], power: [1, 0.1], topography: channels.map(() => 0.2), suggestion_probability: 0.9, explained_variance_pct: 10 }
    fitIcaMock.mockResolvedValue({
      run_id: 'ica_fit_multi', state: 'completed', recipe: multiRecipe, warnings: [],
      raw_trace: { x: [0, 0.004], series: { 'Contaminated · Fp1': [0, 1] }, x_unit: 's', y_unit: 'µV' },
      components: [
        { ...base, index: 0, suggested_label: 'eye blink', matched_truth: 'blink', matched_correlation: 0.9, matched_kind: 'artifact', truth_correlations: { blink: 0.9, theta: 0.36 }, artifact_removed_pct: 21.7, neural_loss_pct: 54.5, artifact_removed_by_type: { blink: 99.7 } },
        { ...base, index: 1, suggested_label: 'brain', matched_truth: 'bad electrode', matched_correlation: 0.99, matched_kind: 'artifact', truth_correlations: { 'bad electrode': 0.99 }, artifact_removed_pct: 8.9, neural_loss_pct: 2.8, artifact_removed_by_type: { 'bad electrode': 95.6 } },
        { ...base, index: 2, suggested_label: 'brain', matched_truth: 'alpha', matched_correlation: 0.99, matched_kind: 'neural', truth_correlations: { alpha: 0.99 }, artifact_removed_pct: 0, neural_loss_pct: 77.9, artifact_removed_by_type: {} },
        { ...base, index: 3, suggested_label: 'other', matched_truth: 'muscle', matched_correlation: 0.99, matched_kind: 'artifact', truth_correlations: { muscle: 0.99 }, artifact_removed_pct: 6.6, neural_loss_pct: 1.9, artifact_removed_by_type: { muscle: 100 } },
        { ...base, index: 4, suggested_label: 'other', matched_truth: null, matched_correlation: null, matched_kind: null, truth_correlations: {}, artifact_removed_pct: 0, neural_loss_pct: 0.2, artifact_removed_by_type: {} },
      ],
      compatibility: { fingerprint: 'multi', channel_names: channels, bad_channels: [], reference: 'average', rank: 18, fit_highpass_hz: 1 },
      blink_component_index: 0, mean_matched_correlation: 0.97, icalabel_available: true,
      artifact_labels: ['blink', 'horizontal eye', 'muscle', 'heartbeat', 'bad electrode'], provenance: {},
    })
    render(<IcaWorkbench activeLab="ica" onLabChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^섞인 성분/ }))
    expect(screen.getByRole('checkbox', { name: /섞인 성분 만들기/ })).toBeChecked()
    expect(screen.getByText(/센서 채널 19개로 섞습니다/)).toBeVisible()
    fireEvent.click(screen.getByRole('radio', { name: '절반쯤 잃는다' }))
    fireEvent.click(screen.getByRole('button', { name: '시뮬레이션 EEG 생성(Generate)' }))
    expect(await screen.findByRole('img', { name: 'Nineteen-channel simulated contaminated EEG browser' })).toBeVisible()
    expect(simulateIcaMock).toHaveBeenCalledWith(expect.objectContaining({ scenario: 'multi_artifact', mixed_component: true, component_count: 10 }))
    fireEvent.click(screen.getByRole('button', { name: '생성한 EEG에 ICA 적합(Fit ICA)' }))
    expect(await screen.findByRole('group', { name: '지형도(Topography) 판단' })).toBeVisible()
    expect(screen.getAllByRole('img', { name: /IC \d+ 두피 지형도/ }).length).toBeGreaterThanOrEqual(6)

    const checks = screen.getByRole('region', { name: '네 가지 확인' })
    expect(within(checks).getByText(/0\/4 확인/)).toBeVisible()
    for (const label of ['지형도(Topography)', '시계열(Time course)', '스펙트럼(Spectrum)']) {
      fireEvent.click(within(screen.getByRole('group', { name: `${label} 판단` })).getByRole('button', { name: '아티팩트' }))
    }
    fireEvent.click(within(screen.getByRole('group', { name: '분산과 참고 라벨 판단' })).getByRole('button', { name: '신경' }))
    expect(within(checks).getByText(/단서가 갈립니다/)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /원천 정체 공개/ }))
    expect(screen.getByText('예측이 맞았습니다')).toBeVisible()
    expect(screen.getByText('세타(theta) · r 0.36')).toBeVisible()
    expect(screen.getByText('신경 신호 54.5%')).toBeVisible()
    expect(screen.getByText('깜박임(blink) 100% 제거')).toBeVisible()
    expect(screen.getAllByText('섞임').length).toBe(1)
  })
})
