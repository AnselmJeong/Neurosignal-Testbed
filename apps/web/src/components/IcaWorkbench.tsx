import {
  Activity,
  AlertTriangle,
  CircleHelp,
  Eye,
  EyeOff,
  FlaskConical,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Split,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { applyIca, fitIca, simulateIca } from '../lib/api'
import {
  defaultIcaRecipe,
  type IcaApplyResult,
  type IcaFitResult,
  type IcaRecipe,
  type IcaSimulationResult,
} from '../types'
import { LineChart } from './Charts'
import { ControlHint } from './ControlHint'
import { StackedEegBrowser, StackedEegComparison } from './StackedEegBrowser'
import { LabNavigator, type LabId } from './LabNavigator'
import { ScalpTopography } from './ScalpTopography'

const ICA_STEPS = [
  { label: 'Generate', description: 'Create sensor EEG with a known blink.', icon: FlaskConical },
  { label: 'Inspect EEG', description: 'Find where the blink appears in the sensors.', icon: ScanSearch },
  { label: 'Fit ICA', description: 'Estimate components from a filtered copy.', icon: Split },
  { label: 'Inspect ICs', description: 'Compare each component\'s evidence.', icon: Sparkles },
  { label: 'Exclude', description: 'Choose the component to remove.', icon: CircleHelp },
  { label: 'Compare', description: 'Check artifact loss and neural retention.', icon: ShieldCheck },
]

type IcaView = 'Component trace' | 'Component spectrum' | 'Before / after'
type PipelineState =
  | { status: 'idle' }
  | { status: 'generating'; stage: string; progress: number }
  | { status: 'fitting'; stage: string; progress: number }
  | { status: 'applying'; stage: string; progress: number }
  | { status: 'error'; message: string }

export function IcaWorkbench({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [recipe, setRecipe] = useState<IcaRecipe>(() => structuredClone(defaultIcaRecipe))
  const [simulation, setSimulation] = useState<IcaSimulationResult | null>(null)
  const [fit, setFit] = useState<IcaFitResult | null>(null)
  const [applied, setApplied] = useState<IcaApplyResult | null>(null)
  const [selectedComponent, setSelectedComponent] = useState(0)
  const [excluded, setExcluded] = useState<number[]>([])
  const [truthVisible, setTruthVisible] = useState(false)
  const [view, setView] = useState<IcaView>('Component trace')
  const [pipeline, setPipeline] = useState<PipelineState>({ status: 'idle' })
  const [step, setStep] = useState(0)

  const component = fit?.components.find((item) => item.index === selectedComponent) ?? fit?.components[0]
  const isBusy = pipeline.status === 'generating' || pipeline.status === 'fitting' || pipeline.status === 'applying'
  const isComparison = Boolean(applied && view === 'Before / after')
  const comparisonChannelCount = fit && applied
    ? fit.compatibility.channel_names.filter((channel) => (
      applied.before_after_trace.series[`Before · ${channel}`]
      && applied.before_after_trace.series[`After · ${channel}`]
    )).length
    : 0
  const comparisonIsComplete = Boolean(fit && applied && comparisonChannelCount === fit.compatibility.channel_names.length)
  const comparisonNeedsRefresh = isComparison && !comparisonIsComplete
  const availableRank = fit?.compatibility.rank ?? simulation?.rank ?? (recipe.reference === 'average' ? 7 : 8)
  const excludedSummary = fit
    ? excluded.map((index) => {
      const item = fit.components.find((candidate) => candidate.index === index)
      return `IC ${String(index + 1).padStart(2, '0')}${item ? ` · ${item.suggested_label}` : ''}`
    }).join(', ')
    : ''

  function clearDecomposition() {
    setFit(null)
    setApplied(null)
    setExcluded([])
    setTruthVisible(false)
    setView('Component trace')
  }

  function updateInputRecipe<K extends 'blink_amplitude_uv' | 'sensor_noise_uv' | 'reference'>(key: K, value: IcaRecipe[K]) {
    setRecipe((current) => ({ ...current, [key]: value }))
    setSimulation(null)
    clearDecomposition()
    setStep(0)
  }

  function updateFitRecipe<K extends 'algorithm' | 'component_count'>(key: K, value: IcaRecipe[K]) {
    setRecipe((current) => ({ ...current, [key]: value }))
    clearDecomposition()
    setStep(simulation ? 1 : 0)
  }

  async function handleGenerate() {
    setPipeline({ status: 'generating', stage: 'Mixing sources into eight EEG sensors', progress: 35 })
    clearDecomposition()
    try {
      const result = await simulateIca(recipe)
      setSimulation(result)
      setPipeline({ status: 'idle' })
      setStep(1)
    } catch (error) {
      setPipeline({ status: 'error', message: error instanceof Error ? error.message : 'EEG simulation failed safely.' })
    }
  }

  async function handleFit() {
    if (!simulation) return
    setPipeline({ status: 'fitting', stage: `Filtering a temporary ${recipe.fit_highpass_hz}–${recipe.fit_lowpass_hz} Hz fit copy`, progress: 20 })
    setApplied(null)
    setExcluded([])
    setTruthVisible(false)
    setStep(2)
    const timer = window.setInterval(() => {
      setPipeline((current) => {
        if (current.status !== 'fitting') return current
        const progress = Math.min(90, current.progress + 9)
        const stage = progress < 38
          ? 'Building the high-pass fit copy'
          : progress < 67
            ? `Fitting ${recipe.algorithm === 'infomax' ? 'extended Infomax' : 'FastICA'}`
            : 'Extracting traces, spectra and topographies'
        return { status: 'fitting', stage, progress }
      })
    }, 340)
    try {
      const result = await fitIca(recipe)
      window.clearInterval(timer)
      setFit(result)
      setSelectedComponent(0)
      setPipeline({ status: 'idle' })
      setStep(3)
    } catch (error) {
      window.clearInterval(timer)
      setPipeline({ status: 'error', message: error instanceof Error ? error.message : 'ICA fit failed safely.' })
    }
  }

  function toggleExcluded(index: number) {
    setExcluded((current) => current.includes(index) ? current.filter((item) => item !== index) : [...current, index])
    setApplied(null)
    setStep(4)
  }

  async function handleApply() {
    if (!fit || !excluded.length) return
    setPipeline({ status: 'applying', stage: 'Verifying target compatibility', progress: 24 })
    setStep(4)
    const timer = window.setInterval(() => {
      setPipeline((current) => {
        if (current.status !== 'applying') return current
        const progress = Math.min(88, current.progress + 16)
        return {
          status: 'applying',
          stage: progress < 58 ? 'Applying manual exclusions' : 'Scoring attenuation and neural distortion',
          progress,
        }
      })
    }, 260)
    try {
      const result = await applyIca(recipe, fit, excluded)
      window.clearInterval(timer)
      setApplied(result)
      setPipeline({ status: 'idle' })
      setView('Before / after')
      setStep(5)
    } catch (error) {
      window.clearInterval(timer)
      setPipeline({ status: 'error', message: error instanceof Error ? error.message : 'ICA apply failed safely.' })
    }
  }

  const activeMatch = truthVisible && component
    ? `${component.matched_truth} · r ${component.matched_correlation.toFixed(2)}`
    : 'Hidden until reveal'

  const scoreJudgement = useMemo(() => {
    if (!applied) return 'Apply a manual exclusion to score the repair.'
    if (applied.artifact_attenuation_db > 25 && applied.neural_distortion_pct < 20) {
      return 'The blink-related pattern was strongly reduced with a relatively small change to the known clean signal.'
    }
    return 'The trade-off needs review; attenuation alone is not enough.'
  }, [applied])

  return (
    <>
      <main className="workspace ica-workspace">
        <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={ICA_STEPS} step={step} />

        <aside className="control-panel ica-controls">
          <div className="panel-heading">
            <span className="eyebrow">Preprocessing · guided</span>
            <h1>Which component<br />is the blink?</h1>
            <p>Generate a known EEG, inspect it, then fit ICA and choose what to exclude.</p>
          </div>

          <section className="rank-block">
            <div><ShieldCheck size={16} /><span>Independent dimensions</span></div>
            <strong>{availableRank}<small> available to ICA</small></strong>
            <p>{recipe.reference === 'average' ? '8 recorded channels; average reference adds one constraint, leaving 7 independent dimensions.' : '8 recorded channels with no reference constraint.'}</p>
          </section>

          <section className="control-section">
            <div className="section-title"><span>Simulated EEG</span><small>STEP 1</small></div>
            <IcaRange label="Blink amplitude" help="The size of the planted eye-blink artifact. More amplitude makes the blink easier to spot, but it can dominate the decomposition." value={recipe.blink_amplitude_uv} min={0} max={160} step={10} unit="µV" onChange={(value) => updateInputRecipe('blink_amplitude_uv', value)} />
            <IcaRange label="Sensor noise" help="Random sensor-level voltage. More noise makes component patterns and artifact detection less reliable." value={recipe.sensor_noise_uv} min={0} max={4} step={0.25} unit="µV" onChange={(value) => updateInputRecipe('sensor_noise_uv', value)} />
            <div className="preset-row">
              <button className={recipe.blink_amplitude_uv === 90 ? 'selected' : ''} onClick={() => updateInputRecipe('blink_amplitude_uv', 90)}>Planted blink</button>
              <button className={recipe.blink_amplitude_uv === 0 ? 'selected' : ''} onClick={() => updateInputRecipe('blink_amplitude_uv', 0)}>No-artifact control</button>
            </div>
            <div className="segmented-field stack">
              <span className="control-label">EEG reference<ControlHint>Average reference changes the generated sensor signals and leaves seven independent dimensions from eight recorded channels.</ControlHint></span>
              <div role="group" aria-label="EEG reference">
                <button className={recipe.reference === 'average' ? 'selected' : ''} onClick={() => updateInputRecipe('reference', 'average')}>Average</button>
                <button className={recipe.reference === 'none' ? 'selected' : ''} onClick={() => updateInputRecipe('reference', 'none')}>None</button>
              </div>
            </div>
            <button className={simulation ? 'generate-button' : 'primary-button generate-button'} onClick={handleGenerate} disabled={isBusy}>
              <FlaskConical size={16} /> {simulation ? 'Regenerate simulated EEG' : 'Generate simulated EEG'}
            </button>
          </section>

          <section className="control-section">
            <div className="section-title"><span>ICA settings</span><small>STEP 2</small></div>
            <div className="fit-copy-note">
              <span>Data used for ICA</span>
              <strong>{recipe.fit_highpass_hz.toFixed(0)}–{recipe.fit_lowpass_hz.toFixed(0)} Hz</strong>
              <small>ICA is estimated from a filtered copy; the generated EEG is not overwritten.</small>
            </div>
            <div className="segmented-field stack">
              <span className="control-label">Algorithm<ControlHint>Chooses the ICA optimization method. Both methods estimate statistically independent components, but can converge to different decompositions.</ControlHint></span>
              <div role="group" aria-label="ICA algorithm">
                <button className={recipe.algorithm === 'infomax' ? 'selected' : ''} onClick={() => updateFitRecipe('algorithm', 'infomax')}>Ext. Infomax</button>
                <button className={recipe.algorithm === 'fastica' ? 'selected' : ''} onClick={() => updateFitRecipe('algorithm', 'fastica')}>FastICA</button>
              </div>
            </div>
            <IcaRange label="Components" help={`How many components ICA will estimate. The current EEG provides ${availableRank} independent dimensions, so the model cannot exceed that rank.`} value={recipe.component_count} min={3} max={7} step={1} unit="ICs" onChange={(value) => updateFitRecipe('component_count', value)} />
            {!simulation && <p className="fit-prerequisite">Generate and inspect the simulated EEG before fitting ICA.</p>}
            <button className="primary-button fit-button" onClick={handleFit} disabled={!simulation || isBusy}>
              <Split size={16} /> {fit ? 'Refit ICA' : 'Fit ICA on generated EEG'}
            </button>
          </section>
        </aside>

        <section className="canvas-panel ica-canvas">
          <div className="canvas-toolbar ica-toolbar">
            <div>
              <span className="eyebrow">{isComparison ? 'Repair comparison' : fit ? 'Component workbench' : simulation ? 'Generated input' : 'ICA lesson'}</span>
              <h2>{comparisonNeedsRefresh ? 'Before / after · refresh required' : isComparison ? 'Cleaned EEG · 8-channel before / after' : component ? `IC ${String(component.index + 1).padStart(2, '0')} · inspect before exclusion` : simulation ? 'Simulated EEG · inspect before ICA' : 'Generate the EEG first'}</h2>
            </div>
            {fit && <div className="view-tabs" role="tablist" aria-label="ICA visualization type">
              {(['Component trace', 'Component spectrum', 'Before / after'] as IcaView[]).map((item) => (
                <button key={item} role="tab" aria-selected={item === view} className={item === view ? 'active' : ''} disabled={item === 'Before / after' && !applied} onClick={() => setView(item)}>{item}</button>
              ))}
            </div>}
          </div>

          <div className="ica-stage">
            {isBusy && (
              <div className="run-overlay" role="status" aria-live="polite">
                <div className="orbit"><Activity size={26} /></div>
                <span className="eyebrow">{pipeline.status === 'generating' ? 'EEG simulation' : 'ICA pipeline'}</span>
                <h3>{pipeline.stage}</h3>
                <div className="progress-track"><i style={{ width: `${pipeline.progress}%` }} /></div>
                <p>{pipeline.progress}% · seed {recipe.seed}{pipeline.status === 'generating' ? '' : ` · ${recipe.algorithm}`}</p>
              </div>
            )}
            {pipeline.status === 'error' && (
              <div className="empty-stage error-stage">
                <AlertTriangle size={30} /><h3>The current step could not finish</h3><p>{pipeline.message}</p>
                <button className="quiet-button" onClick={() => setPipeline({ status: 'idle' })}><X size={14} /> Dismiss</button>
              </div>
            )}
            {!simulation && pipeline.status === 'idle' && (
              <div className="ica-start-state">
                <section>
                  <span className="eyebrow">Step 1 · prepare the input</span>
                  <h3>Start with the EEG you will clean.</h3>
                  <p>The recipe on the left creates three neural sources and a blink, then mixes them into eight sensor channels. Generate that signal before fitting ICA.</p>
                  <dl className="ica-input-spec">
                    <div><dt>Sources</dt><dd>alpha · theta · beta · blink</dd></div>
                    <div><dt>Sensors</dt><dd>8 EEG channels</dd></div>
                    <div><dt>Duration</dt><dd>{recipe.duration_s.toFixed(0)} s at {recipe.sampling_rate_hz} Hz</dd></div>
                    <div><dt>Reference</dt><dd>{recipe.reference === 'average' ? 'average' : 'none'}</dd></div>
                  </dl>
                </section>
                <section className="ica-guide" aria-labelledby="ica-guide-title">
                  <span className="eyebrow">Lesson guide</span>
                  <h4 id="ica-guide-title">Follow the signal through four steps.</h4>
                  <ol className="ica-sequence" aria-label="ICA lesson sequence">
                    <li><small>01</small><strong>Configure and generate</strong><span>Set the artifact, noise and reference; then create the sensor EEG.</span></li>
                    <li><small>02</small><strong>Inspect sensor EEG</strong><span>Look across all eight channels for the planted blink.</span></li>
                    <li><small>03</small><strong>Fit and inspect ICA</strong><span>Fit on copied data and compare each component's evidence.</span></li>
                    <li><small>04</small><strong>Exclude and compare</strong><span>Mark an IC manually, apply it, and review the trade-off.</span></li>
                  </ol>
                </section>
              </div>
            )}
            {simulation && !fit && pipeline.status === 'idle' && (
              <div className="simulated-eeg-view">
                <div className="simulation-summary">
                  <span><small>EEG BROWSER</small>{simulation.channel_names.length} channels · shared gain</span>
                  <span><small>PLANTED ARTIFACT</small>{recipe.blink_amplitude_uv} µV blink</span>
                  <p>Compare the same time window across every sensor. The frontal channels should show the blink most strongly.</p>
                </div>
                <StackedEegBrowser
                  x={simulation.sensor_trace.x}
                  series={simulation.sensor_trace.series}
                  ariaLabel="Eight-channel simulated contaminated EEG browser"
                />
              </div>
            )}
            {fit && pipeline.status === 'idle' && (
              <>
                {!isComparison && <div className="component-strip" aria-label="ICA components">
                  {fit.components.map((item) => (
                    <button
                      key={item.index}
                      className={`${item.index === selectedComponent ? 'active' : ''} ${excluded.includes(item.index) ? 'excluded' : ''}`}
                      onClick={() => setSelectedComponent(item.index)}
                    >
                      <span>IC {String(item.index + 1).padStart(2, '0')}</span>
                      <strong>{item.suggested_label}</strong>
                      <small>{Math.round(item.suggestion_probability * 100)}% advisory</small>
                      {excluded.includes(item.index) && <em><Trash2 size={11} /> exclude</em>}
                    </button>
                  ))}
                </div>}
                {isComparison && <div className="repair-summary">
                  <span><small>APPLIED EXCLUSION{excluded.length === 1 ? '' : 'S'}</small><strong>{excludedSummary}</strong></span>
                  <p>{comparisonNeedsRefresh ? `This saved result contains ${comparisonChannelCount} of ${fit.compatibility.channel_names.length} channels.` : 'The component decision is complete. Verify its effect across every sensor below.'}</p>
                </div>}
                <div className="component-detail">
                  {component && view !== 'Before / after' && (
                    <div className="component-visual">
                      <div className="topography-panel">
                        <ScalpTopography values={component.topography} label={`IC ${component.index + 1}`} />
                        <div className="scalp-color-key" aria-label="Scalp map color meaning">
                          <span><i className="positive" />positive weight</span>
                          <span><i className="negative" />negative weight</span>
                          <p>Color shows relative weight within this IC—not correlation. The whole map may flip sign.</p>
                        </div>
                        <div className="variance-readout">
                          <small>EEG VARIANCE REPRESENTED</small>
                          <strong>{component.explained_variance_pct.toFixed(1)}%</strong>
                          <p>Share of the fit-copy EEG reconstructed by this IC; not its probability or “brain activity.”</p>
                        </div>
                      </div>
                      <div className="component-chart">
                        {view === 'Component trace' ? (
                          <LineChart x={component.time_s} series={[{ label: `IC ${component.index + 1}`, values: component.trace, color: '#087f83' }]} xLabel="Time (s)" yLabel="ICA activation (a.u.)" ariaLabel={`Time course for ICA component ${component.index + 1}`} />
                        ) : (
                          <LineChart x={component.frequency_hz} series={[{ label: `IC ${component.index + 1} PSD`, values: component.power, color: '#087f83' }]} xDomain={[0, 80]} xLabel="Frequency (Hz)" yLabel="Power (log a.u.)" ariaLabel={`Power spectrum for ICA component ${component.index + 1}`} logY />
                        )}
                      </div>
                    </div>
                  )}
                  {applied && view === 'Before / after' && comparisonIsComplete && (
                    <StackedEegComparison
                      x={applied.before_after_trace.x}
                      series={applied.before_after_trace.series}
                      channelNames={fit.compatibility.channel_names}
                      ariaLabel="Eight-channel EEG before and after ICA repair"
                    />
                  )}
                  {applied && view === 'Before / after' && !comparisonIsComplete && (
                    <div className="stale-comparison" role="alert">
                      <AlertTriangle size={30} />
                      <span className="eyebrow">Incomplete comparison data</span>
                      <h3>The earlier result only contains {comparisonChannelCount} of {fit.compatibility.channel_names.length} channels.</h3>
                      <p>Rebuild it with the current API to compare before and after EEG across every sensor.</p>
                      <button className="primary-button" onClick={handleApply} disabled={isBusy}><RefreshCw size={15} /> Rebuild 8-channel comparison</button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="canvas-readout ica-readout">
            <div><small>SIMULATED INPUT</small><strong>{simulation ? `${simulation.channel_names.length} EEG channels` : 'Not generated'}</strong></div>
            <div><small>ICA MODEL</small><strong>{fit ? `${fit.components.length} components` : 'Not fitted'}</strong></div>
            <div><small>EXCLUDED</small><strong>{excluded.length ? excluded.map((index) => `IC ${index + 1}`).join(', ') : 'None'}</strong></div>
            <div><small>RESULT</small><strong>{comparisonNeedsRefresh ? 'Refresh required' : applied ? `${applied.artifact_attenuation_db.toFixed(1)} dB · ${applied.neural_retention_pct.toFixed(0)}% fidelity` : 'Not applied'}</strong></div>
          </div>
        </section>

        <aside className="inspector-panel ica-inspector">
          <section className="inspector-lead">
            <span className="eyebrow">{isComparison ? 'Repair result' : component ? 'Component decision' : simulation ? 'Sensor inspection' : 'Before ICA'}</span>
            <h2>{comparisonNeedsRefresh ? 'Rebuild this result.' : isComparison ? 'Check every sensor.' : component ? `IC ${String(component.index + 1).padStart(2, '0')}` : simulation ? 'Look at the mixed EEG.' : 'Generate the input.'}</h2>
            <p>{comparisonNeedsRefresh ? 'The displayed result came from an older response containing only Fp1. Rebuild it before interpreting the repair.' : isComparison ? 'Dashed rust is the generated input; solid teal is the cleaned output. A good repair reduces the blink without flattening unrelated EEG.' : component ? 'Use time course, spectrum, topography, and the advisory label together. One cue is not enough.' : simulation ? 'The blink is planted most strongly at the frontal sensors. Inspect the EEG before asking ICA to separate it.' : 'Set the artifact and reference on the left. The first result will be sensor EEG, not ICA components.'}</p>
          </section>

          {component && !isComparison && (
            <section className="advisory-block">
              <div><Sparkles size={16} /><span>ICLabel suggestion</span><small>ADVISORY</small></div>
              <strong>{component.suggested_label}</strong>
              <p>{Math.round(component.suggestion_probability * 100)}% predicted probability · never auto-selected</p>
              <button className={excluded.includes(component.index) ? 'remove-exclusion' : 'mark-exclusion'} onClick={() => toggleExcluded(component.index)}>
                {excluded.includes(component.index) ? <><X size={15} /> Keep this component</> : <><Trash2 size={15} /> Mark for exclusion</>}
              </button>
            </section>
          )}

          {component && !isComparison && (
            <section className="reading-guide">
              <div className="section-title"><span>How to read this IC</span><small>TERMS</small></div>
              <dl>
                <div>
                  <dt>Scalp colors</dt>
                  <dd>Teal and rust are positive and negative sensor weights. Stronger color means a larger weight within this IC—not a correlation. Compare locations within one map; ICA polarity can reverse as a whole.</dd>
                </div>
                <div>
                  <dt>Explained variance</dt>
                  <dd>How much of the filtered fit-copy EEG this component reconstructs by itself. It is not confidence or importance, and IC percentages need not sum to 100%.</dd>
                </div>
              </dl>
            </section>
          )}

          {fit && !isComparison && <section className={`truth-block ${truthVisible ? 'revealed' : ''}`}>
            <div className="truth-heading"><span><EyeOff size={16} /> Component truth</span><span className="truth-state">{truthVisible ? 'REVEALED' : 'HIDDEN'}</span></div>
            {truthVisible && component ? (
              <div className="truth-content">
                <div className="truth-match"><small>MATCHED SOURCE</small><strong>{activeMatch}</strong></div>
                <p>Matching uses absolute source correlation after optimal one-to-one assignment. It is available only because this is a simulation.</p>
              </div>
            ) : (
              <div className="truth-covered">
                <div className="blur-lines"><i /><i /><i /></div>
                <button className="reveal-button" disabled={!fit} onClick={() => setTruthVisible(true)}><Eye size={16} /> Reveal source identity</button>
              </div>
            )}
          </section>}

          {!isComparison && fit?.warnings.map((warning) => (
            <section className={`warning-card ${warning.severity}`} key={warning.code}>
              <div><AlertTriangle size={16} /><strong>{warning.title}</strong></div><p>{warning.explanation}</p>
            </section>
          ))}

          {fit && !isComparison && (
            <section className="compatibility-block">
              <div className="section-title"><span>Apply compatibility</span><small>VERIFIED BEFORE APPLY</small></div>
              <dl>
                <div><dt>Channels</dt><dd>{fit.compatibility.channel_names.length} · ordered</dd></div>
                <div><dt>Reference</dt><dd>{fit.compatibility.reference}</dd></div>
                <div><dt>Bad channels</dt><dd>{fit.compatibility.bad_channels.length}</dd></div>
                <div><dt>Fit high-pass</dt><dd>{fit.compatibility.fit_highpass_hz} Hz</dd></div>
                <div><dt>Fingerprint</dt><dd>{fit.compatibility.fingerprint.slice(0, 8)}</dd></div>
              </dl>
            </section>
          )}

          {applied && isComparison && comparisonIsComplete && (
            <section className="score-block">
              <span className="eyebrow">Truth score · simulation only</span>
              <div className="score-metric">
                <strong>{applied.artifact_attenuation_db.toFixed(1)}<small> dB</small></strong>
                <span><b>Blink-related power reduction</b><small>Log-scale drop in the signal matching the planted blink across sensors. 10 dB means tenfold lower matched power.</small></span>
              </div>
              <div className="score-metric">
                <strong>{applied.neural_retention_pct.toFixed(1)}<small>%</small></strong>
                <span><b>Clean-signal fidelity</b><small>100% minus the RMS change relative to the known clean simulation. This cannot be measured from real EEG alone.</small></span>
              </div>
              <p className="score-judgement">{scoreJudgement}</p>
            </section>
          )}

          {fit && !isComparison && <button className="primary-button apply-button" disabled={!excluded.length || isBusy} onClick={handleApply}>
            <WandSparkles size={16} /> Apply {excluded.length || 0} manual exclusion{excluded.length === 1 ? '' : 's'}
          </button>}
          <div className="nonclinical"><AlertTriangle size={15} /><span>ICLabel is advisory. Educational and research use only.</span></div>
        </aside>
      </main>

      <footer className="run-strip ica-run-strip">
        <div className="run-strip-title"><SlidersHorizontal size={16} /><span>Current pipeline</span></div>
        <div className="ica-contract-flow">
          <span className={simulation ? 'verified' : ''}><small>INPUT</small>{simulation ? '8-channel EEG ready' : 'not generated'}</span><i />
          <span className={fit ? 'verified' : ''}><small>ICA FIT</small>{fit ? `${fit.components.length} ICs · ${recipe.algorithm}` : `${recipe.fit_highpass_hz}–${recipe.fit_lowpass_hz} Hz · pending`}</span><i />
          <span className={excluded.length ? 'verified' : ''}><small>MANUAL DECISION</small>{excluded.length ? `${excluded.length} IC${excluded.length === 1 ? '' : 's'} selected` : 'no exclusions'}</span><i />
          <span className={applied?.compatibility_verified ? 'verified' : ''}><small>OUTPUT</small>{applied?.compatibility_verified ? 'cleaned copy ready' : 'not applied'}</span>
        </div>
        <div className="strip-actions"><button onClick={() => updateInputRecipe('blink_amplitude_uv', 90)}><FlaskConical size={14} /> Restore planted blink</button></div>
      </footer>
    </>
  )
}

function IcaRange({ label, help, value, min, max, step, unit, onChange }: { label: string; help: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void }) {
  const progress = ((value - min) / (max - min)) * 100
  return (
    <label className="range-control">
      <span><span className="control-label">{label}<ControlHint>{help}</ControlHint></span><output>{value} {unit}</output></span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} style={{ '--range-progress': `${progress}%` } as React.CSSProperties} />
      <small><span>{min}</span><span>{max}</span></small>
    </label>
  )
}
