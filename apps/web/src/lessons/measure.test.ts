import { describe, expect, it } from 'vitest'

import { lensWindow, nearestIndex, niceCeil, niceStep, peakToPeak, roughFrequency, scaleBars } from './measure'

const fs = 250
const x = Array.from({ length: fs * 4 }, (_, i) => i / fs)
const alpha = x.map((t) => 40 * Math.sin(2 * Math.PI * 10 * t))

describe('measurement lens arithmetic', () => {
  it('finds the nearest sample', () => {
    expect(nearestIndex(x, 1.0021)).toBe(251)
    expect(nearestIndex(x, -5)).toBe(0)
    expect(nearestIndex(x, 99)).toBe(x.length - 1)
  })

  it('rounds to ruler numbers', () => {
    expect(niceStep(37)).toBe(20)
    expect(niceStep(0.4)).toBe(0.2)
    expect(niceStep(5)).toBe(5)
    expect(niceCeil(73)).toBe(100)
    expect(niceCeil(41)).toBe(50)
  })

  it('cuts a window around the cursor and keeps the cursor index', () => {
    const lens = lensWindow(x, alpha, 2, 0.5)
    expect(lens.times[0]).toBeCloseTo(1.5)
    expect(lens.times[lens.times.length - 1]).toBeCloseTo(2.5)
    expect(lens.times[lens.at]).toBeCloseTo(2)
  })

  it('reads amplitude and rhythm off a 10 Hz, 40 µV wave', () => {
    const lens = lensWindow(x, alpha, 2, 0.5)
    expect(peakToPeak(lens.values)).toBeCloseTo(80, 0)
    expect(roughFrequency(lens.times, lens.values)).toBeCloseTo(10, 0)
    expect(roughFrequency([0, 1], [0, 1])).toBeNull()
  })

  it('does not mistake noise on a slow blink for a fast rhythm', () => {
    let seed = 7
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 6
    const blink = x.map((t) => 90 * Math.exp(-(((t - 2) / 0.12) ** 2)) + noise())
    const lens = lensWindow(x, blink, 2, 0.5)
    const freq = roughFrequency(lens.times, lens.values)
    expect(freq === null || freq < 3).toBe(true)
  })

  it('sizes the scale bars to about a third of the window', () => {
    expect(scaleBars(80, 1)).toEqual({ amplitude: 20, timeS: 0.2 })
  })
})
