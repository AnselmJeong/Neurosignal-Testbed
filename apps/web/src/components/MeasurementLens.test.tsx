// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MeasurementLens } from './MeasurementLens'

const x = Array.from({ length: 1000 }, (_, i) => i / 250)
const before = x.map((t) => 40 * Math.sin(2 * Math.PI * 10 * t) + (t > 1.9 && t < 2.1 ? 150 : 0))
const after = x.map((t) => 40 * Math.sin(2 * Math.PI * 10 * t))
const view = { startTimeS: 0, durationS: 10, visibleMax: 73, gain: 1 }

afterEach(cleanup)

describe('MeasurementLens', () => {
  it('asks for a click and states the screen scale before a point is chosen', () => {
    render(<MeasurementLens x={x} channel={null} timeS={null} traces={[]} unit="µV" view={view} onClose={vi.fn()} />)
    expect(screen.getByText(/파형 위를 클릭하면/)).toBeTruthy()
    expect(screen.getByText('화면: 가로 10 s · 세로 줄마다 ±100 µV')).toBeTruthy()
  })

  it('reads before, after and the removed part at the cursor, with a scale bar', () => {
    render(
      <MeasurementLens
        x={x} channel="Fp1" timeS={2} unit="µV" view={view} removed onClose={vi.fn()}
        traces={[{ id: 'before', label: 'before', values: before, color: '#9a9d97', dashed: true }, { id: 'after', label: 'after', values: after, color: '#087f83' }]}
      />,
    )
    expect(screen.getByText('제거된 양').nextElementSibling?.textContent).toBe('150 µV')
    expect(screen.getByLabelText(/눈금 막대 \d+ µV, \d+ ms/)).toBeTruthy()
    expect(screen.getByText('어림 리듬').nextElementSibling?.textContent).toMatch(/≈ \d+\.\d Hz/)
  })
})
