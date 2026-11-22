import { describe, expect, it } from 'vitest'

import { blinkRemoval, connectionReading, crossCorrelation, drivenPair, inverseProfile, mixingWeights, solve, sourceShare } from './journey'

describe('signal journey arithmetic', () => {
  it('mixes more when the field spreads further', () => {
    expect(sourceShare(mixingWeights(0), 1, 1)).toBeGreaterThan(0.95)
    expect(sourceShare(mixingWeights(1), 1, 1)).toBeLessThan(0.5)
  })

  it('makes unconnected sources look connected at the electrodes', () => {
    const reading = connectionReading(0.7, 0.6)
    expect(reading.sourceAB).toBeGreaterThan(0.6)
    expect(Math.abs(reading.sourceCD)).toBeLessThan(0.2)
    expect(reading.electrodeCD).toBeGreaterThan(0.5)
    const sharp = connectionReading(0.7, 0)
    expect(Math.abs(sharp.electrodeCD)).toBeLessThan(0.25)
  })

  it('removes the blink and takes the overlapping neural signal with it', () => {
    const apart = blinkRemoval(0)
    const together = blinkRemoval(0.9)
    const peak = (values: number[]) => Math.max(...values.map(Math.abs))
    expect(peak(apart.recorded[0]!)).toBeGreaterThan(80)
    expect(apart.neuralLoss).toBeLessThan(together.neuralLoss)
    expect(together.neuralLoss).toBeGreaterThan(0.9)
  })

  it('solves a small linear system', () => {
    const x = solve([[2, 1], [1, 3]], [3, 5])
    expect(x[0]).toBeCloseTo(0.8)
    expect(x[1]).toBeCloseTo(1.4)
  })

  it('blurs the inverse estimate more as λ grows', () => {
    const sharp = inverseProfile(0.5, 0.05)
    const blurred = inverseProfile(0.5, 1)
    expect(blurred.widthPct).toBeGreaterThan(sharp.widthPct)
    expect(sharp.errorPct).toBeLessThanOrEqual(10)
  })

  it('finds who moves first from the cross-correlation peak', () => {
    const ahead = drivenPair(40)
    expect(crossCorrelation(ahead.a, ahead.b).peakLagMs).toBe(40)
    const behind = drivenPair(-30)
    expect(crossCorrelation(behind.a, behind.b).peakLagMs).toBe(-30)
  })
})
