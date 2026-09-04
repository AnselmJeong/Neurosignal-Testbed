import {
  Activity,
  AlertTriangle,
  CircleDot,
  CircleHelp,
  Eye,
  EyeOff,
  Gauge,
  Grid3X3,
  Network,
  Play,
  ScanLine,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Waves,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { runConnectivity } from '../lib/api'
import {
  defaultConnectivityRecipe,
  type ConnectivityMetric,
  type ConnectivityRecipe,
  type ConnectivityRequestState,
  type ConnectivitySpace,
} from '../types'
import { LineChart } from './Charts'
import { ControlHint } from './ControlHint'
import {
  CircleNetwork,
  ConnectivityHeatmap,
  ScalpNetwork,
  SurrogateDistribution,
} from './ConnectivityViews'
import { LabNavigator, type LabId } from './LabNavigator'

const CONNECTIVITY_STEPS = [
  { label: 'Predict', description: 'State how sensor mixing may change the graph.', icon: CircleHelp },
  { label: 'Estimate', description: 'Measure connectivity in the chosen space.', icon: Waves },
  { label: 'Threshold', description: 'Test edges against shuffled null data.', icon: Gauge },
  { label: 'Compare', description: 'Contrast sensor and latent networks.', icon: ScanLine },
  { label: 'Reveal', description: 'Show the planted source connection.', icon: Eye },
  { label: 'Defend', description: 'Explain which edges the evidence supports.', icon: ShieldCheck },
] as const

const VIEWS = ['Spectrum', 'Matrix', 'Scalp', 'Circle', 'Surrogates'] as const
type ConnectivityView = (typeof VIEWS)[number]

const METRICS = [
  { id: 'pearson', label: 'Pearson' },
  { id: 'coh', label: 'Coherence' },
  { id: 'imcoh', label: 'Imag. coh.' },
  { id: 'plv', label: 'PLV' },
  { id: 'ppc', label: 'PPC' },
  { id: 'pli', label: 'PLI' },
  { id: 'wpli', label: 'wPLI' },
] satisfies { id: ConnectivityMetric; label: string }[]

export function ConnectivityWorkbench({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [recipe, setRecipe] = useState<ConnectivityRecipe>(() => structuredClone(defaultConnectivityRecipe))
  const [request, setRequest] = useState<ConnectivityRequestState>({ status: 'idle' })
  const [view, setView] = useState<ConnectivityView>('Matrix')
  const [displaySpace, setDisplaySpace] = useState<ConnectivitySpace>('sensor')
  const [truthVisible, setTruthVisible] = useState(false)
  const [step, setStep] = useState(0)
  const [prediction, setPrediction] = useState('Coherence will make the sensor graph look denser than the one-edge latent graph because every sensor mixes shared fields.')

  const result = request.status === 'success' ? request.data : null
  const isBusy = request.status === 'loading'
  const selectedMatrix = result ? (displaySpace === 'sensor' ? result.sensor : result.latent) : null
  const selectedEdges = result ? (displaySpace === 'sensor' ? result.sensor_edges : result.latent_edges) : []
  const displayThreshold = result ? (displaySpace === 'sensor' ? result.sensor_threshold : result.latent_threshold) : 0
  const displaySurrogates = result ? (displaySpace === 'sensor' ? result.sensor_surrogate_values : result.latent_surrogate_values) : []
  const strongestEstimate = selectedEdges[0]?.weight ?? 0
  const detectedCount = selectedEdges.filter((edge) => edge.detected).length
  const visibleWarnings = result?.warnings
    .filter((warning) => warning.code !== 'sensor_volume_conduction' || displaySpace === 'sensor')
    .slice(0, 2) ?? []

  function updateRecipe<K extends keyof ConnectivityRecipe>(key: K, value: ConnectivityRecipe[K]) {
    setRecipe((current) => ({ ...current, [key]: value }))
    setRequest({ status: 'idle' })
    setTruthVisible(false)
    setStep(0)
  }

  function updateSpace(space: ConnectivitySpace) {
    setDisplaySpace(space)
    setRecipe((current) => ({ ...current, analysis_space: space }))
    if (space === 'latent' && view === 'Scalp') setView('Circle')
  }

  async function execute() {
    if (!prediction.trim()) {
      setStep(0)
      return
    }
    setTruthVisible(false)
    setStep(1)
    setRequest({ status: 'loading', stage: 'Generating epoched latent network', progress: 12 })
    const timer = window.setInterval(() => {
      setRequest((current) => {
        if (current.status !== 'loading') return current
        const progress = Math.min(91, current.progress + 8)
        const stage = progress < 34
          ? 'Projecting sources through the sensor field'
          : progress < 56
            ? `Estimating ${recipe.metric.toUpperCase()} in ${recipe.analysis_space} space`
            : progress < 78
              ? `Building ${recipe.surrogate_count} epoch-shuffled nulls`
              : 'Fitting periodic and aperiodic spectra'
        return { status: 'loading', stage, progress }
      })
    }, 260)
    try {
      const data = await runConnectivity(recipe)
      window.clearInterval(timer)
      setRequest({ status: 'success', data })
      setDisplaySpace(recipe.analysis_space)
      setStep(3)
    } catch (error) {
      window.clearInterval(timer)
      setRequest({
        status: 'error',
        message: error instanceof Error ? error.message : 'The connectivity pipeline stopped safely.',
      })
    }
  }

  function revealTruth() {
    setTruthVisible(true)
    setStep(4)
    setView('Circle')
  }

  const interpretation = useMemo(() => {
    if (!result) return 'Run the challenge before interpreting an edge.'
    if (displaySpace === 'sensor') {
      return `${detectedCount} sensor edges exceed the latent null threshold. Field spread and reference can create a denser sensor graph than the planted source graph.`
    }
    if (result.scores.recall === 1 && result.scores.false_positive === 0) {
      return 'The planted latent edge survives the null threshold without an extra latent edge.'
    }
    return 'This estimator or recipe misses truth or admits an extra edge. Inspect lag, noise, and the null threshold.'
  }, [detectedCount, displaySpace, result])

  return (
    <>
      <main className="workspace connectivity-workspace">
        <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={CONNECTIVITY_STEPS} step={step} />

        <aside className="control-panel connectivity-controls">
          <div className="panel-heading">
            <span className="eyebrow">Connectivity · truth challenge</span>
            <h1>When does a<br />sensor edge lie?</h1>
            <p>Change one assumption, then compare the sensor estimate with the same latent graph.</p>
          </div>

          <section className="prediction-block compact-prediction">
            <label htmlFor="connectivity-prediction"><CircleHelp size={15} /> Your prediction</label>
            <textarea id="connectivity-prediction" value={prediction} onChange={(event) => setPrediction(event.target.value)} rows={3} />
          </section>

          <section className="control-section">
            <div className="section-title"><span>Estimate</span><small>UNDIRECTED</small></div>
            <div className="metric-grid" role="group" aria-label="Connectivity metric">
              {METRICS.map((metric) => (
                <button key={metric.id} className={recipe.metric === metric.id ? 'selected' : ''} onClick={() => updateRecipe('metric', metric.id)}>{metric.label}</button>
              ))}
            </div>
            <div className="segmented-field stack">
              <span className="control-label">Analysis space<ControlHint>Sensor space estimates connections between scalp channels; latent space estimates the planted sources before scalp mixing.</ControlHint></span>
              <div role="group" aria-label="Connectivity analysis space">
                {(['sensor', 'latent'] as const).map((space: ConnectivitySpace) => (
                  <button key={space} className={displaySpace === space ? 'selected' : ''} onClick={() => updateSpace(space)}>{space === 'sensor' ? 'Sensor' : 'Latent'}</button>
                ))}
              </div>
            </div>
            <div className="segmented-field stack">
              <span className="control-label">Spectral mode<ControlHint>Chooses how the spectrum and connectivity estimate are calculated. Multitaper trades a little frequency detail for a steadier estimate.</ControlHint></span>
              <div role="group" aria-label="Spectral estimation mode">
                <button className={recipe.spectral_mode === 'multitaper' ? 'selected' : ''} onClick={() => updateRecipe('spectral_mode', 'multitaper')}>Multitaper</button>
                <button className={recipe.spectral_mode === 'fourier' ? 'selected' : ''} onClick={() => updateRecipe('spectral_mode', 'fourier')}>Fourier</button>
              </div>
            </div>
          </section>

          <section className="control-section">
            <div className="section-title"><span>Known network</span><small>ALPHA · 8–12 HZ</small></div>
            <ConnectivityRange label="Phase lag" help="The time offset between the planted alpha sources. Phase-sensitive measures can change when this lag changes." value={recipe.phase_lag_deg} min={0} max={120} step={15} unit="°" onChange={(value) => updateRecipe('phase_lag_deg', value)} />
            <ConnectivityRange label="Coupling" help="The strength of the single planted connection between latent sources." value={recipe.coupling_strength} min={0} max={1} step={0.05} unit="" onChange={(value) => updateRecipe('coupling_strength', value)} />
            <ConnectivityRange label="Field spread" help="How strongly one source contributes to multiple sensors. More spread can create false sensor-space connections." value={recipe.volume_conduction} min={0} max={1} step={0.05} unit="" onChange={(value) => updateRecipe('volume_conduction', value)} />
            <ConnectivityRange label="Epochs" help="The number of short data segments used for the estimate and shuffled null distribution. More epochs usually stabilize estimates." value={recipe.epoch_count} min={8} max={64} step={4} unit="" onChange={(value) => updateRecipe('epoch_count', value)} />
            <div className="segmented-field stack">
              <span>Sensor reference</span>
              <div role="group" aria-label="Sensor reference">
                <button className={recipe.reference === 'average' ? 'selected' : ''} onClick={() => updateRecipe('reference', 'average')}>Average</button>
                <button className={recipe.reference === 'none' ? 'selected' : ''} onClick={() => updateRecipe('reference', 'none')}>None</button>
              </div>
            </div>
          </section>

          <button className="primary-button fit-button" onClick={execute} disabled={isBusy}>
            <Play size={16} fill="currentColor" /> {result ? 'Run changed recipe' : 'Estimate connectivity'}
          </button>
        </aside>

        <section className="canvas-panel connectivity-canvas">
          <div className="canvas-toolbar connectivity-toolbar">
            <div>
              <span className="eyebrow">Coordinated analysis canvas</span>
              <h2>{selectedMatrix ? `${selectedMatrix.space} · ${selectedMatrix.metric.toUpperCase()} · ${selectedMatrix.band_hz[0]}–${selectedMatrix.band_hz[1]} Hz` : 'No network estimate yet'}</h2>
            </div>
            <div className="view-tabs" role="tablist" aria-label="Connectivity visualization type">
              {VIEWS.map((item) => (
                <button key={item} role="tab" aria-selected={item === view} className={item === view ? 'active' : ''} disabled={item === 'Scalp' && displaySpace === 'latent'} onClick={() => setView(item)}>{item}</button>
              ))}
            </div>
          </div>

          <div className="connectivity-stage">
            {isBusy && (
              <div className="run-overlay" role="status" aria-live="polite">
                <div className="orbit"><Network size={27} /></div>
                <span className="eyebrow">Connectivity pipeline</span>
                <h3>{request.stage}</h3>
                <div className="progress-track"><i style={{ width: `${request.progress}%` }} /></div>
                <p>{request.progress}% · seed {recipe.seed} · {recipe.epoch_count} epochs</p>
              </div>
            )}
            {request.status === 'error' && (
              <div className="empty-stage error-stage">
                <AlertTriangle size={30} /><h3>Analysis stopped safely</h3><p>{request.message}</p>
                <button className="quiet-button" onClick={() => setRequest({ status: 'idle' })}><X size={14} /> Dismiss</button>
              </div>
            )}
            {request.status === 'idle' && (
              <div className="connectivity-empty">
                <div className="network-preview" aria-hidden="true"><i /><i /><i /><i /><span /><span /><span /></div>
                <span className="eyebrow">One planted edge · four latent sources</span>
                <h3>Estimate first. Reveal the graph second.</h3>
                <p>Every run compares the observed edge against {recipe.surrogate_count} epoch-shuffled null networks.</p>
                <button className="primary-button" onClick={execute}><Network size={15} /> Run default challenge</button>
              </div>
            )}
            {result && selectedMatrix && view === 'Spectrum' && (
              <div className="connectivity-spectrum">
                <LineChart
                  x={result.spectrum.frequency_hz}
                  series={[
                    { label: 'Welch PSD', values: result.spectrum.welch_power, color: '#0072b2', dashed: true },
                    { label: 'Multitaper PSD', values: result.spectrum.multitaper_power, color: '#009e73' },
                    { label: 'specparam model', values: result.spectrum.parameterization.modeled_power, color: '#d55e00' },
                  ]}
                  xDomain={[2, 40]}
                  xLabel="Frequency (Hz)"
                  yLabel="Power (log a.u./Hz)"
                  ariaLabel="Welch and multitaper spectra with specparam model fit"
                  logY
                  markers={truthVisible ? [recipe.alpha_frequency_hz] : []}
                />
              </div>
            )}
            {result && selectedMatrix && view === 'Matrix' && <ConnectivityHeatmap matrix={selectedMatrix} threshold={displayThreshold} />}
            {result && selectedMatrix && view === 'Scalp' && (
              <ScalpNetwork matrix={selectedMatrix} edges={selectedEdges} threshold={displayThreshold} positions={result.sensor_positions} truthVisible={truthVisible} />
            )}
            {result && selectedMatrix && view === 'Circle' && (
              <CircleNetwork matrix={selectedMatrix} edges={selectedEdges} threshold={displayThreshold} truthVisible={truthVisible} />
            )}
            {result && view === 'Surrogates' && (
              <div className="surrogate-stage">
                <div>
                  <span className="eyebrow">Family-wise null threshold</span>
                  <h3>Shuffle epochs, keep the spectrum.</h3>
                  <p>Each null run independently reorders epochs per latent node. The 95th percentile of the strongest null edge becomes the detection threshold.</p>
                </div>
                <SurrogateDistribution values={displaySurrogates} threshold={displayThreshold} estimate={strongestEstimate} />
              </div>
            )}
          </div>

          <div className="canvas-readout connectivity-readout">
            <div><small>NULL THRESHOLD</small><strong>{result ? displayThreshold.toFixed(3) : '—'}</strong></div>
            <div><small>EDGES ABOVE NULL</small><strong>{result ? detectedCount : '—'}</strong></div>
            <div><small>FREQUENCY RESOLUTION</small><strong>{result ? `${result.spectrum.frequency_resolution_hz.toFixed(2)} Hz` : '—'}</strong></div>
            <div><small>REFERENCE</small><strong>{recipe.reference === 'average' ? 'Average' : 'None'}</strong></div>
          </div>
        </section>

        <aside className="inspector-panel connectivity-inspector">
          <section className="inspector-lead">
            <span className="eyebrow">Interpretation</span>
            <h2>{truthVisible ? 'Truth is a graph, not a badge.' : 'Edges need a null.'}</h2>
            <p>{interpretation}</p>
          </section>

          {visibleWarnings.map((warning) => (
            <section className={`warning-card ${warning.severity}`} key={warning.code}>
              <div><AlertTriangle size={16} /><strong>{warning.title}</strong></div>
              <p>{warning.explanation}</p>
              {warning.suggestion && <small>{warning.suggestion}</small>}
            </section>
          ))}

          <section className={`truth-block ${truthVisible ? 'revealed' : ''}`}>
            <div className="truth-heading"><span><EyeOff size={16} /> Latent network truth</span><span className="truth-state">{truthVisible ? 'REVEALED' : 'HIDDEN'}</span></div>
            {truthVisible && result ? (
              <div className="truth-content connectivity-truth">
                <div className="truth-edge"><span>Frontal L</span><i /><strong>{result.recipe.coupling_strength.toFixed(2)}</strong><i /><span>Frontal R</span></div>
                <p>One undirected alpha-band edge was planted. Posterior sources are independent controls; sensor nodes are mixtures, not additional truth nodes.</p>
                <button className="text-button" onClick={() => { updateSpace(displaySpace === 'sensor' ? 'latent' : 'sensor'); setView('Circle') }}>Compare {displaySpace === 'sensor' ? 'latent' : 'sensor'} estimate</button>
              </div>
            ) : (
              <div className="truth-covered">
                <div className="blur-lines"><i /><i /><i /></div>
                <button className="reveal-button" disabled={!result} onClick={revealTruth}><Eye size={16} /> Reveal latent graph</button>
              </div>
            )}
          </section>

          {result && (
            <section className="score-block connectivity-score">
              <span className="eyebrow">Latent truth score · simulation only</span>
              <div><strong>{Math.round(result.scores.precision * 100)}<small>%</small></strong><span>precision</span></div>
              <div><strong>{Math.round(result.scores.recall * 100)}<small>%</small></strong><span>recall</span></div>
              <div><strong>{result.scores.weighted_truth_correlation.toFixed(2)}</strong><span>weighted correlation</span></div>
              <p>Scores apply to the four-node latent estimate. The sensor graph is inspected for bias, not scored as if sensors were sources.</p>
            </section>
          )}

          {result && (
            <section className="spectral-fit-block">
              <div className="section-title"><span>Spectral fit</span><small>SPECPARAM · LINEAR INPUT</small></div>
              <dl>
                <div><dt>Alpha peak</dt><dd>{result.spectrum.parameterization.peak_frequency_hz?.toFixed(2) ?? '—'} Hz</dd></div>
                <div><dt>Exponent</dt><dd>{result.spectrum.parameterization.exponent.toFixed(2)}</dd></div>
                <div><dt>Fit R²</dt><dd>{result.spectrum.parameterization.r_squared.toFixed(3)}</dd></div>
                <div><dt>Epochs</dt><dd>{result.n_epochs_used}</dd></div>
                <div><dt>Backend</dt><dd>{result.estimator_backend}</dd></div>
              </dl>
            </section>
          )}

          <div className="nonclinical"><AlertTriangle size={15} /><span>Functional connectivity is not causality.<br />Educational and research use only.</span></div>
        </aside>
      </main>

      <footer className="run-strip connectivity-run-strip">
        <div className="run-strip-title"><SlidersHorizontal size={16} /><span>Truth contract</span></div>
        <div className="connectivity-contract-flow">
          <span><small>LATENT GRAPH</small>4 nodes · 1 edge</span><i />
          <span><small>PROJECTION</small>{Math.round(recipe.volume_conduction * 100)}% field spread</span><i />
          <span><small>ESTIMATOR</small>{recipe.metric.toUpperCase()} · {recipe.band_low_hz}–{recipe.band_high_hz} Hz</span><i />
          <span><small>NULL</small>{recipe.surrogate_count} shuffles · max statistic</span><i />
          <span className={truthVisible ? 'verified' : ''}><small>TRUTH</small>{truthVisible ? 'revealed' : 'held out'}</span>
        </div>
        <div className="strip-actions"><button onClick={() => setView('Surrogates')} disabled={!result}><Sparkles size={14} /> Inspect null</button></div>
      </footer>
    </>
  )
}

interface ConnectivityRangeProps {
  label: string
  help: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (value: number) => void
}

function ConnectivityRange({ label, help, value, min, max, step, unit, onChange }: ConnectivityRangeProps) {
  const progress = ((value - min) / (max - min)) * 100
  return (
    <label className="range-control connectivity-range">
      <span><span className="control-label">{label}<ControlHint>{help}</ControlHint></span><output>{Number.isInteger(step) ? value : value.toFixed(2)}{unit ? ` ${unit}` : ''}</output></span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} style={{ '--range-progress': `${progress}%` } as React.CSSProperties} />
      <small><span>{min}</span><span>{max}</span></small>
    </label>
  )
}
