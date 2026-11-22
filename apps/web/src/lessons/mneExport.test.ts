import { describe, expect, it } from 'vitest'

import { defaultQeegRecipe } from '../lib/qeeg'
import { defaultConnectivityRecipe, defaultIcaRecipe, defaultRecipe, defaultSourceModelRecipe, type ConnectivityRecipe, type SourceModelRecipe } from '../types'
import { connectivityScript, filterScript, icaScript, qeegScript, sourceScript } from './mneExport'

describe('MNE code export', () => {
  it('writes the lab 01 recipe values into the filter calls', () => {
    const code = filterScript({ ...defaultRecipe, preprocessing: { ...defaultRecipe.preprocessing, highpass_hz: 1, lowpass_hz: 40, notch_hz: 60, filter_order: 4 } })
    expect(code).toContain('raw.filter(l_freq=1.0, h_freq=40.0, method="iir"')
    expect(code).toContain('iir_params=dict(order=4, ftype="butter")')
    expect(code).toContain('raw.notch_filter(60.0, method="iir")')
    expect(filterScript({ ...defaultRecipe, preprocessing: { ...defaultRecipe.preprocessing, notch_hz: null } })).not.toContain('notch_filter')
  })

  it('fits ICA on a filtered copy and applies it to the original', () => {
    const code = icaScript({ ...defaultIcaRecipe, algorithm: 'infomax', component_count: 7, seed: 5 })
    expect(code).toContain('fit_raw = raw.copy().filter(')
    expect(code).toContain('method="infomax"')
    expect(code).toContain('fit_params=dict(extended=True)')
    expect(code).toContain('random_state=5')
    expect(code).toContain('cleaned = ica.apply(raw.copy())')
  })

  it('carries the connectivity metric, band and surrogate count', () => {
    const code = connectivityScript({ ...(defaultConnectivityRecipe as ConnectivityRecipe), metric: 'wpli', band_low_hz: 8, band_high_hz: 12, surrogate_count: 200 })
    expect(code).toContain('method="wpli"')
    expect(code).toContain('fmin=8.0, fmax=12.0')
    expect(code).toContain('range(200)')
  })

  it('uses the lab 04 regularisation and grid', () => {
    const recipe = defaultSourceModelRecipe as SourceModelRecipe
    const code = sourceScript(recipe)
    expect(code).toContain(`lambda2=${recipe.inverse.lambda2}`)
    expect(code).toContain(`pos=${recipe.grid_spacing_mm}.0`)
  })

  it('picks the QEEG reference', () => {
    expect(qeegScript(defaultQeegRecipe)).toContain('set_eeg_reference("average"')
    expect(qeegScript({ ...defaultQeegRecipe, reference: 'linked_mastoids' })).toContain('["M1", "M2"]')
  })
})
