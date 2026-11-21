import { describe, expect, it } from 'vitest'

import { defaultRecipe, type ExperimentRecipe } from '../types'
import { computeSamplingPreview, dft, filterResponse, stableMixingMatrix, welch } from './samplingPreview'

// Reference values computed with the Python engine and SciPy (scipy.signal.welch,
// sosfreqz, iirnotch) for the same settings. They pin how far the browser preview may drift
// from the confirmed server run.
const FIXTURES = {"responses":[{"fs":250,"hp":1,"lp":40,"notch":60,"idx":[0,10,40,80,100,128,163,200,250,300,400,511],"f":[0.0,2.44140625,9.765625,19.53125,24.414062500000004,31.25,39.794921875,48.82812500000001,61.03515625,73.2421875,97.65625000000001,124.755859375],"g":[-320.0,-0.0025814393780623623,-0.0003942270567582766,-0.009448618913033406,-0.07472233822237845,-0.754719183112643,-5.818046789314951,-18.956377640646018,-45.92018291451416,-61.947509298891404,-114.53796541737488,-320.0]},{"fs":100,"hp":1,"lp":40,"notch":60,"idx":[0,10,40,80,100,128,163,200,250,300,400,511],"f":[0.0,0.9765625,3.90625,7.8125,9.765625,12.5,15.917968749999998,19.53125,24.414062499999996,29.296874999999996,39.0625,49.90234374999999],"g":[-320.0,-6.902401158125793,-4.2608015899730306e-05,-1.3419581024607376e-10,2.3143859197278877e-14,-1.332125819657653e-09,-4.0604467866954606e-07,-1.2503279117968756e-05,-0.0003620449503685867,-0.006575745836801491,-3.2534318661031207,-320.0]},{"fs":250,"hp":8,"lp":40,"notch":null,"idx":[0,10,40,80,100,128,163,200,250,300,400,511],"f":[0.0,2.44140625,9.765625,19.53125,24.414062500000004,31.25,39.794921875,48.82812500000001,61.03515625,73.2421875,97.65625000000001,124.755859375],"g":[-320.0,-95.58029478091046,-0.6516356100877541,-2.7101902712762296e-09,-0.000858953505861234,-0.1986946114800228,-5.717446431750208,-23.649658047897184,-48.854388853039865,-72.38574303613383,-126.5799488966013,-320.0]},{"fs":250,"hp":null,"lp":15,"notch":null,"idx":[0,10,40,80,100,128,163,200,250,300,400,511],"f":[0.0,2.44140625,9.765625,19.53125,24.414062500000004,31.25,39.794921875,48.82812500000001,61.03515625,73.2421875,97.65625000000001,124.755859375],"g":[2.700116906349202e-14,-3.89763932672172e-06,-0.2613033748025913,-19.85858174273822,-35.396102503830605,-53.89540480266131,-73.12601973778827,-90.76141145643169,-112.56319283413924,-134.11427905817865,-186.53839123606593,-320.0]},{"fs":500,"hp":1,"lp":90,"notch":60,"idx":[0,10,40,80,100,128,163,200,250,300,400,511],"f":[0.0,4.8828125,19.53125,39.0625,48.82812500000001,62.5,79.58984375,97.65625000000001,122.0703125,146.484375,195.31250000000003,249.51171875],"g":[-320.0,-7.456801546872234e-05,-0.001395246212807506,-0.0162960990470117,-0.08390891283231601,-1.581106001454693,-2.2636664310489722,-10.47113926804366,-29.72286974667625,-51.146416702998955,-103.67054055070153,-320.0]},{"fs":150,"hp":0.5,"lp":90,"notch":60,"idx":[0,10,40,80,100,128,163,200,250,300,400,511],"f":[0.0,1.46484375,5.859375,11.71875,14.6484375,18.75,23.876953124999996,29.296875,36.62109374999999,43.9453125,58.59375,74.85351562499999],"g":[-320.0,-0.0016143323105344929,-0.00028463917577464733,-0.0011857353568248995,-0.0019118117414773717,-0.003318313918856434,-0.005934322174647651,-0.01029496827759823,-0.021272514094503807,-0.0480578149567203,-3.7802863334157086,-1.575251463390561e-05]}],"mixing":[[-0.8702737191834777,0.2167042870125914,0.04836651724752707],[0.4666009747268667,0.673081905855717,-0.15022604332085676],[0.15022604332085684,-0.6730819058557171,0.46660097472686657],[-0.04836651724752707,0.2167042870125914,0.8702737191834777]],"welch":{"idx":[0,5,20,74,75,100,150,250],"f":[0.0,2.5,10.0,37.0,37.5,50.0,75.0,125.0],"p":[1.2718523655679886e-05,4.69085039941673e-06,6.000159864524609,0.41434219263003963,0.5411817263618368,2.2795639798447329e-10,3.3193395314625506e-13,1.4129662137434898e-15]},"runs":[{"name":"default","sim":{},"pre":{},"points":{"2":{"raw":33.1156,"filt":28.7554},"10":{"raw":8.24184,"filt":1.91208},"40":{"raw":0.0425838,"filt":0.0130295},"60":{"raw":0.239415,"filt":1.02906e-07}}},{"name":"alias","sim":{"sampling_rate_hz":100},"pre":{},"points":{"2":{"raw":50.5793,"filt":36.6895},"10":{"raw":8.94403,"filt":2.47368},"40":{"raw":0.343978,"filt":1.64558}}},{"name":"none","sim":{},"pre":{"reference":"none"},"points":{"2":{"raw":33.1156,"filt":32.8931},"10":{"raw":8.24184,"filt":8.24123},"40":{"raw":0.0425838,"filt":0.0109916},"60":{"raw":0.239415,"filt":6.06281e-08}}}]} as const

const db = (value: number) => 10 * Math.log10(value)

function recipeWith(sim: Partial<ExperimentRecipe['simulation']>, pre: Partial<ExperimentRecipe['preprocessing']>): ExperimentRecipe {
  const recipe = structuredClone(defaultRecipe)
  Object.assign(recipe.simulation, sim)
  Object.assign(recipe.preprocessing, pre)
  return recipe
}

describe('Lab 01 browser preview against SciPy', () => {
  it('computes any-length DFTs', () => {
    const values = [1, 2, 0, -1, 3]
    const { re, im } = dft(values)
    values.forEach((_, k) => {
      const expRe = values.reduce((sum, x, n) => sum + x * Math.cos((2 * Math.PI * k * n) / values.length), 0)
      const expIm = values.reduce((sum, x, n) => sum - x * Math.sin((2 * Math.PI * k * n) / values.length), 0)
      expect(re[k]).toBeCloseTo(expRe, 9)
      expect(im[k]).toBeCloseTo(expIm, 9)
    })
  })

  it('reproduces the server filter response to within 0.01 dB', () => {
    for (const fixture of FIXTURES.responses) {
      const response = filterResponse(recipeWith({ sampling_rate_hz: fixture.fs }, { highpass_hz: fixture.hp, lowpass_hz: fixture.lp, notch_hz: fixture.notch }))
      fixture.idx.forEach((index, i) => {
        expect(response.frequency[index]).toBeCloseTo(fixture.f[i]!, 6)
        expect(Math.abs(response.gainDb[index]! - fixture.g[i]!), `${fixture.fs} Hz · bin ${index}`).toBeLessThan(0.01)
      })
    }
  })

  it('uses the same mixing matrix as the engine', () => {
    stableMixingMatrix(4, 3).forEach((row, c) => row.forEach((value, s) => expect(value).toBeCloseTo(FIXTURES.mixing[c]![s]!, 12)))
  })

  it('matches scipy.signal.welch defaults', () => {
    const fs = 250
    const x = Array.from({ length: 2000 }, (_, i) => { const t = i / fs; return 3 * Math.sin(2 * Math.PI * 10 * t) + Math.cos(2 * Math.PI * 37.3 * t) + 0.5 * t })
    const { frequency, power } = welch(x, fs, 500)
    FIXTURES.welch.idx.forEach((index, i) => {
      expect(frequency[index]).toBeCloseTo(FIXTURES.welch.f[i]!, 9)
      expect(power[index]! / FIXTURES.welch.p[i]!).toBeCloseTo(1, 6)
    })
  })

  it('keeps planted peaks within 2 dB (background noise differs) of the server run', () => {
    for (const run of FIXTURES.runs) {
      const preview = computeSamplingPreview(recipeWith(run.sim, run.pre))
      const frequency = preview.spectrumFrequency
      const checks: [string, 'raw' | 'filt'][] = run.name === 'alias' ? [['10', 'raw'], ['10', 'filt'], ['40', 'raw']] : [['10', 'raw'], ['10', 'filt'], ['60', 'raw']]
      for (const [hz, layer] of checks) {
        const bin = frequency.reduce((best, f, i) => Math.abs(f - Number(hz)) < Math.abs(frequency[best]! - Number(hz)) ? i : best, 0)
        const value = (layer === 'raw' ? preview.rawPower : preview.filteredPower)['EEG 01']![bin]!
        const expected = (run.points as Record<string, { raw: number; filt: number }>)[hz]![layer]
        const diff = Math.abs(db(value) - db(expected))
        expect(diff, `${run.name} ${hz} Hz ${layer}`).toBeLessThan(2)
      }
    }
  })
})
