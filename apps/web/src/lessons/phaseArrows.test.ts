import { describe, expect, it } from 'vitest'

import { epochPhases, lagMs, nullPlv, percentile, phaseMetrics } from './phaseArrows'

describe('phase primer arithmetic', () => {
  it('gives PLV 1 for identical phase differences and keeps the imaginary part for a lag', () => {
    const metrics = phaseMetrics([60, 60, 60, 60])
    expect(metrics.plv).toBeCloseTo(1)
    expect(metrics.imaginary).toBeCloseTo(Math.sin(Math.PI / 3))
    expect(metrics.wpli).toBeCloseTo(1)
    expect(metrics.ppc).toBeCloseTo(1)
  })

  it('discards zero-lag consistency in the imaginary metrics', () => {
    const metrics = phaseMetrics(epochPhases(24, 0, 0.05, 1))
    expect(metrics.plv).toBeGreaterThan(0.95)
    expect(metrics.imaginary).toBeLessThan(0.1)
  })

  it('shows the small-sample bias of PLV that PPC removes', () => {
    const few = nullPlv(4, 400, 3)
    const many = nullPlv(64, 400, 3)
    expect(percentile(few, 50)).toBeGreaterThan(percentile(many, 50) * 2)
    const unrelatedPpc = Array.from({ length: 200 }, (_, seed) => phaseMetrics(epochPhases(8, 0, 1, seed)).ppc)
    expect(Math.abs(unrelatedPpc.reduce((a, b) => a + b, 0) / unrelatedPpc.length)).toBeLessThan(0.05)
  })

  it('converts phase to lag at 10 Hz', () => {
    expect(lagMs(60, 10)).toBeCloseTo(16.67, 1)
  })
})
