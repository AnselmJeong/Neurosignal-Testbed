// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ConnectivityEdge, ConnectivityMatrix } from '../types'
import { CircleNetwork, ConnectivityDifference, ConnectivityHeatmap, ScalpNetwork, connectivityColor } from './ConnectivityViews'

const matrix = {
  node_names: ['Frontal L', 'Frontal R', 'Posterior L', 'Posterior R'],
  values: [
    [0, 0.72, 0.08, 0.04],
    [0.72, 0, 0.06, 0.03],
    [0.08, 0.06, 0, 0.1],
    [0.04, 0.03, 0.1, 0],
  ],
  space: 'latent',
  metric: 'imcoh',
  band_hz: [8, 12],
} satisfies ConnectivityMatrix

const edges = [
  {
    source: 'Frontal L',
    target: 'Frontal R',
    weight: 0.72,
    detected: true,
    is_true: true,
  },
] satisfies ConnectivityEdge[]

describe('connectivity visualizations', () => {
  it('exposes every matrix value and its threshold state', () => {
    render(<ConnectivityHeatmap matrix={matrix} threshold={0.4} />)
    expect(screen.getByRole('img', { name: /latent imcoh connectivity matrix/i })).toBeVisible()
    expect(screen.getByTitle('Frontal L – Frontal R: 0.720')).toHaveClass('detected')
  })

  it('uses redundant truth styling for a revealed circular edge', () => {
    render(
      <CircleNetwork
        matrix={matrix}
        edges={edges}
        threshold={0.4}
        truthVisible
      />,
    )
    expect(screen.getByRole('img', { name: /circular network with 1 edges/i })).toBeVisible()
    expect(document.querySelector('.network-edge.true-edge')).not.toBeNull()
  })
})


it('uses the matrix weight color for sensor edges and excludes undetected edges', () => {
  const { container } = render(<ScalpNetwork matrix={{ ...matrix, space: 'sensor' }} edges={[{ ...edges[0]!, is_true: null }, { source: 'Frontal R', target: 'Posterior R', weight: 0.1, detected: false, is_true: null }]} threshold={0.4} truthVisible={false} />)
  const lines = container.querySelectorAll('.network-edge')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toHaveStyle({ stroke: connectivityColor(0.72) })
})

it('shows signed B minus A values with a separate symmetric scale', () => {
  const b = { ...matrix, values: matrix.values.map(row => row.map(value => value / 2)) }
  render(<ConnectivityDifference a={matrix} b={b} />)
  expect(screen.getByRole('img', { name: /fixed scale minus 1 to plus 1/ })).toBeVisible()
  expect(screen.getByTitle('Frontal L – Frontal R: B − A = -0.360')).toHaveTextContent('-0.36')
  expect(screen.getByText('−1 · decreased')).toBeVisible()
  expect(screen.getByText('+1 · increased')).toBeVisible()
})
