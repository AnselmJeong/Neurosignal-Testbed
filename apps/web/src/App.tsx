import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  Eye,
  EyeOff,
  FileJson,
  FlaskConical,
  History,
  Info,
  Layers3,
  Play,
  Redo2,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Upload,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { LineChart } from './components/Charts'
import { ConnectivityWorkbench } from './components/ConnectivityWorkbench'
import { IcaWorkbench } from './components/IcaWorkbench'
import { MixingMatrix } from './components/MixingMatrix'
import { RealDataWorkbench } from './components/RealDataWorkbench'
import { SourceModelWorkbench } from './components/SourceModelWorkbench'
import { checkHealth, runRecipe } from './lib/api'
import { defaultRecipe, type ExperimentRecipe, type ExperimentResult, type RequestState } from './types'

const STEPS = [
  { label: 'Predict', icon: CircleHelp },
  { label: 'Generate', icon: Sparkles },
  { label: 'Observe', icon: Activity },
  { label: 'Filter', icon: SlidersHorizontal },
  { label: 'Compare', icon: Layers3 },
  { label: 'Reveal', icon: Eye },
]

const VIEWS = ['Signal', 'Spectrum', 'Filter response', 'Mixing'] as const
type View = (typeof VIEWS)[number]

const cloneRecipe = (recipe: ExperimentRecipe): ExperimentRecipe => structuredClone(recipe)

function App() {
  const [activeLab, setActiveLab] = useState<'filter' | 'ica' | 'connectivity' | 'source' | 'real'>('filter')
  const [recipe, setRecipe] = useState<ExperimentRecipe>(() => cloneRecipe(defaultRecipe))
  const [past, setPast] = useState<ExperimentRecipe[]>([])
  const [future, setFuture] = useState<ExperimentRecipe[]>([])
  const [request, setRequest] = useState<RequestState>({ status: 'idle' })
  const [baseline, setBaseline] = useState<ExperimentResult | null>(null)
  const [runs, setRuns] = useState<ExperimentResult[]>([])
  const [view, setView] = useState<View>('Signal')
  const [step, setStep] = useState(0)
  const [prediction, setPrediction] = useState('The 10 Hz peak will remain. The 60 Hz peak should be suppressed by the low-pass filter.')
  const [truthVisible, setTruthVisible] = useState(false)
  const [serviceReady, setServiceReady] = useState<boolean | null>(null)
  const [projectTitle, setProjectTitle] = useState('My first truth loop')
  const [editingTitle, setEditingTitle] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)

  const result = request.status === 'success' ? request.data : runs[0] ?? null
  const dirty = result ? JSON.stringify(recipe) !== JSON.stringify(result.recipe) : true

  useEffect(() => {
    const controller = new AbortController()
    checkHealth(controller.signal).then(setServiceReady).catch(() => setServiceReady(false))
    return () => controller.abort()
  }, [])

  function commit(next: ExperimentRecipe) {
    setPast((items) => [...items.slice(-30), cloneRecipe(recipe)])
    setFuture([])
    setRecipe(next)
  }

  function updateSimulation<K extends keyof ExperimentRecipe['simulation']>(key: K, value: ExperimentRecipe['simulation'][K]) {
    commit({ ...recipe, simulation: { ...recipe.simulation, [key]: value } })
  }

  function updatePreprocessing<K extends keyof ExperimentRecipe['preprocessing']>(key: K, value: ExperimentRecipe['preprocessing'][K]) {
    commit({ ...recipe, preprocessing: { ...recipe.preprocessing, [key]: value } })
  }

  function undo() {
    const previous = past.at(-1)
    if (!previous) return
    setFuture((items) => [cloneRecipe(recipe), ...items])
    setPast((items) => items.slice(0, -1))
    setRecipe(previous)
  }

  function redo() {
    const next = future[0]
    if (!next) return
    setPast((items) => [...items, cloneRecipe(recipe)])
    setFuture((items) => items.slice(1))
    setRecipe(next)
  }

  async function execute() {
    if (!prediction.trim()) {
      setStep(0)
      return
    }
    setTruthVisible(false)
    setStep(1)
    setRequest({ status: 'loading', stage: 'Generating known sources', progress: 18 })
    const progressTimer = window.setInterval(() => {
      setRequest((current) => {
        if (current.status !== 'loading') return current
        const next = Math.min(current.progress + 14, 88)
        const stage = next < 45 ? 'Projecting into sensors' : next < 72 ? 'Applying reference and filter' : 'Computing spectra and provenance'
        return { status: 'loading', stage, progress: next }
      })
    }, 180)
    try {
      const nextResult = await runRecipe(recipe)
      window.clearInterval(progressTimer)
      setRequest({ status: 'success', data: nextResult })
      setRuns((items) => [nextResult, ...items.filter((item) => item.run_id !== nextResult.run_id)].slice(0, 8))
      setBaseline((current) => current ?? nextResult)
      setStep(2)
      setServiceReady(true)
    } catch (error) {
      window.clearInterval(progressTimer)
      setRequest({ status: 'error', message: error instanceof Error ? error.message : 'The run could not be completed.' })
      setServiceReady(false)
    }
  }

  function revealTruth() {
    setTruthVisible(true)
    setStep(5)
    setView('Spectrum')
  }

  function exportRecipe() {
    const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `neurobridge-${recipe.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function importRecipe(file: File | undefined) {
    if (!file) return
    try {
      const next = JSON.parse(await file.text()) as ExperimentRecipe
      if (next.recipe_version !== '1.0' || !next.simulation || !next.preprocessing) throw new Error('Unsupported recipe')
      commit(next)
      setTruthVisible(false)
    } catch {
      setRequest({ status: 'error', message: 'This file is not a compatible NeuroBridge 1.0 recipe.' })
    }
  }

  const peakSummary = useMemo(() => {
    if (!result) return 'Run the recipe to estimate peaks.'
    return result.peak_frequencies_hz.length ? `${result.peak_frequencies_hz.join(' · ')} Hz` : 'No stable peak found'
  }, [result])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><Activity size={22} strokeWidth={2.1} /></div>
          <div>
            <strong>NeuroBridge</strong>
            <span>EEG LAB</span>
          </div>
        </div>
        <div className="project-context">
          <span className="eyebrow">Experiment project</span>
          {editingTitle ? (
            <input
              className="title-input"
              autoFocus
              value={projectTitle}
              onChange={(event) => setProjectTitle(event.target.value)}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(event) => event.key === 'Enter' && setEditingTitle(false)}
              aria-label="Project name"
            />
          ) : (
            <button className="project-name" onClick={() => setEditingTitle(true)}>{projectTitle} <ChevronDown size={13} /></button>
          )}
        </div>
        <div className="header-actions">
          <div className="lab-switcher" role="group" aria-label="Active guided lab">
            <button className={activeLab === 'filter' ? 'active' : ''} onClick={() => setActiveLab('filter')}>01 · Sampling</button>
            <button className={activeLab === 'ica' ? 'active' : ''} onClick={() => setActiveLab('ica')}>02 · ICA</button>
            <button className={activeLab === 'connectivity' ? 'active' : ''} onClick={() => setActiveLab('connectivity')}>03 · Connectivity</button>
            <button className={activeLab === 'source' ? 'active' : ''} onClick={() => setActiveLab('source')}>04 · Source</button>
            <button className={activeLab === 'real' ? 'active' : ''} onClick={() => setActiveLab('real')}>05 · Real data</button>
          </div>
          <span className={`service-state ${serviceReady === false ? 'offline' : ''}`}>
            <i />{serviceReady === null ? 'Checking service' : serviceReady ? 'Local service ready' : 'Service offline'}
          </span>
          {activeLab === 'filter' && (
            <>
              <button className="icon-button" onClick={undo} disabled={!past.length} aria-label="Undo parameter change"><RotateCcw size={17} /></button>
              <button className="icon-button" onClick={redo} disabled={!future.length} aria-label="Redo parameter change"><Redo2 size={17} /></button>
              <button className="quiet-button" onClick={exportRecipe}><Download size={15} /> Recipe</button>
              <button className="primary-button" onClick={execute} disabled={request.status === 'loading'}>
                {request.status === 'loading' ? <Zap size={16} /> : <Play size={16} fill="currentColor" />}
                {request.status === 'loading' ? 'Running' : dirty ? 'Run changes' : 'Run again'}
              </button>
            </>
          )}
        </div>
      </header>

      {activeLab === 'ica' ? <IcaWorkbench /> : activeLab === 'connectivity' ? <ConnectivityWorkbench /> : activeLab === 'source' ? <SourceModelWorkbench /> : activeLab === 'real' ? <RealDataWorkbench /> : <>
        <main className="workspace">
        <nav className="lesson-rail" aria-label="Lesson progress">
          <div className="rail-top"><BookOpen size={17} /><span>LAB 01</span></div>
          <ol>
            {STEPS.map((item, index) => {
              const Icon = item.icon
              return (
                <li key={item.label} className={index === step ? 'active' : index < step ? 'done' : ''}>
                  <button onClick={() => setStep(index)} aria-current={index === step ? 'step' : undefined}>
                    <span className="step-dot">{index < step ? <Check size={13} /> : <Icon size={15} />}</span>
                    <small>0{index + 1}</small>
                    <strong>{item.label}</strong>
                  </button>
                </li>
              )
            })}
          </ol>
          <div className="rail-bottom"><FlaskConical size={17} /><span>8 min</span></div>
        </nav>

        <aside className="control-panel">
          <div className="panel-heading">
            <span className="eyebrow">Foundations · guided</span>
            <h1>What survives<br />the sensor?</h1>
            <p>Change one factor. Predict the result before the known signal is revealed.</p>
          </div>

          <section className="prediction-block">
            <label htmlFor="prediction"><CircleHelp size={15} /> Your prediction</label>
            <textarea id="prediction" value={prediction} onChange={(event) => setPrediction(event.target.value)} rows={3} />
          </section>

          <section className="control-section">
            <div className="section-title"><span>Signal</span><small>KNOWN SOURCES</small></div>
            <div className="source-list">
              {recipe.simulation.sources.map((source) => (
                <div className="source-row" key={source.id}>
                  <span><i className={`source-dot ${source.id}`} />{source.label}</span>
                  <strong>{source.frequency_hz} Hz</strong>
                  <small>{source.amplitude_uv} µV</small>
                </div>
              ))}
            </div>
            <RangeControl
              label="Sampling rate"
              value={recipe.simulation.sampling_rate_hz}
              min={100}
              max={500}
              step={50}
              unit="Hz"
              onChange={(value) => updateSimulation('sampling_rate_hz', value)}
            />
            <RangeControl
              label="Sensor noise"
              value={recipe.simulation.noise_uv}
              min={0}
              max={20}
              step={1}
              unit="µV"
              onChange={(value) => updateSimulation('noise_uv', value)}
            />
          </section>

          <section className="control-section">
            <div className="section-title"><span>Transform</span><small>REVERSIBLE</small></div>
            <RangeControl
              label="High-pass"
              value={recipe.preprocessing.highpass_hz ?? 0}
              min={0.5}
              max={8}
              step={0.5}
              unit="Hz"
              onChange={(value) => updatePreprocessing('highpass_hz', value)}
            />
            <RangeControl
              label="Low-pass"
              value={recipe.preprocessing.lowpass_hz ?? 40}
              min={15}
              max={90}
              step={5}
              unit="Hz"
              onChange={(value) => updatePreprocessing('lowpass_hz', value)}
            />
            <div className="segmented-field">
              <span>Reference</span>
              <div role="group" aria-label="Reference method">
                <button className={recipe.preprocessing.reference === 'average' ? 'selected' : ''} onClick={() => updatePreprocessing('reference', 'average')}>Average</button>
                <button className={recipe.preprocessing.reference === 'none' ? 'selected' : ''} onClick={() => updatePreprocessing('reference', 'none')}>None</button>
              </div>
            </div>
          </section>

          <div className="recipe-actions">
            <button onClick={() => importRef.current?.click()}><Upload size={15} /> Import</button>
            <button onClick={exportRecipe}><FileJson size={15} /> Export JSON</button>
            <input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(event) => void importRecipe(event.target.files?.[0])} />
          </div>
        </aside>

        <section className="canvas-panel">
          <div className="canvas-toolbar">
            <div>
              <span className="eyebrow">Primary canvas</span>
              <h2>{view === 'Signal' ? 'Sensor trace · EEG 01' : view}</h2>
            </div>
            <div className="view-tabs" role="tablist" aria-label="Visualization type">
              {VIEWS.map((item) => <button key={item} role="tab" aria-selected={item === view} className={item === view ? 'active' : ''} onClick={() => setView(item)}>{item}</button>)}
            </div>
            <div className="canvas-status">
              <span>{result ? `RUN ${result.run_id.slice(-4).toUpperCase()}` : 'NO RUN'}</span>
              {dirty && <em>Pending changes</em>}
            </div>
          </div>

          <div className="visual-stage">
            {request.status === 'loading' && (
              <div className="run-overlay" role="status" aria-live="polite">
                <div className="orbit"><Activity size={26} /></div>
                <span className="eyebrow">Scientific pipeline</span>
                <h3>{request.stage}</h3>
                <div className="progress-track"><i style={{ width: `${request.progress}%` }} /></div>
                <p>{request.progress}% · deterministic run · seed {recipe.simulation.seed}</p>
              </div>
            )}
            {request.status === 'error' && (
              <div className="empty-stage error-stage">
                <AlertTriangle size={30} />
                <h3>Run stopped safely</h3>
                <p>{request.message}</p>
                <button className="quiet-button" onClick={execute}>Try again</button>
              </div>
            )}
            {!result && request.status !== 'loading' && request.status !== 'error' && (
              <div className="empty-stage">
                <div className="empty-wave" aria-hidden="true"><Activity size={42} /></div>
                <span className="eyebrow">Ready to experiment</span>
                <h3>Record a prediction, then run the known mixture.</h3>
                <p>The first result stays hidden until your prediction is saved above.</p>
                <button className="primary-button" onClick={execute}><Play size={15} fill="currentColor" /> Run default recipe</button>
              </div>
            )}
            {result && request.status !== 'loading' && view === 'Signal' && (
              <LineChart
                x={result.traces.x}
                series={Object.entries(result.traces.series).map(([label, values], index) => ({ label, values, color: index ? '#087f83' : '#a8aaa5', dashed: !index }))}
                xLabel="Time (s)"
                yLabel="Amplitude (µV)"
                ariaLabel="Raw and filtered EEG channel 1 time series"
              />
            )}
            {result && request.status !== 'loading' && view === 'Spectrum' && (
              <LineChart
                x={result.spectrum.frequency_hz}
                series={[
                  { label: 'Raw PSD', values: result.spectrum.raw_power, color: '#a8aaa5', dashed: true },
                  { label: 'Filtered PSD', values: result.spectrum.filtered_power, color: '#087f83' },
                ]}
                xDomain={[0, Math.min(80, result.recipe.simulation.sampling_rate_hz / 2)]}
                xLabel="Frequency (Hz)"
                yLabel="Power (log µV²/Hz)"
                ariaLabel="Raw and filtered Welch power spectral density"
                logY
                markers={truthVisible ? result.truth_peaks_hz : []}
              />
            )}
            {result && request.status !== 'loading' && view === 'Filter response' && (
              <LineChart
                x={result.filter_response.frequency_hz}
                series={[{ label: `${result.recipe.preprocessing.highpass_hz}–${result.recipe.preprocessing.lowpass_hz} Hz gain`, values: result.filter_response.gain_db, color: '#087f83' }]}
                xLabel="Frequency (Hz)"
                yLabel="Gain (dB)"
                yDomain={[-80, 5]}
                ariaLabel="Actual digital filter response in decibels"
              />
            )}
            {result && request.status !== 'loading' && view === 'Mixing' && (
              <div className="mixing-stage">
                <div>
                  <span className="eyebrow">Explicit linear mixture</span>
                  <h3>Every sensor sees more than one source.</h3>
                  <p>Sign and intensity encode how each latent source contributes to each channel. This is why a sensor trace is not a direct view of one neural generator.</p>
                </div>
                <MixingMatrix values={result.mixing_matrix} />
              </div>
            )}
          </div>

          <div className="canvas-readout">
            <div><small>ESTIMATED PEAKS</small><strong>{peakSummary}</strong></div>
            <div><small>RETAINED VARIANCE</small><strong>{result ? `${result.retained_variance_pct}%` : '—'}</strong></div>
            <div><small>ANALYSIS SPACE</small><strong>Sensor · µV</strong></div>
            <div><small>REFERENCE</small><strong>{recipe.preprocessing.reference === 'average' ? 'Average' : 'None'}</strong></div>
          </div>
        </section>

        <aside className="inspector-panel">
          <section className="inspector-lead">
            <span className="eyebrow">Interpretation</span>
            <h2>{truthVisible ? 'Truth, with limits.' : 'Reason before reveal.'}</h2>
            <p>{truthVisible ? 'Compare what was planted with what the estimator retained. A match here validates this controlled recipe, not every EEG analysis.' : 'Inspect the trace, spectrum, and filter response. The source labels remain visible, but the numeric answer stays covered.'}</p>
          </section>

          {result?.warnings.map((warning) => (
            <section className={`warning-card ${warning.severity}`} key={warning.code}>
              <div>{warning.severity === 'warning' ? <AlertTriangle size={17} /> : <Info size={17} />}<strong>{warning.title}</strong></div>
              <p>{warning.explanation}</p>
              {warning.suggestion && <small>{warning.suggestion}</small>}
            </section>
          ))}

          <section className={`truth-block ${truthVisible ? 'revealed' : ''}`}>
            <div className="truth-heading">
              <span><EyeOff size={16} /> Simulation truth</span>
              <span className="truth-state">{truthVisible ? 'REVEALED' : 'HIDDEN'}</span>
            </div>
            {truthVisible && result ? (
              <div className="truth-content">
                <div className="truth-peaks">
                  {result.truth_peaks_hz.map((peak) => <span key={peak}><strong>{peak}</strong> Hz</span>)}
                </div>
                <p>The 10 Hz alpha source sits inside the passband. The 60 Hz source is strongly attenuated by the 40 Hz low-pass. At 100 Hz sampling, 60 Hz folds to 40 Hz before filtering.</p>
                <button className="text-button" onClick={() => setView('Spectrum')}>Inspect against spectrum <ArrowRight size={14} /></button>
              </div>
            ) : (
              <div className="truth-covered">
                <div className="blur-lines"><i /><i /><i /></div>
                <button className="reveal-button" disabled={!result} onClick={revealTruth}><Eye size={16} /> Reveal after prediction</button>
              </div>
            )}
          </section>

          {result && (
            <section className="provenance-block">
              <div className="section-title"><span>Provenance</span><small>IMMUTABLE RUN</small></div>
              <dl>
                <div><dt>Recipe</dt><dd>{result.provenance.recipe_hash}</dd></div>
                <div><dt>Seed</dt><dd>{result.provenance.seed}</dd></div>
                <div><dt>Sampling</dt><dd>{result.provenance.sampling_rate_hz} Hz</dd></div>
                <div><dt>Rank</dt><dd>{result.provenance.rank} / {result.recipe.simulation.channel_count}</dd></div>
                <div><dt>Engine</dt><dd>v{result.provenance.engine_version}</dd></div>
                <div><dt>Units</dt><dd>V → µV</dd></div>
              </dl>
            </section>
          )}

          <div className="nonclinical"><AlertTriangle size={15} /><span>Educational and research use only.<br />Not for clinical diagnosis.</span></div>
        </aside>
      </main>

      <footer className="run-strip">
        <div className="run-strip-title"><History size={16} /><span>Run history</span><small>{runs.length} local</small></div>
        <div className="run-list">
          {!runs.length && <span className="no-runs">Completed runs will appear here for A/B comparison.</span>}
          {runs.map((item, index) => (
            <button
              key={item.run_id}
              className={`${result?.run_id === item.run_id ? 'active' : ''} ${baseline?.run_id === item.run_id ? 'baseline' : ''}`}
              onClick={() => setRequest({ status: 'success', data: item })}
            >
              <span>RUN {String(runs.length - index).padStart(2, '0')}</span>
              <strong>{item.recipe.simulation.sampling_rate_hz} Hz · {item.recipe.preprocessing.lowpass_hz} Hz LP</strong>
              <small>{baseline?.run_id === item.run_id ? 'PINNED BASELINE' : item.provenance.recipe_hash}</small>
            </button>
          ))}
        </div>
        <div className="strip-actions">
          <button onClick={() => result && setBaseline(result)} disabled={!result}><Save size={15} /> Pin baseline</button>
          <button onClick={() => { setRecipe(cloneRecipe(defaultRecipe)); setPast([]); setFuture([]) }}><RotateCcw size={15} /> Reset draft</button>
        </div>
        </footer>
      </>}
    </div>
  )
}

interface RangeControlProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (value: number) => void
}

function RangeControl({ label, value, min, max, step, unit, onChange }: RangeControlProps) {
  const progress = ((value - min) / (max - min)) * 100
  return (
    <label className="range-control">
      <span>{label}<output>{value} {unit}</output></span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ '--range-progress': `${progress}%` } as React.CSSProperties}
      />
      <small><span>{min}</span><span>{max}</span></small>
    </label>
  )
}

export default App
