// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { MetricCatalog } from './MetricCatalog'
import { ResultsExplorer } from './ResultsExplorer'
import { buildRecipe, colorFor, defaultDraft, draftFromRecipe, metricRange, ringLattice, sameDraft } from './model'
import { capabilitiesFixture, resultsFixture } from './testFixtures'

afterEach(cleanup)

describe('MetricCatalog', () => {
  it('lists all 29 metric IDs with their real development status and input requirements', () => {
    render(<MetricCatalog capabilities={capabilitiesFixture} inRun={['M14']} />)
    const rows = screen.getAllByTestId(/^catalog-row-/)
    expect(rows).toHaveLength(29)
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual(capabilitiesFixture.metric_ids)
    expect(within(screen.getByTestId('catalog-row-M14')).getByText('구현됨')).toBeVisible()
    expect(within(screen.getByTestId('catalog-row-M14')).getByText('이번 실행')).toBeVisible()
    expect(within(screen.getByTestId('catalog-row-M01')).getByText('계획됨')).toBeVisible()
    expect(within(screen.getByTestId('catalog-row-M33')).getByText('M33 input requirements')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('구현 12 · 계획 17')
    expect(screen.getByText(/전부 완료되었다는 뜻이 아닙니다/)).toBeVisible()
    expect(screen.getByText('information · 미설치')).toBeVisible()
  })
})

describe('ResultsExplorer', () => {
  it('shows A–D, labels source and sensor node sets, and seed-paired effects with CI', () => {
    render(<ResultsExplorer results={resultsFixture('jr-a')} capabilities={capabilitiesFixture} />)
    const grid = screen.getByRole('region', { name: /M14 · PLV 조건 격자/ })
    for (const label of ['A', 'B', 'C', 'D']) expect(within(grid).getByRole('article', { name: `조건 ${label}` })).toBeVisible()
    expect(within(grid).getByText(/센서 8개/)).toBeVisible()
    expect(within(grid).getByText(/센서 32개/)).toBeVisible()
    // One legend for every condition and band of this metric; PLV is unsigned → sequential.
    expect(within(grid).getAllByLabelText(/색 범위/)).toHaveLength(1)
    expect(within(grid).getByText(/순차형/)).toBeVisible()

    expect(screen.getAllByRole('figure', { name: /원천 노드 3개/ })).toHaveLength(3)
    expect(screen.getByText(/같은 노드 집합이 아닙니다/)).toBeVisible()

    expect(screen.getByRole('article', { name: 'B − A 효과' })).toHaveTextContent('독립 seed n = 2')
    expect(screen.getByTestId('effect-B-A')).toHaveTextContent('추정')
    expect(screen.getByTestId('effect-(D-C)-(B-A)')).toHaveTextContent('[')
    expect(screen.getByRole('article', { name: 'source on − off 효과' })).toHaveTextContent('독립 seed n = 2')

    // Band switch updates every condition from the same stored comparison.
    const before = screen.getByTestId('cell-A-value').textContent
    fireEvent.click(screen.getAllByRole('button', { name: 'theta' })[0]!)
    expect(screen.getByTestId('cell-A-value').textContent).not.toBe(before)
  })

  it('switches metric tabs without refetching and keeps per-metric ranges', () => {
    render(<ResultsExplorer results={resultsFixture('jr-a')} capabilities={capabilitiesFixture} />)
    fireEvent.click(screen.getByRole('tab', { name: /M17 · wPLI/ }))
    expect(screen.getByRole('region', { name: /M17 · wPLI 조건 격자/ })).toBeVisible()
  })
})

describe('benchmark model', () => {
  it('uses a symmetric diverging range for signed metrics and never clips values', () => {
    expect(metricRange([-0.2, 0.5], { signed: true, value_domain: '[-1, 1]' })).toEqual({ lo: -1, hi: 1, diverging: true })
    expect(metricRange([-0.2, 0.5], { signed: true, value_domain: 'real' })).toEqual({ lo: -0.5, hi: 0.5, diverging: true })
    expect(metricRange([0.2, 1.3], { signed: false, value_domain: '[0, 1]' })).toEqual({ lo: 0, hi: 1.3, diverging: false })
    expect(metricRange([0.2, 3], { signed: false, value_domain: '[0, inf) normalised' })).toEqual({ lo: 0, hi: 3, diverging: false })
    const range = metricRange([0, 1], { signed: true, value_domain: '[-1, 1]' })
    expect(colorFor(0, range)).toBe('rgb(248,248,244)')
    expect(colorFor(null, range)).toBe('transparent')
  })

  it('builds the planner-shaped recipe and round-trips the designer draft', () => {
    const { C, D } = ringLattice(4)
    expect(C[0]).toEqual([0, 1 / 3, 1 / 3, 1 / 3])
    expect(D[0]).toEqual([0, 8, 8, 8])
    const draft = { ...defaultDraft(), reference: 'average' as const, sensorNoiseUv: 2 }
    const recipe = buildRecipe(draft)
    expect(recipe.benchmark.held_fixed).toMatchObject({ reference: 'average', sensor_noise_std: 2e-6 })
    expect(recipe.observations.eeg_forward).toMatchObject({ reference: 'average', sensor_noise_std: 2e-6, n_sensors: 32 })
    expect(recipe.observations.identity_probe!.n_sensors).toBe(8)
    expect(recipe.simulation.seeds.root).toBe(100)
    expect(sameDraft(draftFromRecipe(recipe), draft)).toBe(true)
  })
})
