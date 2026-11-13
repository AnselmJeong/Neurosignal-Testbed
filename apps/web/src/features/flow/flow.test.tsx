// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ConceptPrimer } from './ConceptPrimer'
import { MethodCards } from './MethodCards'
import {
  buildFlowRecipe,
  defaultFlowDraft,
  draftFromRecipe,
  findDataset,
  formulaParts,
  netFlows,
  simplifyLatex,
  stageProgress,
  truthCells,
} from './model'
import { SensorSourceComparison } from './SensorSourceComparison'
import { conceptsFixture, resultFixture } from './testFixtures'
import type { FlowResult } from './types'

afterEach(cleanup)

const dataset = (result: FlowResult, id: string) => {
  const [space = '', condition = ''] = id.split('/')
  const found = findDataset(result, space, condition)
  if (!found) throw new Error(`fixture has no ${id}`)
  return found
}

describe('flow model', () => {
  it('builds a recipe that changes only simulation/observation knobs and round-trips the draft', () => {
    const draft = { ...defaultFlowDraft(), G: 12, reference: 'both' as const, nSensors: 16, highpassPhase: 'zero_phase' as const }
    const recipe = buildFlowRecipe(draft)
    expect(recipe.simulation.G).toBe(12)
    expect(recipe.simulation.control_G).toBe(0)
    expect(recipe.observation.references).toEqual(['none', 'average'])
    expect(recipe.preprocessing.highpass_phase).toBe('zero_phase')
    expect(recipe.graph.edges).toContainEqual(['C', 'E'])
    expect(JSON.stringify(recipe.analysis)).not.toMatch(/->/)
    expect(recipe).not.toHaveProperty('tasks')
    expect(draftFromRecipe(recipe)).toEqual(draft)
  })

  it('maps real pipeline stage strings to progress', () => {
    const recipe = buildFlowRecipe(defaultFlowDraft())
    expect(stageProgress('queued', 'queued', recipe).fraction).toBeLessThan(0.05)
    expect(stageProgress('simulate: TVB Jansen-Rit coupled + control', 'running', recipe).label).toMatch(/시뮬레이션/)
    const third = stageProgress('analyse source/control (8 channels)', 'running', recipe)
    expect(third.label).toContain('3/4')
    expect(third.fraction).toBeGreaterThan(stageProgress('analyse sensor-none/coupled (32 channels)', 'running', recipe).fraction)
    expect(stageProgress('evaluate (source space only)', 'running', recipe).fraction).toBeGreaterThan(0.9)
    expect(stageProgress('done', 'completed', recipe).fraction).toBe(1)
  })

  it('renders catalog LaTeX as readable text with sub/superscripts', () => {
    expect(simplifyLatex('TE_{A\\rightarrow B}=I(A_{\\mathrm{past}};B_{\\mathrm{future}}\\mid B_{\\mathrm{past}})'))
      .toBe('TE_{A→B}=I(A_{past};B_{future} | B_{past})')
    expect(simplifyLatex('F=\\ln\\frac{\\operatorname{var}(a)}{\\operatorname{var}(b)}')).toBe('F=ln(var(a))/(var(b))')
    const parts = formulaParts('\\hat a_j=\\sum_{i\\ne j}FC_{ij}\\,a_i')
    expect(parts.filter((part) => part.kind === 'sub').map((part) => part.text)).toEqual(['j', 'i≠j', 'ij', 'i'])
    expect(parts.map((part) => part.text).join('')).toContain('Σ')
    for (const entry of conceptsFixture.entries) {
      if (entry.formula) expect(simplifyLatex(entry.formula), entry.id).not.toContain('\\')
    }
  })

  it('outlines truth only in source space with G > 0', () => {
    const result = resultFixture()
    const edges = result.recipe.graph.edges
    expect(truthCells(dataset(result, 'source/coupled'), edges).size).toBe(7)
    expect(truthCells(dataset(result, 'source/control'), edges).size).toBe(0)
    expect(truthCells(dataset(result, 'sensor-none/coupled'), edges).size).toBe(0)
  })

  it('derives net flows from [target][source] values without abs-clipping the inputs', () => {
    const result = resultFixture()
    const source = dataset(result, 'source/coupled')
    const method = source.methods.gc_conditional!
    const flows = netFlows(source, method.values, method.p_values, method.significance!.bonferroni_threshold)
    const p1p2 = flows.find((flow) => [flow.from, flow.to].sort().join() === 'P1,P2')!
    expect(p1p2.from).toBe('P1')
    expect(p1p2.to).toBe('P2')
    expect(p1p2.significant).toBe(true)
    expect(p1p2.forward).toBeGreaterThan(p1p2.backward)
  })
})

describe('ConceptPrimer', () => {
  it('renders the SC/FC/EC/IF table and the Level 1-3 framework from the concepts catalog', () => {
    render(<ConceptPrimer catalog={conceptsFixture} error={null} />)
    const table = screen.getByRole('table')
    for (const id of ['structural_connectivity', 'functional_connectivity', 'directed_effective_connectivity', 'information_flow']) {
      expect(within(table).getByTestId(`concept-row-${id}`)).toBeVisible()
    }
    expect(within(screen.getByTestId('concept-row-structural_connectivity')).getByText('해당 없음')).toBeVisible()
    expect(screen.getByTestId('level-1')).toHaveTextContent('Direction')
    expect(screen.getByTestId('level-2')).toHaveTextContent('해당 없음')
    expect(screen.getByTestId('level-3')).toHaveTextContent('PID')
    expect(screen.getByText(conceptsFixture.summary)).toBeVisible()
  })

  it('reports a catalog failure instead of rendering empty concepts', () => {
    render(<ConceptPrimer catalog={null} error="HTTP 500" />)
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500')
  })
})

describe('MethodCards', () => {
  it('renders one card per method with question, formula, result and limitations', () => {
    const result = resultFixture()
    render(<MethodCards result={result} dataset={dataset(result, 'source/coupled')} catalog={conceptsFixture} />)
    for (const id of ['granger_causality', 'transfer_entropy', 'effective_model', 'activity_flow', 'pid', 'level2_content']) {
      const card = screen.getByTestId(`card-${id}`)
      const concept = conceptsFixture.entries.find((entry) => entry.id === id)!
      expect(within(card).getByText(concept.question_answered)).toBeInTheDocument()
      expect(within(card).getByText(concept.limitations[0]!)).toBeInTheDocument()
    }
    const gc = screen.getByTestId('card-granger_causality')
    expect(within(gc).getByRole('img', { name: /조건부 GC 행렬 \[target × source\]/ })).toBeInTheDocument()
    expect(within(gc).getByTestId('gc-significant')).toHaveTextContent('19 / 56')
    expect(gc.querySelectorAll('[data-truth="true"]')).toHaveLength(7)
    expect(gc.querySelector('[data-flow="P1->P2"]')).not.toBeNull()
    expect(within(gc).getByTestId('fp-conditional GC')).toHaveTextContent('12 / 49')

    fireEvent.click(within(gc).getByRole('button', { name: '쌍별 GC' }))
    expect(within(gc).getByTestId('gc-significant')).toHaveTextContent('25 / 56')

    // Honest effective-model lesson: the linear model picked the wrong model on pair and convergence.
    expect(screen.getByTestId('best-pair_P1_P2')).toHaveTextContent('양방향')
    expect(screen.getByTestId('effective-lesson')).toHaveTextContent('pair_P1_P2(양방향≠정방향)')
    expect(screen.getByTestId('effective-lesson')).toHaveTextContent('사후확률이 높아도')

    // Activity flow reports r for Pearson FC and explains why not R².
    expect(screen.getByTestId('af-mean-r')).toHaveTextContent('0.34')
    expect(screen.getByTestId('af-why-r')).toHaveTextContent('R²는 크게 음수')

    // PID: real I_min COPY gives R=1, S=1 bit; BROJA reference row gives U1=U2=1.
    expect(screen.getByTestId('pid-COPY-redundancy')).toHaveTextContent('1.000')
    expect(screen.getByTestId('pid-COPY-synergy')).toHaveTextContent('1.000')
    expect(screen.getByTestId('pid-COPY · BROJA/I_ccs-unique1')).toHaveTextContent('1.000')
    expect(screen.getByTestId('pid-measure-lesson')).toHaveTextContent('측도')

    // Level 2 content is explicitly not applicable, not zero.
    const level2 = screen.getByTestId('card-level2_content')
    expect(within(level2).getAllByText('해당 없음').length).toBeGreaterThan(0)
    expect(within(level2).getByText('no_stimulus_labels')).toBeVisible()
  })

  it('shows status and reason for a method that was not computed, never a value', () => {
    const result = resultFixture()
    const sensor = dataset(result, 'sensor-none/coupled')
    sensor.methods.gc_conditional = {
      ...sensor.methods.gc_conditional!,
      status: 'invalid_input', reason_code: 'rank_deficient', message: 'average reference removes one rank', values: [], p_values: [],
    }
    render(<MethodCards result={result} dataset={sensor} catalog={conceptsFixture} />)
    const gc = screen.getByTestId('card-granger_causality')
    expect(within(gc).getByText('rank_deficient')).toBeVisible()
    expect(within(gc).getByText('average reference removes one rank')).toBeVisible()
    expect(within(gc).queryByRole('img', { name: /조건부 GC 행렬/ })).not.toBeInTheDocument()
    expect(within(gc).getAllByText('입력 부적합').length).toBeGreaterThan(0)

    // Sensor space: matrices but no truth outlines or truth scores.
    fireEvent.click(within(gc).getByRole('button', { name: '쌍별 GC' }))
    expect(within(gc).getByRole('img', { name: /쌍별 GC 행렬/ })).toBeInTheDocument()
    expect(gc.querySelectorAll('[data-truth="true"]')).toHaveLength(0)
    expect(within(gc).queryByLabelText(/정답 비교/)).not.toBeInTheDocument()
    expect(within(gc).getByText(/센서 채널은 소스가 아니므로/)).toBeVisible()
  })
})

describe('SensorSourceComparison', () => {
  it('contrasts spurious directed links at G=0 in source vs sensor space', () => {
    const result = resultFixture()
    render(<SensorSourceComparison result={result} catalog={conceptsFixture} />)
    const headline = screen.getByTestId('compare-headline')
    expect(headline).toHaveTextContent('G=0.0')
    expect(headline).toHaveTextContent('소스 4%')
    expect(headline).toHaveTextContent('센서 · reference 없음 59%')
    expect(screen.getByTestId('compare-row-sensor-none/control')).toHaveTextContent('59%')
    expect(screen.getAllByRole('img', { name: /쌍별 GC/ })).toHaveLength(2)
    expect(document.querySelectorAll('[data-truth="true"]')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '결합 켬' }))
    expect(document.querySelectorAll('[data-truth="true"]')).toHaveLength(7)
    expect(screen.getByText(result.evaluation!.lessons[0]!)).toBeVisible()
  })
})
