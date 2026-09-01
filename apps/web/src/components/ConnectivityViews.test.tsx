// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ConnectivityEdge, ConnectivityMatrix } from '../types'
import { CircleNetwork, ConnectivityHeatmap } from './ConnectivityViews'

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
