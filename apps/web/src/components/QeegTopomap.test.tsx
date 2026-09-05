import { describe, expect, it } from 'vitest'
import { interpolateScalp } from './QeegTopomap'

describe('QEEG scalp interpolation', () => {
  const positions: [number, number][] = [[-.5, 0], [.5, 0], [0, .5]]
  it('preserves a spatially constant metric, including peripheral extrapolation', () => {
    expect(interpolateScalp(.9, 0, positions, [3, 3, 3])).toBeCloseTo(3, 12)
  })
  it('preserves left/right orientation and never invents values outside sensor extrema', () => {
    const values = [1, 9, 4]
    expect(interpolateScalp(-.5, 0, positions, values)).toBeCloseTo(1, 5)
    expect(interpolateScalp(.5, 0, positions, values)).toBeCloseTo(9, 5)
    for (let x = -1; x <= 1; x += .1) {
      const value = interpolateScalp(x, .2, positions, values)
      expect(value).toBeGreaterThanOrEqual(1)
      expect(value).toBeLessThanOrEqual(9)
    }
  })
})
