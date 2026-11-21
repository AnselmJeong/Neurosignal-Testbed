import { describe, expect, it } from 'vitest'

import { presetWinners } from '../../lessons/scoreboard'
import { BENCH_PRESETS, benchmarkScoreRows } from './scoreboard'
import resultsJson from './fixtures/jr-preview-results.sample.json'
import type { BenchmarkCapabilities, ExperimentResults } from './types'

// Real output of the jr-core-preview recipe (3 seeds), trimmed: see fixtures/.
const results = resultsJson as unknown as ExperimentResults
const capabilities = { metrics: { M14: { name: 'PLV' }, M17: { name: 'wPLI' }, M23: { name: 'wSMI' } } } as unknown as BenchmarkCapabilities

describe('benchmark scoreboard', () => {
  it('scores each metric at its best band with within-metric ratios only', () => {
    const rows = benchmarkScoreRows(results, capabilities)
    const plv = rows.find((row) => row.id === 'M14')!
    const wpli = rows.find((row) => row.id === 'M17')!
    expect(plv.label).toBe('PLV · alpha')
    expect(plv.cells.edges!.display).toBe('0.94')
    expect(plv.cells.survives!.display).toBe('12%')
    expect(plv.cells.volume!.display).toBe('+80%')
    expect(wpli.cells.volume!.display).toBe('−4%')
    expect(wpli.cells.survives!.display).toBe('부호 뒤집힘')
    expect(wpli.cells.survives!.goodness).toBe(0)
  })

  it('crowns PLV for not missing and wPLI for not faking', () => {
    const winners = presetWinners(benchmarkScoreRows(results, capabilities), BENCH_PRESETS)
    expect(winners['no-miss']).toBe('M14')
    expect(winners['no-fake']).toBe('M17')
  })
})
