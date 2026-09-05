import { useState } from 'react'
import { AlertTriangle, BrainCircuit, CircleHelp, Crosshair, Eye, Play, ScanLine, Waves } from 'lucide-react'
import { runSourceModel, simulateSourceModel } from '../lib/api'
import { defaultSourceModelRecipe, type SourceModelRecipe, type SourceModelResult, type SourceModelSimulation } from '../types'
import { ControlHint } from './ControlHint'
import { LabNavigator, type LabId } from './LabNavigator'
import { StackedEegBrowser } from './StackedEegBrowser'
import { CandidateForwardMap, CandidateTraces, coordinates, SourcePowerView, TruthDiagnostics } from './SourcePowerViews'
import './source-localization.css'

const STEPS = [
  { label: 'Predict', description: 'Will the sources remain distinguishable?', icon: CircleHelp },
  { label: 'Generate', description: 'Project planted currents to scalp EEG.', icon: Waves },
  { label: 'Estimate', description: 'Infer current at every candidate point.', icon: BrainCircuit },
  { label: 'Inspect', description: 'Find power peaks without the answer.', icon: ScanLine },
  { label: 'Reveal', description: 'Count misses and unmatched peaks.', icon: Eye },
] as const
const VIEWS = ['Sensor EEG', 'Power map', 'Candidate trace', 'Forward map', 'Truth diagnostics'] as const
type View = typeof VIEWS[number]
const GUIDES: Record<View, [string, string]> = {
  'Sensor EEG': ['These 14 traces are mixtures of source currents.', 'The forward model mixes each internal source across scalp electrodes, adds noise, then applies average reference. Estimate sources using all channels together. A large sensor trace does not locate its source.'],
  'Power map': ['Where does the reconstructed power concentrate?', 'Minimum norm estimates all candidate currents. Fixed theta, alpha and beta bands summarize their power. The detector uses spatial maxima and your threshold; it receives no planted waveforms, locations or source count.'],
  'Candidate trace': ['Inspect the current at any candidate location.', 'Choose a candidate by its coordinates or click a point on the power map. This waveform is reconstructed from EEG, even when there is no true source at that point.'],
  'Forward map': ['What sensor pattern would this candidate create?', 'This lead field describes the selected candidate before observing EEG. Similar patterns from different candidates help explain why the inverse may confuse their locations.'],
  'Truth diagnostics': ['Use the answer to evaluate a completed estimate.', 'These diagnostics use known planted coordinates. They do not choose peaks. Review misses and unmatched peaks in the power map before interpreting waveform agreement.'],
}

export function SourceModelWorkbench({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [recipe, setRecipe] = useState<SourceModelRecipe>(() => structuredClone(defaultSourceModelRecipe))
  const [simulation, setSimulation] = useState<SourceModelSimulation | null>(null)
  const [result, setResult] = useState<SourceModelResult | null>(null)
  const [view, setView] = useState<View>('Sensor EEG')
  const [bandId, setBandId] = useState('alpha')
  const [selected, setSelected] = useState(0)
  const [truthVisible, setTruthVisible] = useState(false)
  const [busy, setBusy] = useState<'generate' | 'estimate' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prediction, setPrediction] = useState('Nearby or synchronized sources may blur together. Some peaks may move away from the planted locations.')
  const band = result?.power_maps.find((b) => b.id === bandId) ?? result?.power_maps[0]
  const count = simulation?.candidate_positions_mm.length ?? (recipe.grid_spacing_mm === 20 ? 250 : 26)
  const step = truthVisible ? 4 : result ? 3 : simulation ? 2 : busy === 'generate' ? 1 : 0

  function clearEstimate() {
    setResult(null); setTruthVisible(false); setView('Sensor EEG'); setError(null)
  }
  function updateSimulation<K extends keyof SourceModelRecipe>(key: K, value: SourceModelRecipe[K]) {
    setRecipe((current) => ({ ...current, [key]: value }))
    setSimulation(null); clearEstimate()
  }
  function updateInverse(key: keyof SourceModelRecipe['inverse'], value: number) {
    setRecipe((current) => ({ ...current, inverse: { ...current.inverse, [key]: value } }))
    clearEstimate()
  }
  async function generate() {
    setBusy('generate'); setSimulation(null); clearEstimate()
    try { setSimulation(await simulateSourceModel(recipe)) }
    catch (e) { setError(e instanceof Error ? e.message : 'EEG generation failed.') }
    finally { setBusy(null) }
  }
  async function estimate() {
    if (!simulation) return
    setBusy('estimate'); clearEstimate()
    try {
      // The same seeded input is reproduced; inverse settings never change sensor EEG.
      const data = await runSourceModel({ ...simulation.recipe, inverse: recipe.inverse })
      setResult(data); setBandId('alpha'); setView('Power map')
      const alpha = data.power_maps.find((item) => item.id === 'alpha')!
      setSelected(alpha.peaks[0]?.vertex_index ?? alpha.power_nam2.indexOf(Math.max(...alpha.power_nam2)))
    } catch (e) { setError(e instanceof Error ? e.message : 'Source estimation failed.') }
    finally { setBusy(null) }
  }
  function chooseBand(id: string) {
    setBandId(id)
    const next = result!.power_maps.find((item) => item.id === id)!
    setSelected(next.peaks[0]?.vertex_index ?? next.power_nam2.indexOf(Math.max(...next.power_nam2)))
  }

  return <>
    <main className="workspace source-workspace">
      <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={STEPS} step={step} />
      <aside className="control-panel source-controls">
        <div className="panel-heading"><span className="eyebrow">Source localization · guided experiment</span><h1>Can EEG lead us<br />back to its sources?</h1><p>Estimate first. Then measure what moved, merged or went missing.</p></div>
        <section className="prediction-block compact-prediction"><label htmlFor="source-prediction"><CircleHelp size={15} /> Your prediction</label><textarea id="source-prediction" value={prediction} onChange={(e) => setPrediction(e.target.value)} rows={3} /></section>
        <section className="control-section"><div className="section-title"><span>Generate the signal</span></div>
          <SourceRange label="Alpha phase lag" help="Timing offset between the two frontal 10 Hz currents. At 0° they are synchronized, which can make their spatial contributions harder to separate." value={recipe.phase_lag_deg} min={0} max={180} step={5} unit="°" disabled={!!busy} onChange={(v) => updateSimulation('phase_lag_deg', v)} />
          <SourceRange label="Source amplitude" help="Base planted current in nAm. Other source amplitudes stay at 88%, 58% and 42% of this value." value={recipe.source_amplitude_nam} min={5} max={50} step={1} unit="nAm" disabled={!!busy} onChange={(v) => updateSimulation('source_amplitude_nam', v)} />
          <SourceRange label="Sensor noise" help="Independent voltage noise added before average reference. Noise can create apparently strong power peaks even when they do not correspond to planted sources." value={recipe.sensor_noise_uv} min={0} max={5} step={0.01} unit="µV" disabled={!!busy} onChange={(v) => updateSimulation('sensor_noise_uv', v)} />
          <label className="source-select">Candidate grid<ControlHint>Grid spacing determines allowed locations, not actual localization accuracy. Both choices retain the same four planted coordinates.</ControlHint><select aria-label="Candidate grid spacing" value={recipe.grid_spacing_mm} disabled={!!busy} onChange={(e) => updateSimulation('grid_spacing_mm', Number(e.target.value) as 20 | 40)}><option value="20">20 mm · 250 candidates</option><option value="40">40 mm · 26 candidates</option></select></label>
          <p className="source-reading-note">14 scalp electrodes · 90 mm sphere. At most 13 independent measurements after average reference.</p>
          <button className="primary-button" disabled={!!busy} onClick={generate}><Play size={15} /> 1 · Generate sensor EEG</button>
        </section>
        <section className="control-section"><div className="section-title"><span>Estimate from EEG</span></div>
          <label className="source-select">Regularization λ²<ControlHint>Minimum norm favors smaller total current. Increasing λ² suppresses weak/noisy components and changes the spread; a small value does not guarantee a better location.</ControlHint><select aria-label="Inverse regularization" value={recipe.inverse.lambda2} disabled={!!busy} onChange={(e) => updateInverse('lambda2', Number(e.target.value))}><option value={0.01}>0.01 · weak</option><option value={1 / 9}>0.111 · default</option><option value={1}>1 · strong</option><option value={10}>10 · very strong</option></select></label>
          <SourceRange label="Peak threshold" help="Minimum power as a percentage of the strongest point in each band. This is a descriptive cutoff, not a significance test or probability. There is no fixed peak count." value={recipe.inverse.peak_threshold * 100} min={5} max={100} step={5} unit="%" disabled={!!busy} onChange={(v) => updateInverse('peak_threshold', v / 100)} />
          <SourceRange label="Peak separation" help="Keep stronger local maxima first and suppress peaks closer than this distance. Larger separation may merge two true sources into one reported peak." value={recipe.inverse.peak_separation_mm} min={20} max={100} step={10} unit="mm" disabled={!!busy} onChange={(v) => updateInverse('peak_separation_mm', v)} />
          <button className="source-estimate-button" disabled={!simulation || !!busy} onClick={estimate}><Crosshair size={15} /> 2 · Estimate sources</button>
          <p className="source-reading-note">These settings reuse the generated EEG. Changing them clears the old estimate and truth reveal.</p>
        </section>
      </aside>

      <section className="canvas-panel source-canvas">
        <div className="canvas-toolbar source-toolbar"><div><span className="eyebrow">Sensor EEG → candidate currents → power peaks → reveal</span><h2>{result ? count + ' candidate currents estimated · no preset source count' : simulation ? 'Sensor EEG ready · inverse not run' : 'Start with the forward simulation'}</h2></div>
          <div className="view-tabs" role="tablist" aria-label="Source modeling visualization type">{VIEWS.map((item) => <button key={item} role="tab" aria-selected={view === item} className={view === item ? 'active' : ''} disabled={!!busy || (item === 'Sensor EEG' ? !simulation : !result) || (item === 'Truth diagnostics' && !truthVisible)} onClick={() => setView(item)}>{item}</button>)}</div>
        </div>
        <div className="source-stage">
          {busy ? <div className="empty-stage" role="status"><BrainCircuit size={30} /><h3>{busy === 'generate' ? 'Projecting the four currents to scalp EEG…' : 'Reconstructing every candidate and detecting spatial power peaks…'}</h3><p>{busy === 'estimate' ? 'Only EEG, forward geometry and analysis settings enter the estimator.' : 'Creating the reproducible input.'}</p></div>
            : error ? <div className="empty-stage error-stage" role="alert"><AlertTriangle /><h3>Run could not complete</h3><p>{error}</p><button onClick={simulation ? estimate : generate}>Retry</button></div>
            : !simulation ? <SourceIntroduction count={count} recipe={recipe} />
            : <div className="source-result-view">
              <div className="source-view-guide"><div><h3>{GUIDES[view][0]}</h3><p>{GUIDES[view][1]}</p></div>{!result && <button onClick={estimate}>Estimate from this EEG</button>}</div>
              {result && band && view !== 'Sensor EEG' && view !== 'Truth diagnostics' && <div className="source-analysis-toolbar">
                <label className="source-select">Frequency band<select aria-label="Source frequency band" value={band.id} onChange={(e) => chooseBand(e.target.value)}>{result.power_maps.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <label className="source-select">Inspect candidate<select aria-label="Inspect source candidate" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>{result.candidate_positions_mm.map((position, i) => <option key={i} value={i}>v{i} · {coordinates(position)} mm</option>)}</select></label>
              </div>}
              <div className={'source-view-body ' + (view === 'Sensor EEG' ? 'sensor-view-body' : '')}>
                {view === 'Sensor EEG' && <StackedEegBrowser x={simulation.sensor_trace.x} series={simulation.sensor_trace.series} ariaLabel="Forward-projected sensor EEG from four planted sources" />}
                {result && band && view === 'Power map' && <SourcePowerView result={result} band={band} selected={selected} onSelect={setSelected} truthVisible={truthVisible} />}
                {result && view === 'Candidate trace' && <CandidateTraces result={result} selected={selected} />}
                {result && view === 'Forward map' && <CandidateForwardMap result={result} selected={selected} />}
                {result && truthVisible && view === 'Truth diagnostics' && <TruthDiagnostics result={result} />}
              </div>
            </div>}
        </div>
        <div className="canvas-readout source-readout"><div><small>CANDIDATE LOCATIONS</small><strong>{count}</strong></div><div><small>PEAKS · SELECTED BAND</small><strong>{band?.peaks.length ?? '—'}</strong></div><div><small>MEAN MATCHED DISTANCE</small><strong>{truthVisible && result ? result.evaluation.mean_error_mm === null ? 'No matches' : result.evaluation.mean_error_mm.toFixed(1) + ' mm' : 'Reveal to compare'}</strong></div><div><small>REFERENCE</small><strong>Average · rank ≤13</strong></div></div>
      </section>

      <aside className="inspector-panel source-inspector"><section className="inspector-lead"><span className="eyebrow">Interpretation</span><h2>{truthVisible ? 'What did the estimate miss?' : 'An ambiguous inverse problem.'}</h2><p>{!simulation ? 'First plant four known currents and observe their scalp mixtures.' : !result ? 'The inverse must estimate many currents from only 14 channels. Regularization chooses one solution among many possibilities.' : !truthVisible ? 'Inspect every detected peak before revealing the answer. Two alpha sources may form one maximum; noise can create extra peaks. Four planted sources do not guarantee four detections.' : 'Compare missed sources and unmatched peaks alongside distance. A small error among matched peaks can coexist with poor detection.'}</p></section>
        <section className="source-truth-summary"><h3>Simulation answer</h3>{!truthVisible ? <><p>Locations and evaluation appear after you inspect the estimate.</p><button className="reveal-button" disabled={!result || !!busy} onClick={() => { setTruthVisible(true); setView('Power map') }}><Eye size={16} /> Reveal and evaluate</button></> : result && <>
          <dl><div><dt>Matched / planted</dt><dd>{result.evaluation.matched_count} / {result.rois.length}</dd></div><div><dt>Missed sources</dt><dd>{result.evaluation.missed_count}</dd></div><div><dt>Unmatched peaks</dt><dd>{result.evaluation.unmatched_peak_count}</dd></div></dl>
          <p>Fixed theta/alpha/beta bands; one-to-one matches within {result.evaluation.match_radius_mm} mm. Broadband is not counted. Match tolerance is a scoring rule, not spatial accuracy.</p>
          {result.evaluation.outside_band_roi_ids.length > 0 && <p>Not scored outside the analysis bands: {result.evaluation.outside_band_roi_ids.join(', ')}.</p>}
          <ul>{result.rois.map((roi) => <li key={roi.id}><strong>{roi.label} · {roi.frequency_hz} Hz</strong><span>{coordinates(roi.position_mm)} mm</span></li>)}</ul>
        </>}</section>
        <section className="source-learning-experiments"><h3>Try a harder case</h3><ol><li>Set phase lag to 0°. Do two alpha peaks remain?</li><li>Raise sensor noise. Which peaks move or appear?</li><li>Increase peak separation to 100 mm. How many sources are missed?</li><li>Compare regularization settings on the same EEG.</li></ol><p>Decide your settings before revealing truth. Adjusting them to improve a known score is exploratory tuning, not independent validation.</p></section>
        <div className="nonclinical"><AlertTriangle size={15} /><span>Spherical, fixed-orientation teaching model. Simulation and inverse share geometry; real head-model mismatch is not tested. More grid points do not add sensor information.</span></div>
        {result && <section className="source-methods"><span className="eyebrow">Recorded method</span><p>{result.inverse_method}</p><p>Hann-window periodogram · integrated band power (nAm²) · local maxima · relative threshold · distance suppression</p><small>Seed {result.provenance.seed} · recipe {result.provenance.recipe_hash}</small></section>}
      </aside>
    </main>
    <footer className="run-strip source-run-strip"><div className="run-strip-title">Source localization</div><p className="source-footer-status">{busy ? 'Calculating…' : result ? 'Estimate complete. Peaks are determined from reconstructed power only.' : simulation ? 'EEG generated. Ready for source estimation.' : 'Generate EEG to begin.'}</p></footer>
  </>
}

function SourceIntroduction({ count, recipe }: { count: number; recipe: SourceModelRecipe }) {
  return <div className="source-empty"><span className="eyebrow">A known simulation · an uncertain reconstruction</span><h3>Plant four sources. Let the estimate find its own peaks.</h3><p className="source-empty-lede">Two frontal points produce 10 Hz alpha with a {recipe.phase_lag_deg}° timing offset. Two parietal points produce 7 Hz and 18 Hz comparison signals. We project their currents to scalp EEG, then reconstruct the activity using only that EEG and the head model.</p>
    <svg className="source-intro-head" viewBox="0 0 320 220" role="img" aria-label="Schematic frontal alpha pair and parietal comparison sources"><ellipse cx="160" cy="112" rx="126" ry="98" className="source-head-outline" /><path d="M148 15 L160 2 L172 15" className="source-head-nose" /><text x="160" y="42" textAnchor="middle">FRONT</text>{[[92, 80, '10 Hz'], [228, 80, '10 Hz'], [92, 155, '7 Hz'], [228, 155, '18 Hz']].map(([x, y, label], i) => <g key={i}><circle cx={x} cy={y} r="12" fill={i < 2 ? '#087f83' : '#615b91'} /><text x={x} y={Number(y) + 30} textAnchor="middle">{label}</text></g>)}</svg>
    <ol className="source-learning-flow"><li><small>1 · GENERATE</small><span>Four currents create mixtures at 14 scalp electrodes.</span></li><li><small>2 · RECONSTRUCT</small><span>Estimate current at {count} possible locations on a {recipe.grid_spacing_mm} mm grid.</span></li><li><small>3 · DETECT</small><span>Find spatial power peaks with no preset source count.</span></li><li><small>4 · REVEAL</small><span>Measure displacement, missed sources and unmatched peaks.</span></li></ol>
    <p className="source-learning-goal">The candidate grid is the set of locations the model can represent. It does not say where activity really occurred. Minimum norm can spread activity across many points; even a clean simulation may not recover the planted locations exactly.</p>
  </div>
}

function SourceRange({ label, help, value, min, max, step, unit, disabled, onChange }: { label: string; help: string; value: number; min: number; max: number; step: number; unit: string; disabled: boolean; onChange: (value: number) => void }) {
  return <label className="range-control connectivity-range"><span><span className="control-label">{label}<ControlHint>{help}</ControlHint></span><output>{Number(value.toFixed(2))} {unit}</output></span><input type="range" aria-label={label} value={value} min={min} max={max} step={step} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} style={{ '--range-progress': (value - min) / (max - min) * 100 + '%' } as React.CSSProperties} /><small><span>{min}</span><span>{max}</span></small></label>
}
