import { describe, expect, it } from 'vitest'

import {
  ARTIFACT_KINDS, amplitudeSpectrum, applyFilters, artifactClip, connectionQuestion, dailyGame, dailySeed, restorationScore,
  sandboxClean, sandboxNoise, sourceQuestion,
} from './games'

const peakHz = (values: number[], lo = 0, hi = 100) => {
  const { hz, amp } = amplitudeSpectrum(values)
  let best = -1
  hz.forEach((f, i) => { if (f >= lo && f <= hi && (best < 0 || amp[i]! > amp[best]!)) best = i })
  return hz[best]!
}

describe('practice games', () => {
  it('is reproducible from the seed', () => {
    expect(artifactClip(12).data[0]).toEqual(artifactClip(12).data[0])
    expect(connectionQuestion(5)).toEqual(connectionQuestion(5))
  })

  it('puts each artifact where its tell says it is', () => {
    expect(artifactClip(3, 'blink').channels[artifactClip(3, 'blink').focus]).toMatch(/^Fp/)
    expect(['T7', 'T8']).toContain(artifactClip(3, 'muscle').channels[artifactClip(3, 'muscle').focus])
    const line = artifactClip(3, 'line')
    expect([50, 60]).toContain(peakHz(line.data[line.focus]!, 40, 100))
    const pop = artifactClip(3, 'pop')
    expect(pop.topography.filter((value) => value > 0.5)).toHaveLength(1)
    expect(new Set(Array.from({ length: 40 }, (_, seed) => artifactClip(seed).kind)).size).toBe(ARTIFACT_KINDS.length)
  })

  it('makes connection questions whose zero-lag peak marks volume conduction', () => {
    const questions = Array.from({ length: 40 }, (_, seed) => connectionQuestion(seed + 1))
    const fake = questions.filter((question) => !question.real)
    expect(fake.length).toBeGreaterThan(10)
    expect(fake.every((question) => question.electrode.peakLagMs === 0 && question.electrode.peakValue > question.source.peakValue)).toBe(true)
    const real = questions.filter((question) => question.real)
    expect(real.every((question) => question.source.peakLagMs === question.lagMs && question.electrode.peakLagMs === question.lagMs)).toBe(true)
  })

  it('puts the source probe on the peak or on its flank', () => {
    for (let seed = 1; seed < 20; seed += 1) {
      const question = sourceQuestion(seed)
      const peak = Math.max(...question.estimate)
      if (question.real) expect(question.estimate[question.probe]).toBeCloseTo(peak, 5)
      else expect(question.estimate[question.probe]!).toBeLessThan(peak)
    }
  })

  it('scores restoration: right filters help, too much filtering hurts', () => {
    const clean = sandboxClean()
    const noisy = sandboxNoise({ line: 20, drift: 40, muscle: 10 }).map((value, i) => value + clean[i]!)
    const none = restorationScore(clean, noisy, noisy).score
    const good = restorationScore(clean, noisy, applyFilters(noisy, { highPass: 1, lowPass: 30, notch: true })).score
    const harsh = restorationScore(clean, noisy, applyFilters(noisy, { highPass: 8, lowPass: 12, notch: true })).score
    expect(none).toBe(0)
    expect(good).toBeGreaterThan(70)
    expect(harsh).toBeLessThan(good - 20)
  })

  it('picks the same daily question for the same date', () => {
    const seed = dailySeed(new Date(2026, 10, 22))
    expect(seed).toBe(20261122)
    expect(dailyGame(seed)).toBe(dailyGame(dailySeed(new Date(2026, 10, 22, 23, 59))))
  })
})
