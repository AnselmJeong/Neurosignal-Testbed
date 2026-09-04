import {
  AlertTriangle,
  BrainCircuit,
  CircleHelp,
  Eye,
  EyeOff,
  MapPinned,
  Play,
  ScanLine,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Waves,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { runSourceModel } from '../lib/api'
import {
  defaultSourceModelRecipe,
  type SourceModelRecipe,
  type SourceModelRequestState,
} from '../types'
import { LineChart } from './Charts'
import { ControlHint } from './ControlHint'
import { LabNavigator, type LabId } from './LabNavigator'

const STEPS = [
  { label: 'Predict', icon: CircleHelp },
  { label: 'Project', icon: Waves },
  { label: 'Reconstruct', icon: BrainCircuit },
  { label: 'Extract', icon: MapPinned },
  { label: 'Compare', icon: ScanLine },
  { label: 'Reveal', icon: Eye },
] as const

const VIEWS = ['Sensor', 'ROI traces', 'Forward maps', 'Leakage'] as const
type SourceView = (typeof VIEWS)[number]

export function SourceModelWorkbench({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [recipe, setRecipe] = useState<SourceModelRecipe>(() => structuredClone(defaultSourceModelRecipe))
  const [request, setRequest] = useState<SourceModelRequestState>({ status: 'idle' })
  const [view, setView] = useState<SourceView>('ROI traces')
  const [truthVisible, setTruthVisible] = useState(false)
  const [step, setStep] = useState(0)
  const [prediction, setPrediction] = useState('The frontal pair should reconstruct near their planted vertices, but their ROI traces will still show some cross-talk.')

  const result = request.status === 'success' ? request.data : null
  const isBusy = request.status === 'loading'

  function updateRecipe<K extends keyof SourceModelRecipe>(key: K, value: SourceModelRecipe[K]) {
    setRecipe((current) => ({ ...current, [key]: value }))
    setRequest({ status: 'idle' })
    setTruthVisible(false)
    setStep(0)
  }

  async function execute() {
    if (!prediction.trim()) return
    setTruthVisible(false)
    setStep(1)
    setRequest({ status: 'loading', stage: 'Building the spherical template source space', progress: 12 })
    const timer = window.setInterval(() => {
      setRequest((current) => {
        if (current.status !== 'loading') return current
        const progress = Math.min(90, current.progress + 11)
        const stage = progress < 36
          ? 'Forward-projecting known ROI signals to the 10–20 montage'
          : progress < 63
            ? 'Applying MNE minimum-norm inverse reconstruction'
            : 'Extracting ROI time courses and source-resolution leakage'
        return { status: 'loading', stage, progress }
      })
    }, 230)
    try {
      const data = await runSourceModel(recipe)
      window.clearInterval(timer)
      setRequest({ status: 'success', data })
      setStep(4)
    } catch (error) {
      window.clearInterval(timer)
      setRequest({ status: 'error', message: error instanceof Error ? error.message : 'The source-modeling pipeline stopped safely.' })
    }
  }

  function revealTruth() {
    setTruthVisible(true)
    setStep(5)
    setView('ROI traces')
  }

  const interpretation = useMemo(() => {
    if (!result) return 'Run the template benchmark before locating an ROI.'
    if (!truthVisible) return 'First inspect the reconstruction and leakage. The planted vertices stay hidden until you commit to an interpretation.'
    const correlation = Math.round(result.scores.mean_roi_correlation * 100)
    const crossTalk = Math.round(result.scores.max_roi_cross_talk * 100)
    return `${correlation}% mean ROI-waveform agreement, with up to ${crossTalk}% cross-talk in the MNE resolution matrix. Recovery does not remove the leakage caveat.`
  }, [result, truthVisible])

  return (
    <>
      <main className="workspace source-workspace">
        <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={STEPS} step={step} onStep={setStep} />

        <aside className="control-panel source-controls">
          <div className="panel-heading">
            <span className="eyebrow">Source modeling · template benchmark</span>
            <h1>Where does the<br />estimate spread?</h1>
            <p>Project known ROI activity, reconstruct it, then judge the estimate alongside its leakage.</p>
          </div>
          <section className="prediction-block compact-prediction">
            <label htmlFor="source-prediction"><CircleHelp size={15} /> Your prediction</label>
            <textarea id="source-prediction" value={prediction} onChange={(event) => setPrediction(event.target.value)} rows={3} />
          </section>
          <section className="control-section">
            <div className="section-title"><span>Template forward model</span><small>EDUCATIONAL ONLY</small></div>
            <p className="source-method-note">14-channel standard 10–20 montage · 90 mm sphere · 26 volume vertices</p>
            <SourceRange label="Alpha phase lag" help="The timing offset between the planted alpha sources. It changes the observed source and sensor patterns." value={recipe.phase_lag_deg} min={0} max={120} step={5} unit="°" onChange={(value) => updateRecipe('phase_lag_deg', value)} />
            <SourceRange label="Source amplitude" help="The size of the planted ROI currents before they are projected to the scalp sensors." value={recipe.source_amplitude_nam} min={5} max={50} step={1} unit="nAm" onChange={(value) => updateRecipe('source_amplitude_nam', value)} />
            <SourceRange label="Sensor noise" help="Random voltage added at the scalp sensors after forward projection. It makes reconstruction less certain." value={recipe.sensor_noise_uv} min={0} max={1} step={0.02} unit="µV" onChange={(value) => updateRecipe('sensor_noise_uv', value)} />
          </section>
          <section className="control-section source-contract-note">
            <div className="section-title"><span>Inverse</span><small>LOCKED FOR COMPARISON</small></div>
            <strong>MNE minimum norm</strong><p>λ² = 1/9 · average-reference projector · explicit source-resolution matrix</p>
          </section>
          <button className="primary-button fit-button" onClick={execute} disabled={isBusy}><Play size={16} fill="currentColor" /> {result ? 'Run changed benchmark' : 'Run source benchmark'}</button>
        </aside>

        <section className="canvas-panel source-canvas">
          <div className="canvas-toolbar source-toolbar">
            <div><span className="eyebrow">Latent → sensor → inverse → ROI</span><h2>{result ? `MNE inverse · ${result.scores.benchmark_passed ? 'benchmark passes' : 'inspect the benchmark'}` : 'No source estimate yet'}</h2></div>
            <div className="view-tabs" role="tablist" aria-label="Source modeling visualization type">
              {VIEWS.map((item) => <button key={item} role="tab" aria-selected={item === view} className={item === view ? 'active' : ''} onClick={() => setView(item)}>{item}</button>)}
            </div>
          </div>
          <div className="source-stage">
            {isBusy && <div className="run-overlay" role="status" aria-live="polite"><div className="orbit"><BrainCircuit size={27} /></div><span className="eyebrow">MNE source pipeline</span><h3>{request.stage}</h3><div className="progress-track"><i style={{ width: `${request.progress}%` }} /></div><p>{request.progress}% · 14 sensors · spherical template</p></div>}
            {request.status === 'error' && <div className="empty-stage error-stage"><AlertTriangle size={30} /><h3>Analysis stopped safely</h3><p>{request.message}</p></div>}
            {request.status === 'idle' && <div className="source-empty"><div className="source-preview" aria-hidden="true"><i /><i /><i /><i /><span /><span /><span /><span /></div><span className="eyebrow">Four planted ROI proxies · hidden truth</span><h3>Forward model first. Localization second.</h3><p>The exact same known time courses are projected to sensors and reconstructed with a documented MNE inverse.</p><button className="primary-button" onClick={execute}><BrainCircuit size={15} /> Run template benchmark</button></div>}
            {result && view === 'Sensor' && <div className="source-chart"><LineChart x={result.sensor_trace.x} series={Object.entries(result.sensor_trace.series).slice(0, 4).map(([label, values]) => ({ label, values }))} xLabel="Time (s)" yLabel="Sensor voltage (µV)" ariaLabel="Forward-projected sensor traces" /></div>}
            {result && view === 'ROI traces' && <div className="source-chart"><LineChart x={result.latent_roi_time_courses.x} series={Object.entries(result.reconstructed_roi_time_courses.series).map(([label, values]) => ({ label: `${label} reconstructed`, values })).concat(truthVisible ? Object.entries(result.latent_roi_time_courses.series).map(([label, values]) => ({ label: `${label} latent`, values, dashed: true })) : [])} xLabel="Time (s)" yLabel="Source current (nAm)" ariaLabel="Reconstructed ROI time courses and optionally planted latent time courses" /></div>}
            {result && view === 'Forward maps' && <ForwardMaps result={result} truthVisible={truthVisible} />}
            {result && view === 'Leakage' && <LeakageMatrix labels={result.rois.map((roi) => roi.label)} values={result.scores.leakage_matrix} />}
          </div>
          <div className="canvas-readout source-readout"><div><small>ROI AGREEMENT</small><strong>{result ? `${Math.round(result.scores.mean_roi_correlation * 100)}%` : '—'}</strong></div><div><small>MAX LOCATION ERROR</small><strong>{result ? `${result.scores.max_location_error_mm.toFixed(0)} mm` : '—'}</strong></div><div><small>MAX CROSS-TALK</small><strong>{result ? `${Math.round(result.scores.max_roi_cross_talk * 100)}%` : '—'}</strong></div><div><small>REFERENCE</small><strong>Average</strong></div></div>
        </section>

        <aside className="inspector-panel source-inspector">
          <section className="inspector-lead"><span className="eyebrow">Interpretation</span><h2>{truthVisible ? 'An estimate is not a location.' : 'Make a location claim cautiously.'}</h2><p>{interpretation}</p></section>
          {result?.warnings.map((warning) => <section className={`warning-card ${warning.severity}`} key={warning.code}><div><ShieldAlert size={16} /><strong>{warning.title}</strong></div><p>{warning.explanation}</p><small>{warning.suggestion}</small></section>)}
          <section className={`truth-block ${truthVisible ? 'revealed' : ''}`}><div className="truth-heading"><span><EyeOff size={16} /> Template ROI truth</span><span className="truth-state">{truthVisible ? 'REVEALED' : 'HIDDEN'}</span></div>{truthVisible && result ? <div className="truth-content source-truth"><ul>{result.rois.map((roi) => <li key={roi.id}><strong>{roi.label}</strong><span>{roi.position_mm.map((coordinate) => coordinate.toFixed(0)).join(', ')} mm</span><small>r = {result.scores.roi_correlations[roi.id]?.toFixed(2)} · error {result.scores.location_error_mm[roi.id]?.toFixed(0)} mm</small></li>)}</ul><p>These are planted vertices in an illustrative sphere. They validate this simulation only; they do not establish real-data localization accuracy.</p></div> : <div className="truth-covered"><div className="blur-lines"><i /><i /><i /></div><button className="reveal-button" disabled={!result} onClick={revealTruth}><Eye size={16} /> Reveal planted ROI truth</button></div>}</section>
          {result && <section className="source-methods"><span className="eyebrow">Recorded provenance</span><p>{result.forward_method}</p><p>{result.inverse_method}</p><small>Seed {result.provenance.seed} · rank {result.provenance.rank} · recipe {result.provenance.recipe_hash}</small></section>}
          <div className="nonclinical"><AlertTriangle size={15} /><span>Template reconstruction is not clinical localization.<br />Educational and research use only.</span></div>
        </aside>
      </main>
      <footer className="run-strip source-run-strip"><div className="run-strip-title"><SlidersHorizontal size={16} /><span>Truth contract</span></div><div className="source-contract-flow"><span><small>LATENT ROI</small>4 known proxies</span><i /><span><small>FORWARD</small>EEG sphere</span><i /><span><small>INVERSE</small>MNE minimum norm</span><i /><span><small>EXTRACT</small>ROI time courses</span><i /><span className={truthVisible ? 'verified' : ''}><small>CAVEAT</small>{truthVisible ? 'leakage inspected' : 'held out'}</span></div><div className="strip-actions"><button onClick={() => setView('Leakage')} disabled={!result}><Sparkles size={14} /> Inspect leakage</button></div></footer>
    </>
  )
}

function ForwardMaps({ result, truthVisible }: { result: NonNullable<Extract<SourceModelRequestState, { status: 'success' }>['data']>; truthVisible: boolean }) {
  return <div className="forward-maps"><div className="forward-map-copy"><span className="eyebrow">Lead-field fingerprints</span><h3>{truthVisible ? 'Known ROI → sensor topography' : 'Compare topographies before naming their source.'}</h3><p>Each bar is the normalized fixed-orientation lead field from MNE’s spherical forward solution.</p></div><div className="topography-grid">{result.sensor_topographies.map((topography) => <div className="topography-card" key={topography.roi_id}><strong>{truthVisible ? topography.label : 'Hidden ROI'}</strong><div>{topography.values.map((value, index) => <i key={index} style={{ height: `${Math.max(5, Math.abs(value) * 100)}%`, background: value >= 0 ? '#087f83' : '#c7653c' }} title={`${value.toFixed(2)}`} />)}</div></div>)}</div></div>
}

function LeakageMatrix({ labels, values }: { labels: string[]; values: number[][] }) {
  return <div className="leakage-stage"><div><span className="eyebrow">MNE source-resolution matrix</span><h3>How much one ROI appears in another</h3><p>Columns are planted sources and rows are extracted ROI proxies. Off-diagonal values are cross-talk, not evidence of a network edge.</p></div><div className="leakage-grid" style={{ gridTemplateColumns: `80px repeat(${labels.length}, minmax(48px, 1fr))` }}>{labels.map((label) => <span className="leakage-label top" key={`top-${label}`}>{label}</span>)}{values.map((row, rowIndex) => <div className="leakage-row" key={labels[rowIndex]}><span className="leakage-label">{labels[rowIndex]}</span>{row.map((value, columnIndex) => <span key={`${rowIndex}-${columnIndex}`} className={rowIndex === columnIndex ? 'leakage-cell diagonal' : 'leakage-cell'} style={{ backgroundColor: `rgba(0, 127, 131, ${Math.min(.1 + value * .9, 1)})` }}>{Math.round(value * 100)}%</span>)}</div>)}</div></div>
}

function SourceRange({ label, help, value, min, max, step, unit, onChange }: { label: string; help: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void }) {
  return <label className="connectivity-range"><span><span className="control-label">{label}<ControlHint>{help}</ControlHint></span><strong>{value}{unit && ` ${unit}`}</strong></span><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>
}
