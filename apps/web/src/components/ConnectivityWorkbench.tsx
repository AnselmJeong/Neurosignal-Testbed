import { Activity, ArrowDown, GitCompareArrows, Network, Play, SlidersHorizontal, Waves } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { runConnectivity, simulateConnectivity } from '../lib/api'
import { defaultConnectivityRecipe, type ConnectivityMetric, type ConnectivityRecipe, type ConnectivityResult, type ConnectivitySimulation, type ConnectivitySpace } from '../types'
import { LabNavigator, type LabId } from './LabNavigator'
import { StackedEegBrowser } from './StackedEegBrowser'
import { ComparisonReadout, ConnectivityDiagnostics, EstimatePanel, GeneratingNetwork, METRIC_GUIDE, RecipeSummary } from './ConnectivityLessonViews'
import './connectivity-lesson.css'

const STEPS = [
  { label: 'Build', description: 'Set the relationship between hidden signal sources.', icon: Network },
  { label: 'Observe', description: 'Follow source rhythms into mixed sensor EEG.', icon: Waves },
  { label: 'Estimate', description: 'Measure relationships across many epochs.', icon: Activity },
  { label: 'Compare', description: 'Keep A fixed and test one change in B.', icon: GitCompareArrows },
]
const METRICS: ConnectivityMetric[] = ['coh', 'pearson', 'plv', 'imcoh', 'pli', 'wpli', 'ppc']
const SIGNAL_SETTINGS = ['seed', 'sampling_rate_hz', 'epoch_count', 'epoch_duration_s', 'alpha_frequency_hz', 'phase_lag_deg', 'coupling_strength', 'noise_sd', 'volume_conduction', 'reference'] as const
const sameSignal = (a: ConnectivityRecipe, b: ConnectivityRecipe) => SIGNAL_SETTINGS.every(key => a[key] === b[key])
const sameRecipe = (a: ConnectivityRecipe, b: ConnectivityRecipe) => JSON.stringify(a) === JSON.stringify(b)

export function ConnectivityWorkbench({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [recipe, setRecipe] = useState<ConnectivityRecipe>(() => structuredClone(defaultConnectivityRecipe))
  const [simulation, setSimulation] = useState<ConnectivitySimulation | null>(null)
  const [baseline, setBaseline] = useState<ConnectivityResult | null>(null)
  const [latest, setLatest] = useState<ConnectivityResult | null>(null)
  const [busy, setBusy] = useState<'generate' | 'estimate' | 'remeasure' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [space, setSpace] = useState<ConnectivitySpace>('sensor')
  const [view, setView] = useState<'Matrix' | 'Network'>('Matrix')
  const [traceSnapshot, setTraceSnapshot] = useState<'current' | 'a'>('current')
  const requestId = useRef(0)
  const pending = useRef(false)
  useEffect(() => () => { requestId.current += 1 }, [])

  const ready = simulation !== null && sameSignal(simulation.recipe, recipe)
  const comparison = baseline && latest && baseline.run_id !== latest.run_id ? latest : null
  const hasDistinctEeg = baseline !== null && simulation !== null && !sameSignal(baseline.recipe, simulation.recipe)
  const trace = traceSnapshot === 'a' && baseline ? baseline.simulation : simulation
  const dirty = latest !== null && !sameRecipe(latest.recipe, recipe)
  const step = baseline ? 3 : ready ? 2 : busy === 'generate' ? 1 : 0

  function update<K extends keyof ConnectivityRecipe>(key: K, value: ConnectivityRecipe[K]) {
    setRecipe(current => ({ ...current, [key]: value }))
    setError(null)
    setTraceSnapshot('current')
  }

  async function updateMeasurement<K extends 'metric' | 'spectral_mode'>(key: K, value: ConnectivityRecipe[K]) {
    if (pending.current || recipe[key] === value) return
    const previousRecipe = recipe
    setRecipe(current => ({ ...current, [key]: value }))
    setError(null)
    if (!baseline) return

    pending.current = true
    const id = ++requestId.current
    setBusy('remeasure')
    try {
      // Reconstruct identical seeded EEG for each saved condition. Wait for every
      // response before replacing either side, including when one request fails.
      const saved = comparison ? [baseline, comparison] : [baseline]
      const results = await Promise.allSettled(saved.map(run => runConnectivity({ ...run.recipe, [key]: value })))
      if (requestId.current !== id) return
      const updated = results.map(result => {
        if (result.status === 'rejected') throw result.reason
        return result.value
      })
      setBaseline(updated[0]!)
      setLatest(updated[updated.length - 1]!)
      // Keep any generated, unestimated B preview and all draft signal settings.
    } catch (caught) {
      if (requestId.current === id) {
        setRecipe(previousRecipe)
        setError(`Could not update the shared measurement. A/B and the selector were restored. ${caught instanceof Error ? caught.message : 'Please try again.'}`)
      }
    } finally {
      if (requestId.current === id) { setBusy(null); pending.current = false }
    }
  }

  async function execute(kind: 'generate' | 'estimate') {
    if (pending.current || (kind === 'estimate' && !ready)) return
    pending.current = true
    const id = ++requestId.current
    const snapshot = structuredClone(recipe)
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'generate') {
        const data = await simulateConnectivity(snapshot)
        if (requestId.current !== id) return
        setSimulation(data)
        setTraceSnapshot('current')
      } else {
        const data = await runConnectivity(snapshot)
        if (requestId.current !== id) return
        setLatest(data)
        setBaseline(current => current ?? data)
        setSimulation(data.simulation)
      }
    } catch (caught) {
      if (requestId.current === id) setError(caught instanceof Error ? caught.message : 'The local analysis failed. Retry with these settings.')
    } finally {
      if (requestId.current === id) { setBusy(null); pending.current = false }
    }
  }

  function setExperiment(change: Partial<ConnectivityRecipe>) {
    if (!baseline) return
    setRecipe({ ...baseline.recipe, ...change })
    setError(null)
    setTraceSnapshot('current')
  }

  return <>
    <main className="workspace conn-lesson-workspace">
      <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={STEPS} step={step} />
      <aside className="control-panel conn-lesson-controls">
        <div className="panel-heading"><span className="eyebrow">Connectivity experiment</span><h1>From sources<br />to sensor edges</h1><p>Build a relationship, observe its EEG, then ask what connectivity can recover.</p></div>
        <fieldset disabled={busy !== null}>
          <legend className="sr-only">Simulation and estimation settings</legend>
          <section className="control-section">
            <div className="section-title"><span>1 · Source relationship</span></div>
            <p className="conn-control-help">Four simulated sources produce alpha rhythms. Only the frontal pair can share a component.</p>
            <Range label="Shared alpha weight" value={recipe.coupling_strength} min={0} max={1} step={0.01} onChange={v => update('coupling_strength', v)} />
            <p className="conn-control-help">0 = independent phases; 1 = all of Frontal R’s oscillation follows the shared phase. This is a generator weight, not a target coherence value.</p>
            <Range label="Phase offset" value={recipe.phase_lag_deg} min={0} max={180} step={15} unit="°" onChange={v => update('phase_lag_deg', v)} />
            <p className="conn-control-help">{recipe.coupling_strength === 0 ? 'No shared component: this offset has no effect.' : `${recipe.phase_lag_deg}° at ${recipe.alpha_frequency_hz} Hz = ${(recipe.phase_lag_deg / 360 / recipe.alpha_frequency_hz * 1000).toFixed(1)} ms of phase shift. The shared component in R leads L; this is not a causal delay model.`}</p>
          </section>
          <section className="control-section">
            <div className="section-title"><span>2 · Sensor mixing</span></div>
            <Range label="Field spread" value={recipe.volume_conduction} min={0} max={1} step={0.01} onChange={v => update('volume_conduction', v)} />
            <p className="conn-control-help">Broader fields let each source reach more sensors. Even 0 retains some mixing; this does not change the source relationship.</p>
            <label className="conn-select">Sensor reference<select value={recipe.reference} onChange={e => update('reference', e.target.value as ConnectivityRecipe['reference'])}><option value="average">Average reference</option><option value="none">No re-reference</option></select></label>
            <p className="conn-control-help">Average reference subtracts the eight-channel mean at each sample. “No re-reference” keeps the model’s original sensor mixture.</p>
          </section>
          <section className="control-section">
            <div className="section-title"><span>3 · Measurement</span></div>
            <label className="conn-select">Connectivity metric<select value={recipe.metric} onChange={e => void updateMeasurement('metric', e.target.value as ConnectivityMetric)}>{METRICS.map(metric => <option key={metric} value={metric}>{METRIC_GUIDE[metric].label}</option>)}</select></label>
            <p className="conn-control-help">{METRIC_GUIDE[recipe.metric].explanation}</p><p className="conn-control-help">Shared by A and B. Changing the metric re-estimates both saved conditions from the same EEG; no new EEG generation is needed.</p>
          </section>
          <details className="conn-advanced"><summary><SlidersHorizontal size={14} /> Signal and estimation details</summary>
            <Range label="Alpha frequency" value={recipe.alpha_frequency_hz} min={8} max={12} step={0.5} unit=" Hz" onChange={v => update('alpha_frequency_hz', v)} />
            <Range label="Background noise" value={recipe.noise_sd} min={0.05} max={1.5} step={0.05} onChange={v => update('noise_sd', v)} />
            <Range label="Epochs" value={recipe.epoch_count} min={8} max={64} step={4} onChange={v => update('epoch_count', v)} />
            <p className="conn-control-help">Independent {recipe.epoch_duration_s} s segments. Connectivity uses all epochs; the browser shows one example.</p>
            <label className="conn-select">Spectral mode<select value={recipe.spectral_mode} disabled={recipe.metric === 'pearson'} onChange={e => void updateMeasurement('spectral_mode', e.target.value as ConnectivityRecipe['spectral_mode'])}><option value="multitaper">Multitaper</option><option value="fourier">Fourier</option></select></label>
            <p className="conn-control-help">Seed {recipe.seed} · {recipe.sampling_rate_hz} Hz sampling · {recipe.surrogate_count} shuffled nulls. Spectral metrics average {recipe.band_low_hz}–{recipe.band_high_hz} Hz.</p>
          </details>
        </fieldset>
        <div className="conn-actions">
          {busy === 'remeasure' && <p role="status">Re-estimating {comparison ? 'A and B' : 'A'} with {METRIC_GUIDE[recipe.metric].label}… The previous results remain visible until all calculations finish.</p>}
          <button className="primary-button" disabled={busy !== null} onClick={() => void execute('generate')}><Waves size={15} />{busy === 'generate' ? 'Generating…' : <span className="conn-generate-label"><span>1 · Generate</span>{' '}<span>{baseline ? 'comparison EEG' : 'baseline EEG'}</span></span>}</button>
          <button className="quiet-button" disabled={!ready || busy !== null} onClick={() => void execute('estimate')}><Play size={14} />{busy === 'estimate' ? 'Estimating…' : baseline ? '2 · Estimate B' : '2 · Estimate connectivity'}</button>
          {!ready && <p>Generate the current settings before estimating.</p>}
        </div>
      </aside>
      <section className="conn-lesson-canvas" aria-label="Connectivity learning sequence">
        <header className="conn-lesson-header"><span className="eyebrow">A controlled simulation · not an anatomical brain model</span><h2>What survives the journey to the scalp?</h2><p>A source relationship, a similar-looking waveform, and a sensor edge are three different things. Follow the same data through each step.</p>
          <nav aria-label="Lesson sections"><a href="#conn-source">01 Source model</a><a href="#conn-eeg">02 Generated EEG</a><a href="#conn-estimates">03 Connectivity & comparison</a></nav>
        </header>
        {busy && <div className="conn-status" role="status">{busy === 'generate' ? 'Generating source and sensor epochs…' : busy === 'remeasure' ? `Applying ${METRIC_GUIDE[recipe.metric].label} / ${recipe.spectral_mode} to all saved conditions. Results update together; their original EEG settings stay fixed.` : `Estimating both spaces and computing ${recipe.surrogate_count} shuffled nulls per space. This can take several seconds…`}</div>}
        {error && <div className="conn-error" role="alert"><strong>Could not complete this step.</strong> {error} Your completed results are still available.</div>}
        <section id="conn-source" className="conn-chapter">
          <div className="conn-chapter-heading"><span>01</span><div><h2>Define the hidden sources</h2><p>Current settings · this diagram updates immediately; EEG updates when you generate.</p></div></div>
          <div className="conn-source-layout"><GeneratingNetwork recipe={recipe} /><div className="conn-source-explanation"><h3>What does “plant alpha” mean?</h3><p>The four sources are Frontal L (front left), Frontal R (front right), Posterior L (back left), and Posterior R (back right). Each generates a {recipe.alpha_frequency_hz} Hz rhythm plus noise. These are schematic positions, not precise brain regions.</p><p>Frontal L and R are two of those four sources, not extra nodes. Only this pair shares a component: Frontal R combines a phase-shifted version of L’s oscillation with an independent oscillation. The posterior sources have independent phases. The configured line describes this shared component, not a synapse.</p></div></div>
          <details className="conn-model-math"><summary>How is the shared component constructed?</summary><p>L = sin(ωt + φL) + noise<br />R = c sin(ωt + φL + δ) + √(1 − c²) sin(ωt + φR) + noise</p><p>c = shared alpha weight; δ = phase offset; ω = 2π × {recipe.alpha_frequency_hz} Hz. Each epoch draws new independent starting phases. The shared part retains its offset across epochs; unrelated sources do not. A common alpha frequency alone does not create the configured relationship.</p></details>
          <div className="conn-flow-caption"><ArrowDown size={18} /><span>Four hidden sources → eight separate sensors (Fp1, Fp2, F7, F8, C3, C4, O1, O2). Each sensor receives a mixture, then sensor noise and the reference are applied.</span></div>
        </section>
        <section id="conn-eeg" className="conn-chapter">
          <div className="conn-chapter-heading"><span>02</span><div><h2>Observe the generated signals</h2><p>The source traces and sensor EEG below come from the actual simulation input.</p></div></div>
          {hasDistinctEeg && <div className="conn-switch" role="group" aria-label="EEG snapshot"><button aria-pressed={traceSnapshot === 'a'} onClick={() => setTraceSnapshot('a')}>A - baseline EEG</button><button aria-pressed={traceSnapshot === 'current'} onClick={() => setTraceSnapshot('current')}>B - comparison EEG</button></div>}
          {hasDistinctEeg && <p className="conn-reading-note">Choose which condition’s source and sensor waveforms to inspect. B can be viewed before estimation; this switch only changes the traces above the connectivity comparison.</p>}
          {trace ? <>
            <p className="conn-snapshot-label">{traceSnapshot === 'a' ? 'Saved A' : sameSignal(trace.recipe, recipe) ? 'Current generated settings' : 'Previous generated settings — generate again to apply your changes'}</p>
            <RecipeSummary recipe={trace.recipe} includeMeasurement={false} />
            <div className="conn-trace-grid">
              <div><h3>Before mixing · four sources</h3><div className="conn-trace-frame"><StackedEegBrowser x={trace.latent_trace.x} series={trace.latent_trace.series} unit="a.u." ariaLabel="Generated latent source signals" /></div></div>
              <div><h3>After mixing · eight sensors</h3><div className="conn-trace-frame"><StackedEegBrowser x={trace.sensor_trace.x} series={trace.sensor_trace.series} unit="a.u." channelType="eeg" ariaLabel="Generated sensor EEG" /></div></div>
            </div>
            <p className="conn-reading-note">Epoch {trace.epoch_index + 1} of {trace.recipe.epoch_count} · {trace.recipe.epoch_duration_s} s · arbitrary amplitude units (not calibrated µV). Each viewer has its own display gain. A similar waveform in one epoch does not establish stable connectivity; estimation pools all epochs.</p>
          </> : <div className="conn-empty"><Waves size={22} /><h3>Make the signals before measuring their relationship</h3><p>Use “1 · Generate baseline EEG” to see the hidden sources and the scalp mixtures they produce.</p></div>}
        </section>
        <section id="conn-estimates" className="conn-chapter">
          <div className="conn-chapter-heading"><span>03</span><div><h2>Estimate, then change one assumption</h2><p>The first estimate becomes A. Change a setting, generate its EEG, and estimate B.</p></div></div>
          {baseline && <div className="conn-experiments"><h3>Try one change from A</h3><div>
            <button disabled={busy !== null} onClick={() => setExperiment({ coupling_strength: baseline.recipe.coupling_strength === 0 ? 0.78 : 0 })}>{baseline.recipe.coupling_strength === 0 ? 'Add shared alpha' : 'Remove shared alpha'}</button>
            <button disabled={busy !== null} onClick={() => setExperiment({ volume_conduction: baseline.recipe.volume_conduction > 0.5 ? 0.1 : 0.9 })}>Change field spread</button>
            <button disabled={busy !== null} onClick={() => setExperiment({ phase_lag_deg: baseline.recipe.phase_lag_deg === 0 ? 60 : 0 })}>Change phase offset</button>
            <button disabled={busy !== null} onClick={() => setExperiment({ reference: baseline.recipe.reference === 'average' ? 'none' : 'average' })}>Switch reference</button>
            <button disabled={busy !== null} onClick={() => setExperiment({})}>Restore A settings</button>
          </div><p>Each shortcut starts from A and changes only the named setting. Then generate and estimate B.</p></div>}
          {baseline && latest ? <>
            <div className="conn-result-toolbar"><div className="conn-switch" role="group" aria-label="Estimate space"><button aria-pressed={space === 'sensor'} onClick={() => setSpace('sensor')}>Sensor estimates</button><button aria-pressed={space === 'latent'} onClick={() => setSpace('latent')}>Source estimates</button></div><div className="conn-switch" role="group" aria-label="Estimate visualization"><button aria-pressed={view === 'Matrix'} onClick={() => setView('Matrix')}>Matrix</button><button aria-pressed={view === 'Network'} onClick={() => setView('Network')}>{space === 'sensor' ? 'Scalp map' : 'Source graph'}</button></div></div>
            <p className="conn-reading-note">{space === 'sensor' ? 'Each cell or line measures a sensor pair. It cannot be matched one-to-one to a source edge.' : 'These estimates use the original simulated sources, not sources reconstructed from EEG. In the network view, green = configured shared pair; dashed orange = other detected pairs.'} {view === 'Matrix' ? 'All pairwise weights are shown; outlined cells pass the null threshold. The diagonal is omitted because it compares each channel with itself.' : 'Only edges passing the null threshold are drawn; missing lines may still have nonzero weights. Line width increases nonlinearly to emphasize stronger weights; the width legend shows the mapping. Sensor colors run from blue (0) through yellow (0.5) to red (1), matching the matrix.'}</p>
            {dirty && <p className="conn-snapshot-label" role="status">Settings changed. The plots retain their completed run settings until a new estimate finishes.</p>}
            <div className="conn-comparison-grid"><EstimatePanel result={baseline} label="A · saved baseline" space={space} view={view} />{comparison ? <EstimatePanel result={comparison} label="B · latest estimate" space={space} view={view} /> : <div className="conn-comparison-placeholder"><GitCompareArrows size={24} /><h3>B · your next experiment</h3><p>A stays here while you change one assumption. Start with “Remove shared alpha” or “Change field spread” above.</p></div>}</div>
            {comparison && <><ComparisonReadout a={baseline} b={comparison} space={space} /><button className="quiet-button" disabled={busy !== null} onClick={() => { setBaseline(comparison); setRecipe(structuredClone(comparison.recipe)); setSimulation(comparison.simulation); setTraceSnapshot('current'); setError(null) }}>Use B as the new A</button></>}
            <div className="conn-takeaway"><h3>Read an edge as a measured relationship</h3><p>Shared fields and the reference can change sensor connectivity without changing the source network. Lag-sensitive metrics ask a different question and can miss real zero-lag dependence. None of these undirected metrics establishes a neural pathway or causality.</p></div>
            <ConnectivityDiagnostics result={latest} space={space} />
          </> : <div className="conn-empty"><Network size={22} /><h3>Which relationships will the sensor data suggest?</h3><p>After generating the EEG, use “2 · Estimate connectivity”. A will appear here with its settings and shuffled-null threshold.</p></div>}
        </section>
      </section>
    </main>
    <footer className="conn-lesson-footer"><span>Source model → generated EEG → estimated relationships → A/B comparison</span><span>Seed {recipe.seed} · {recipe.sampling_rate_hz} Hz · simulated data</span></footer>
  </>
}

function Range({ label, value, min, max, step, unit = '', onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (value: number) => void }) {
  return <label className="conn-range"><span>{label}<output>{Number.isInteger(value) ? value : value.toFixed(2)}{unit}</output></span><input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} /></label>
}
