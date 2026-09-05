import { StackedEegComparison } from './components/StackedEegBrowser'
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  CircleHelp,
  Download,
  Eye,
  EyeOff,
  FileJson,
  FolderKanban,
  History,
  Info,
  Layers3,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Upload,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { AboutExperience } from './components/AboutDialog'
import { LineChart } from './components/Charts'
import { ConnectivityWorkbench } from './components/ConnectivityWorkbench'
import { IcaWorkbench } from './components/IcaWorkbench'
import { ControlHint } from './components/ControlHint'
import { LabNavigator, type LabId } from './components/LabNavigator'
import { RealDataWorkbench } from './components/RealDataWorkbench'
import { QeegWorkbench } from './components/QeegWorkbench'
import { SourceModelWorkbench } from './components/SourceModelWorkbench'
import { checkHealth, runRecipe } from './lib/api'
import { defaultRecipe, type ExperimentRecipe, type ExperimentResult, type RequestState } from './types'

const STEPS = [
  { label: 'Predict', description: 'Write what you expect the filter to preserve.', icon: CircleHelp },
  { label: 'Generate', description: 'Create EEG from known source frequencies.', icon: Sparkles },
  { label: 'Observe', description: 'Inspect the unfiltered sensor signal.', icon: Activity },
  { label: 'Filter', description: 'Apply the selected preprocessing settings.', icon: SlidersHorizontal },
  { label: 'Compare', description: 'Examine changes in time and frequency.', icon: Layers3 },
  { label: 'Reveal', description: 'Check your prediction against the truth.', icon: Eye },
]

const VIEWS = ['Channel detail', 'Filter response'] as const
type View = (typeof VIEWS)[number]

const PROJECTS_STORAGE_KEY = 'neurosignal-workspace-projects'
const ACTIVE_PROJECT_STORAGE_KEY = 'neurosignal-active-workspace-project'
const LEGACY_PROJECTS_STORAGE_KEY = 'neurobridge-workspace-projects'
const LEGACY_ACTIVE_PROJECT_STORAGE_KEY = 'neurobridge-active-workspace-project'

const cloneRecipe = (recipe: ExperimentRecipe): ExperimentRecipe => structuredClone(recipe)
const formatWeight = (value: number | undefined) => value === undefined ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`

function App() {
  const [activeLab, setActiveLab] = useState<LabId>('filter')
  const [recipe, setRecipe] = useState<ExperimentRecipe>(() => cloneRecipe(defaultRecipe))
  const [past, setPast] = useState<ExperimentRecipe[]>([])
  const [future, setFuture] = useState<ExperimentRecipe[]>([])
  const [request, setRequest] = useState<RequestState>({ status: 'idle' })
  const [baseline, setBaseline] = useState<ExperimentResult | null>(null)
  const [runs, setRuns] = useState<ExperimentResult[]>([])
  const [view, setView] = useState<View>('Channel detail')
  const [selectedChannel, setSelectedChannel] = useState(0)
  const [step, setStep] = useState(0)
  const [prediction, setPrediction] = useState('The 10 Hz peak will remain. The 60 Hz peak should be suppressed by the low-pass filter.')
  const [truthVisible, setTruthVisible] = useState(false)
  const [serviceReady, setServiceReady] = useState<boolean | null>(null)
  const [projects, setProjects] = useState(() => {
    const saved = window.localStorage.getItem(PROJECTS_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_PROJECTS_STORAGE_KEY)
    return saved ? JSON.parse(saved) as { id: string; name: string }[] : [{ id: 'learning-workspace', name: 'Learning workspace' }]
  })
  const [activeProjectId, setActiveProjectId] = useState(() => (
    window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_ACTIVE_PROJECT_STORAGE_KEY)
      ?? 'learning-workspace'
  ))
  const [newProjectName, setNewProjectName] = useState('')
  const importRef = useRef<HTMLInputElement>(null)

  const result = request.status === 'success' ? request.data : runs[0] ?? null
  const dirty = result ? JSON.stringify(recipe) !== JSON.stringify(result.recipe) : true
  const channelCount = result?.recipe.simulation.channel_count ?? recipe.simulation.channel_count
  const selectedChannelIndex = Math.min(selectedChannel, Math.max(0, channelCount - 1))
  const selectedChannelName = `EEG ${String(selectedChannelIndex + 1).padStart(2, '0')}`
  const selectedRawTrace = result?.traces.series[`Raw · ${selectedChannelName}`] ?? []
  const selectedFilteredTrace = result?.traces.series[`Filtered · ${selectedChannelName}`] ?? []
  const selectedRawPower = result?.spectrum.raw_power_by_channel?.[selectedChannelName] ?? []
  const selectedFilteredPower = result?.spectrum.filtered_power_by_channel?.[selectedChannelName] ?? []
  const selectedChannelDataAvailable = selectedRawTrace.length > 0
    && selectedFilteredTrace.length > 0
    && selectedRawPower.length > 0
    && selectedFilteredPower.length > 0
  const selectedMixingWeights = result?.mixing_matrix[selectedChannelIndex] ?? []
  const referenceMeans = result?.mixing_matrix[0]?.map((_, sourceIndex) => (
    result.mixing_matrix.reduce((sum, row) => sum + (row[sourceIndex] ?? 0), 0) / result.mixing_matrix.length
  )) ?? []
  const selectedEffectiveWeights = selectedMixingWeights.map((weight, sourceIndex) => (
    recipe.preprocessing.reference === 'average' ? weight - (referenceMeans[sourceIndex] ?? 0) : weight
  ))
  const sourceContributions = selectedEffectiveWeights.map((weight, sourceIndex) => (
    Math.abs(weight * (result?.recipe.simulation.sources[sourceIndex]?.amplitude_uv ?? 0))
  ))
  const dominantSourceIndex = sourceContributions.length
    ? sourceContributions.indexOf(Math.max(...sourceContributions))
    : -1
  const dominantSource = dominantSourceIndex >= 0 ? result?.recipe.simulation.sources[dominantSourceIndex] : undefined
  const dominantEffectiveWeight = dominantSourceIndex >= 0 ? selectedEffectiveWeights[dominantSourceIndex] : undefined
  const dominantContribution = dominantSourceIndex >= 0 ? sourceContributions[dominantSourceIndex] : undefined

  useEffect(() => {
    const controller = new AbortController()
    checkHealth(controller.signal).then(setServiceReady).catch(() => setServiceReady(false))
    return () => controller.abort()
  }, [])

  useEffect(() => {
    window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects))
  }, [projects])

  useEffect(() => {
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeProjectId)
  }, [activeProjectId])

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0]

  function createProject() {
    const name = newProjectName.trim()
    if (!name) return
    const project = { id: crypto.randomUUID(), name }
    setProjects((items) => [...items, project])
    setActiveProjectId(project.id)
    setNewProjectName('')
  }

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
    setView('Channel detail')
  }

  function exportRecipe() {
    const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `neurosignal-${recipe.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`
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
      setRequest({ status: 'error', message: 'This file is not a compatible NeuroSignal 1.0 recipe.' })
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><Activity size={22} strokeWidth={2.1} /></div>
          <div>
            <strong>NeuroSignal</strong>
            <span>TESTBED</span>
          </div>
        </div>
        <details className="project-menu">
          <summary>
            <FolderKanban size={17} />
            <span><span className="eyebrow">Current project</span><strong>{activeProject?.name ?? 'Learning workspace'}</strong></span>
            <ChevronDown size={14} />
          </summary>
          <div className="project-menu-panel">
            <p>Projects keep your browser-based lab workspace separate. Imported recordings keep their own local FIF working-copy record.</p>
            <span className="eyebrow">Open project</span>
            <div className="project-list" role="list" aria-label="Open a project">
              {projects.map((project) => <button key={project.id} role="listitem" className={project.id === activeProjectId ? 'active' : ''} onClick={() => setActiveProjectId(project.id)}>{project.name}</button>)}
            </div>
            <label className="project-create-field"><span>New project name</span><input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && createProject()} placeholder="e.g. Pilot 01" /></label>
            <button className="project-create" onClick={createProject} disabled={!newProjectName.trim()}><Plus size={15} /> New project</button>
          </div>
        </details>
        <div className="header-actions">
          <AboutExperience />
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

      {activeLab === 'ica' ? <IcaWorkbench activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'connectivity' ? <ConnectivityWorkbench activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'source' ? <SourceModelWorkbench activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'real' ? <RealDataWorkbench activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'qeeg' ? <QeegWorkbench activeLab={activeLab} onLabChange={setActiveLab} /> : <>
        <main className="workspace">
        <LabNavigator activeLab={activeLab} onLabChange={setActiveLab} steps={STEPS} step={step} />

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
              help="How many samples the system records per second. A lower rate can make fast signals appear at the wrong frequency."
              value={recipe.simulation.sampling_rate_hz}
              min={100}
              max={500}
              step={50}
              unit="Hz"
              onChange={(value) => updateSimulation('sampling_rate_hz', value)}
            />
            <RangeControl
              label="EEG background"
              help="Sets the RMS level of 1/f-like background activity plus a small white sensor-noise component. Higher values make the known oscillations harder to recover."
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
              help="Reduces slow changes below this frequency. It can remove drift, but setting it too high can distort slow EEG activity."
              value={recipe.preprocessing.highpass_hz ?? 0}
              min={0.5}
              max={8}
              step={0.5}
              unit="Hz"
              onChange={(value) => updatePreprocessing('highpass_hz', value)}
            />
            <RangeControl
              label="Low-pass"
              help="Reduces fast changes above this frequency. It suppresses high-frequency noise and the planted 60 Hz signal in this lesson."
              value={recipe.preprocessing.lowpass_hz ?? 40}
              min={15}
              max={90}
              step={5}
              unit="Hz"
              onChange={(value) => updatePreprocessing('lowpass_hz', value)}
            />
            <div className="segmented-field">
              <span className="control-label">Reference<ControlHint>Sets the common voltage reference for all channels. Average reference changes the data rank and can change the observed sensor signal.</ControlHint></span>
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

        <section className="canvas-panel sampling-canvas">
          <div className="canvas-toolbar">
            <div>
              <span className="eyebrow">Primary canvas</span>
              <h2>{view === 'Channel detail' ? `${selectedChannelName} · signal, spectrum & weights` : view}</h2>
              {view === 'Channel detail' && (
                <div className="channel-switcher" role="group" aria-label="Simulated sensor channel">
                  {Array.from({ length: channelCount }, (_, index) => {
                    const label = `EEG ${String(index + 1).padStart(2, '0')}`
                    return <button key={label} aria-pressed={index === selectedChannelIndex} className={index === selectedChannelIndex ? 'active' : ''} onClick={() => setSelectedChannel(index)}>{label}</button>
                  })}
                </div>
              )}
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
            {result && request.status !== 'loading' && view === 'Channel detail' && selectedChannelDataAvailable && (
              <div className="channel-detail">
                <section className="channel-plot signal-plot">
                  <div className="plot-heading">
                    <span><b>01</b><span><strong>Signal</strong><small>Voltage over time</small></span></span>
                    <small>Raw mix → reference → 1–40 Hz filter</small>
                  </div>
                  <StackedEegComparison
                    x={result.traces.x}
                    series={{ [`Before · ${selectedChannelName}`]: selectedRawTrace, [`After · ${selectedChannelName}`]: selectedFilteredTrace }}
                    channelNames={[selectedChannelName]}
                    beforeLabel="Raw EEG"
                    afterLabel="Processed EEG"
                    ariaLabel={`Raw and processed ${selectedChannelName} time series`}
                  />
                </section>
                <section className="channel-plot spectrum-plot">
                  <div className="plot-heading">
                    <span><b>02</b><span><strong>Spectrum</strong><small>Power at each frequency</small></span></span>
                    <small>Welch PSD · this channel only</small>
                  </div>
                  <LineChart
                    x={result.spectrum.frequency_hz}
                    series={[
                      { label: `Raw PSD · ${selectedChannelName}`, values: selectedRawPower, color: '#a8aaa5', dashed: true },
                      { label: `Processed PSD · ${selectedChannelName}`, values: selectedFilteredPower, color: '#087f83' },
                    ]}
                    xDomain={[0, Math.min(80, result.recipe.simulation.sampling_rate_hz / 2)]}
                    xLabel="Frequency (Hz)"
                    yLabel="Power (log µV²/Hz)"
                    ariaLabel={`Raw and processed ${selectedChannelName} Welch power spectral density`}
                    logY
                    markers={truthVisible ? result.truth_peaks_hz : []}
                    height={220}
                  />
                </section>
              </div>
            )}
            {result && request.status !== 'loading' && view === 'Channel detail' && !selectedChannelDataAvailable && (
              <div className="empty-stage stale-result-stage" role="status">
                <AlertTriangle size={30} />
                <span className="eyebrow">Incomplete run result</span>
                <h3>{selectedChannelName} signal or spectrum is missing.</h3>
                <p>Restart the local service, then run the recipe again to generate channel-matched signal and spectrum data.</p>
                <button className="quiet-button" onClick={execute}>Run again</button>
              </div>
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
          </div>

          <div className="channel-weight-readout" aria-label={`${selectedChannelName} source weights`}>
            <div className="weight-intro">
              <span className="eyebrow">03 · Source weights</span>
              <strong>{selectedChannelName}</strong>
              <small>Raw mix / {recipe.preprocessing.reference === 'average' ? 'after average reference' : 'no reference change'}</small>
            </div>
            {recipe.simulation.sources.map((source, sourceIndex) => (
              <div className="weight-source" key={source.id}>
                <span><i className={`source-dot ${source.id}`} />{source.label}</span>
                <strong>{source.frequency_hz} Hz</strong>
                <dl>
                  <div><dt>Raw</dt><dd>{formatWeight(selectedMixingWeights[sourceIndex])}</dd></div>
                  <div><dt>Processed</dt><dd>{formatWeight(selectedEffectiveWeights[sourceIndex])}</dd></div>
                </dl>
              </div>
            ))}
            <p className="weight-note">Weights describe the three known oscillations. The 1/f background is added afterward. A negative sign means phase inversion, not a bad channel.</p>
          </div>
        </section>

        <aside className="inspector-panel">
          <section className="inspector-lead">
            <span className="eyebrow">Interpretation</span>
            <h2>{result ? `Why ${selectedChannelName} looks this way` : 'Reason before reveal.'}</h2>
            <p>{result && dominantSource
              ? `${dominantSource.label} (${dominantSource.frequency_hz} Hz) has the largest expected contribution to the processed trace: about ${dominantContribution?.toFixed(1)} µV before temporal filtering.`
              : 'Run the recipe, then compare one channel’s signal, spectrum, and source weights together.'}</p>
          </section>

          {result && dominantSource && (
            <section className="channel-explanation">
              <div>
                <strong>What the weight means</strong>
                <p>The processed weight for {dominantSource.label.toLowerCase()} is {formatWeight(dominantEffectiveWeight)}. Larger magnitude means stronger influence; a negative value flips the waveform’s phase.</p>
              </div>
              <div>
                <strong>Why Raw and Processed differ</strong>
                <p>Raw uses the original mix. Processed first applies {recipe.preprocessing.reference === 'average' ? 'average reference, which changes every channel’s effective weights, and then' : 'no re-reference, then applies'} the temporal filters.</p>
              </div>
              <div>
                <strong>Why it may look too regular</strong>
                <p>This teaching signal now includes 1/f-like background activity and a slowly changing, burst-like alpha envelope. It is more EEG-like, but still simpler than a recording and omits eye, muscle, movement, and electrode artifacts.</p>
              </div>
            </section>
          )}

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
              </div>
            ) : (
              <div className="truth-covered">
                <div className="blur-lines"><i /><i /><i /></div>
                <button className="reveal-button" disabled={!result} onClick={revealTruth}><Eye size={16} /> Reveal after prediction</button>
              </div>
            )}
          </section>

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

function RangeControl({ label, help, value, min, max, step, unit, onChange }: RangeControlProps & { help: string }) {
  const progress = ((value - min) / (max - min)) * 100
  return (
    <label className="range-control">
      <span><span className="control-label">{label}<ControlHint>{help}</ControlHint></span><output>{value} {unit}</output></span>
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
