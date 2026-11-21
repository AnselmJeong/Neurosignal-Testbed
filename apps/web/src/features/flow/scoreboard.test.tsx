// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { MethodScoreboard } from '../../components/MethodScoreboard'
import { presetWinners, rankRows, speedGoodness, weightedScore } from '../../lessons/scoreboard'
import { FLOW_CRITERIA, FLOW_PRESETS, flowScoreRows } from './scoreboard'
import { resultFixture } from './testFixtures'

describe('flow scoreboard', () => {
  afterEach(cleanup)

  it('turns the truth evaluation into one row per method', () => {
    const rows = flowScoreRows(resultFixture())
    const conditional = rows.find((row) => row.id === 'gc_conditional')!
    expect(rows.map((row) => row.id)).toEqual(['gc_pairwise', 'gc_conditional', 'te_gaussian', 'te_ksg', 'effective_model'])
    expect(conditional.cells.auc!.display).toBe('0.95')
    expect(conditional.cells.missed!.display).toBe('0/7')
    expect(conditional.cells.false_positive!.display).toBe('12/49')
    expect(conditional.cells.volume!.display).toBe('44%')
    // KSG TE has no Bonferroni significance: its missing cells are skipped, not scored as 0.
    const ksg = rows.find((row) => row.id === 'te_ksg')!
    expect(ksg.cells.false_positive!.goodness).toBeNull()
    expect(weightedScore(ksg, { false_positive: 1 })).toBeNull()
  })

  it('crowns a different method when the learner changes what matters', () => {
    const winners = presetWinners(flowScoreRows(resultFixture()), FLOW_PRESETS)
    expect(new Set(Object.values(winners)).size).toBeGreaterThan(1)
    expect(winners['no-false-positive']).toBe('gc_conditional')
    expect(winners.fast).not.toBe('te_ksg')
  })

  it('scores speed on a log scale and ranks by weighted goodness', () => {
    expect(speedGoodness([0.01, 0.1, 1, null])).toEqual([1, 0.5, 0, null])
    const rows = [
      { id: 'a', label: 'A', cells: { x: { display: '', goodness: 1 }, y: { display: '', goodness: 0 } } },
      { id: 'b', label: 'B', cells: { x: { display: '', goodness: 0 }, y: { display: '', goodness: 1 } } },
    ]
    expect(rankRows(rows, { x: 1, y: 0 })[0]!.row.id).toBe('a')
    expect(rankRows(rows, { x: 0, y: 1 })[0]!.row.id).toBe('b')
  })

  it('re-ranks the table when a preset or a slider changes', () => {
    render(<MethodScoreboard title="점수판" rows={flowScoreRows(resultFixture())} criteria={FLOW_CRITERIA} presets={FLOW_PRESETS}
      scatter={{ x: 'false_positive', y: 'missed', xLabel: '거짓 양성 비율', yLabel: '놓친 간선 비율', goodCorner: '왼쪽 아래가 좋음', xMax: 1, yMax: 1 }} howScored={['정답 격리']} />)
    const firstRow = () => within(screen.getAllByRole('row')[1]!).getByRole('rowheader').textContent
    fireEvent.click(screen.getByRole('button', { name: /거짓 양성이 가장 싫다/ }))
    expect(firstRow()).toBe('조건부 GC')
    fireEvent.click(screen.getByRole('button', { name: /빨라야 한다/ }))
    expect(firstRow()).not.toBe('KSG TE')
    fireEvent.change(screen.getByRole('slider', { name: '계산 시간 중요도' }), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: /빨라야 한다/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText(/1위가 \d번 바뀝니다/)).toBeVisible()
    expect(screen.getByRole('img', { name: '놓친 간선 비율 대 거짓 양성 비율 산점도' })).toBeVisible()
  })
})
