import { describe, expect, it } from 'vitest'

import { defaultRecipe, type ExperimentResult } from '../types'
import {
  SAMPLING_EXPERIMENTS,
  aliasFrequency,
  experimentRecipe,
  matchesExperiment,
  peakChanges,
  summarizePeakChanges,
} from './samplingLesson'

describe('Lab 01 lesson content', () => {
  it('folds frequencies about the sampling rate', () => {
    expect(aliasFrequency(60, 100)).toBe(40)
    expect(aliasFrequency(60, 150)).toBe(60)
    expect(aliasFrequency(60, 80)).toBe(20)
    expect(aliasFrequency(10, 250)).toBe(10)
  })

  it('changes exactly one setting from the default recipe for every experiment', () => {
    const base = experimentRecipe(null)
    expect(base).toEqual(defaultRecipe)
    for (const experiment of SAMPLING_EXPERIMENTS) {
      const recipe = experimentRecipe(experiment)
      const changed = [
        recipe.simulation.sampling_rate_hz !== base.simulation.sampling_rate_hz,
        recipe.simulation.noise_uv !== base.simulation.noise_uv,
        recipe.preprocessing.highpass_hz !== base.preprocessing.highpass_hz,
        recipe.preprocessing.lowpass_hz !== base.preprocessing.lowpass_hz,
        recipe.preprocessing.reference !== base.preprocessing.reference,
      ].filter(Boolean)
      expect(changed, experiment.id).toHaveLength(1)
      expect(experiment.prediction.choices.map((choice) => choice.id), experiment.id).toContain(experiment.prediction.correct)
    }
  })

  it('grades only runs whose settings match the question', () => {
    const alias = SAMPLING_EXPERIMENTS.find((item) => item.id === 'alias-100')!
    expect(matchesExperiment(experimentRecipe(alias), alias)).toBe(true)
    expect(matchesExperiment(defaultRecipe, alias)).toBe(false)
    const tweaked = experimentRecipe(alias)
    tweaked.preprocessing.lowpass_hz = 30
    expect(matchesExperiment(tweaked, alias)).toBe(false)
  })

  it('summarises the processed-minus-raw change at each planted peak, following aliasing', () => {
    const recipe = experimentRecipe(SAMPLING_EXPERIMENTS.find((item) => item.id === 'alias-100')!)
    const frequency = [0, 2, 10, 40, 50]
    const result = {
      recipe,
      spectrum: {
        frequency_hz: frequency,
        raw_power_by_channel: { 'EEG 01': [1, 10, 100, 10, 1] },
        filtered_power_by_channel: { 'EEG 01': [1, 10, 100, 1, 1] },
      },
    } as unknown as ExperimentResult
    const changes = peakChanges(result, 'EEG 01')
    expect(changes.map((change) => change.observedHz)).toEqual([2, 10, 40])
    expect(changes[2]!.changeDb).toBeCloseTo(-10)
    const sentence = summarizePeakChanges(changes, 'EEG 01', 'none')
    expect(sentence).toContain('60 Hz(→ 40 Hz로 접힘) −10.0 dB로 크게 줄었다')
    expect(sentence).toContain('10 Hz 0.0 dB로 거의 그대로다')
  })
})
