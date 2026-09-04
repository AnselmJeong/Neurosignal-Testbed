import {
  Activity,
  AlertTriangle,
  CircleHelp,
  Eye,
  EyeOff,
  FlaskConical,
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

import { applyIca, fitIca } from '../lib/api'
import {
  defaultIcaRecipe,
  type IcaApplyResult,
  type IcaFitResult,
  type IcaRecipe,
} from '../types'
import { LineChart } from './Charts'
import { ControlHint } from './ControlHint'
import { LabNavigator, type LabId } from './LabNavigator'
import { ScalpTopography } from './ScalpTopography'

const ICA_STEPS = [
  { label: 'Inspect', icon: ScanSearch },
  { label: 'Fit', icon: Split },
  { label: 'Label', icon: Sparkles },
  { label: 'Select', icon: CircleHelp },
  { label: 'Apply', icon: WandSparkles },
  { label: 'Score', icon: ShieldCheck },
]

type IcaView = 'Component trace' | 'Component spectrum' | 'Before / after'
type PipelineState =
  | { status: 'idle' }
  | { status: 'fitting'; stage: string; progress: number }
  | { status: 'applying'; stage: string; progress: number }
  | { status: 'error'; message: string }

export function IcaWorkbench({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [recipe, setRecipe] = useState<IcaRecipe>(() => structuredClone(defaultIcaRecipe))
  const [fit, setFit] = useState<IcaFitResult | null>(null)
  const [applied, setApplied] = useState<IcaApplyResult | null>(null)
  const [selectedComponent, setSelectedComponent] = useState(0)
  const [excluded, setExcluded] = useState<number[]>([])
  const [truthVisible, setTruthVisible] = useState(false)
  const [view, setView] = useState<IcaView>('Component trace')
  const [pipeline, setPipeline] = useState<PipelineState>({ status: 'idle' })
  const [step, setStep] = useState(0)

  const component = fit?.components.find((item) => item.index === selectedComponent) ?? fit?.components[0]
  const isBusy = pipeline.status === 'fitting' || pipeline.status === 'applying'

  function updateRecipe<K extends keyof IcaRecipe>(key: K, value: IcaRecipe[K]) {
    setRecipe((current) => ({ ...current, [key]: value }))
    setFit(null)
    setApplied(null)
    setExcluded([])
    setTruthVisible(false)
    setStep(0)
  }

  async function handleFit() {
    setPipeline({ status: 'fitting', stage: 'Creating neural and ocular sources', progress: 14 })
    setApplied(null)
    setExcluded([])
    setTruthVisible(false)
    setStep(1)
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
      setStep(2)
    } catch (error) {
      window.clearInterval(timer)
      setPipeline({ status: 'error', message: error instanceof Error ? error.message : 'ICA fit failed safely.' })
    }
  }

  function toggleExcluded(index: number) {
    setExcluded((current) => current.includes(index) ? current.filter((item) => item !== index) : [...current, index])
    setStep(3)
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
      return 'The blink was attenuated while most neural structure was retained.'
    }
    return 'The trade-off needs review; attenuation alone is not enough.'
  }, [applied])

  return (
    <>
      <main className="workspace ica-workspace">
        <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={ICA_STEPS} step={step} onStep={setStep} />

        <aside className="control-panel ica-controls">
          <div className="panel-heading">
            <span className="eyebrow">Preprocessing · guided</span>
            <h1>Which component<br />is the blink?</h1>
            <p>Fit on a compatible high-pass copy. Inspect first; removal is always manual.</p>
          </div>

          <section className="rank-block">
            <div><ShieldCheck size={16} /><span>Rank before ICA</span></div>
            <strong>{fit ? fit.compatibility.rank : recipe.reference === 'average' ? 7 : 8}<small> / 8 channels</small></strong>
            <p>{recipe.reference === 'average' ? 'Average reference removes one independent dimension.' : 'No reference transform is reducing rank.'}</p>
          </section>

          <section className="control-section">
            <div className="section-title"><span>Artifact recipe</span><small>KNOWN INPUT</small></div>
            <IcaRange label="Blink amplitude" help="The size of the planted eye-blink artifact. More amplitude makes the blink easier to spot, but it can dominate the decomposition." value={recipe.blink_amplitude_uv} min={0} max={160} step={10} unit="µV" onChange={(value) => updateRecipe('blink_amplitude_uv', value)} />
            <IcaRange label="Sensor noise" help="Random sensor-level voltage. More noise makes component patterns and artifact detection less reliable." value={recipe.sensor_noise_uv} min={0} max={4} step={0.25} unit="µV" onChange={(value) => updateRecipe('sensor_noise_uv', value)} />
            <div className="preset-row">
              <button className={recipe.blink_amplitude_uv === 90 ? 'selected' : ''} onClick={() => updateRecipe('blink_amplitude_uv', 90)}>Planted blink</button>
              <button className={recipe.blink_amplitude_uv === 0 ? 'selected' : ''} onClick={() => updateRecipe('blink_amplitude_uv', 0)}>No-artifact control</button>
            </div>
          </section>

          <section className="control-section">
            <div className="section-title"><span>ICA fit copy</span><small>RANK-AWARE</small></div>
            <div className="parameter-row"><span>High-pass</span><strong>{recipe.fit_highpass_hz.toFixed(1)} Hz</strong></div>
            <div className="parameter-row"><span>Low-pass</span><strong>{recipe.fit_lowpass_hz.toFixed(0)} Hz</strong></div>
            <div className="segmented-field stack">
              <span className="control-label">Algorithm<ControlHint>Chooses the ICA optimization method. Both methods estimate statistically independent components, but can converge to different decompositions.</ControlHint></span>
              <div role="group" aria-label="ICA algorithm">
                <button className={recipe.algorithm === 'infomax' ? 'selected' : ''} onClick={() => updateRecipe('algorithm', 'infomax')}>Ext. Infomax</button>
                <button className={recipe.algorithm === 'fastica' ? 'selected' : ''} onClick={() => updateRecipe('algorithm', 'fastica')}>FastICA</button>
              </div>
            </div>
            <div className="segmented-field stack">
              <span className="control-label">Reference<ControlHint>Sets the voltage reference before ICA. Average reference reduces the data rank by one and affects how many components can be fit.</ControlHint></span>
              <div role="group" aria-label="ICA reference">
                <button className={recipe.reference === 'average' ? 'selected' : ''} onClick={() => updateRecipe('reference', 'average')}>Average</button>
                <button className={recipe.reference === 'none' ? 'selected' : ''} onClick={() => updateRecipe('reference', 'none')}>None</button>
              </div>
            </div>
            <IcaRange label="Components" help="How many independent components ICA attempts to estimate. It cannot exceed the data rank." value={recipe.component_count} min={3} max={7} step={1} unit="ICs" onChange={(value) => updateRecipe('component_count', value)} />
          </section>

          <button className="primary-button fit-button" onClick={handleFit} disabled={isBusy}>
            <Split size={16} /> {fit ? 'Refit decomposition' : 'Fit ICA decomposition'}
          </button>
        </aside>

        <section className="canvas-panel ica-canvas">
          <div className="canvas-toolbar ica-toolbar">
            <div>
              <span className="eyebrow">Component workbench</span>
              <h2>{component ? `IC ${String(component.index + 1).padStart(2, '0')} · inspect before exclusion` : 'No decomposition yet'}</h2>
            </div>
            <div className="view-tabs" role="tablist" aria-label="ICA visualization type">
              {(['Component trace', 'Component spectrum', 'Before / after'] as IcaView[]).map((item) => (
                <button key={item} role="tab" aria-selected={item === view} className={item === view ? 'active' : ''} disabled={item === 'Before / after' && !applied} onClick={() => setView(item)}>{item}</button>
              ))}
            </div>
          </div>

          <div className="ica-stage">
            {isBusy && (
              <div className="run-overlay" role="status" aria-live="polite">
                <div className="orbit"><Activity size={26} /></div>
                <span className="eyebrow">ICA pipeline</span>
                <h3>{pipeline.stage}</h3>
                <div className="progress-track"><i style={{ width: `${pipeline.progress}%` }} /></div>
                <p>{pipeline.progress}% · seed {recipe.seed} · {recipe.algorithm}</p>
              </div>
            )}
            {pipeline.status === 'error' && (
              <div className="empty-stage error-stage">
                <AlertTriangle size={30} /><h3>ICA stopped safely</h3><p>{pipeline.message}</p>
                <button className="quiet-button" onClick={() => setPipeline({ status: 'idle' })}><X size={14} /> Dismiss</button>
              </div>
            )}
            {!fit && pipeline.status === 'idle' && (
              <div className="ica-empty">
                <div className="causal-flow" aria-label="ICA lesson flow">
                  <span>3 neural<br />+ blink</span><i />
                  <span>8 mixed<br />sensors</span><i />
                  <span>rank-aware<br />ICA</span><i />
                  <span>manual<br />repair</span>
                </div>
                <div className="empty-wave"><Split size={39} /></div>
                <span className="eyebrow">Fit copy · 1–100 Hz</span>
                <h3>Separate first. Decide second.</h3>
                <p>ICLabel may suggest a class, but it never selects or removes a component.</p>
                <button className="primary-button" onClick={handleFit}><Split size={15} /> Fit default decomposition</button>
              </div>
            )}
            {fit && pipeline.status === 'idle' && (
              <>
                <div className="component-strip" aria-label="ICA components">
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
                </div>
                <div className="component-detail">
                  {component && view !== 'Before / after' && (
                    <div className="component-visual">
                      <div className="topography-panel">
                        <ScalpTopography values={component.topography} label={`IC ${component.index + 1}`} />
                        <div><small>EXPLAINED VARIANCE</small><strong>{component.explained_variance_pct.toFixed(1)}%</strong></div>
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
                  {applied && view === 'Before / after' && (
                    <LineChart
                      x={applied.before_after_trace.x}
                      series={Object.entries(applied.before_after_trace.series).map(([label, values], index) => ({ label, values, color: index ? '#087f83' : '#c7653c', dashed: !index }))}
                      xLabel="Time (s)" yLabel="Amplitude (µV)" ariaLabel="Fp1 before and after ICA repair"
                    />
                  )}
                </div>
              </>
            )}
          </div>

          <div className="canvas-readout ica-readout">
            <div><small>DATA RANK</small><strong>{fit ? `${fit.compatibility.rank} / 8` : '—'}</strong></div>
            <div><small>SELECTED</small><strong>{excluded.length ? excluded.map((index) => `IC ${index + 1}`).join(', ') : 'None'}</strong></div>
            <div><small>ATTENUATION</small><strong>{applied ? `${applied.artifact_attenuation_db.toFixed(1)} dB` : '—'}</strong></div>
            <div><small>NEURAL DISTORTION</small><strong>{applied ? `${applied.neural_distortion_pct.toFixed(1)}%` : '—'}</strong></div>
          </div>
        </section>

        <aside className="inspector-panel ica-inspector">
          <section className="inspector-lead">
            <span className="eyebrow">Component decision</span>
            <h2>{component ? `IC ${String(component.index + 1).padStart(2, '0')}` : 'Fit before deciding.'}</h2>
            <p>Use time course, spectrum, topography, and the advisory label together. One cue is not enough.</p>
          </section>

          {component && (
            <section className="advisory-block">
              <div><Sparkles size={16} /><span>ICLabel suggestion</span><small>ADVISORY</small></div>
              <strong>{component.suggested_label}</strong>
              <p>{Math.round(component.suggestion_probability * 100)}% predicted probability · never auto-selected</p>
              <button className={excluded.includes(component.index) ? 'remove-exclusion' : 'mark-exclusion'} onClick={() => toggleExcluded(component.index)}>
                {excluded.includes(component.index) ? <><X size={15} /> Keep this component</> : <><Trash2 size={15} /> Mark for exclusion</>}
              </button>
            </section>
          )}

          <section className={`truth-block ${truthVisible ? 'revealed' : ''}`}>
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
          </section>

          {fit?.warnings.map((warning) => (
            <section className={`warning-card ${warning.severity}`} key={warning.code}>
              <div><AlertTriangle size={16} /><strong>{warning.title}</strong></div><p>{warning.explanation}</p>
            </section>
          ))}

          {fit && (
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

          {applied && (
            <section className="score-block">
              <span className="eyebrow">Truth score · simulation only</span>
              <div><strong>{applied.artifact_attenuation_db.toFixed(1)}<small> dB</small></strong><span>blink attenuation</span></div>
              <div><strong>{applied.neural_retention_pct.toFixed(1)}<small>%</small></strong><span>neural retention</span></div>
              <p>{scoreJudgement}</p>
            </section>
          )}

          <button className="primary-button apply-button" disabled={!fit || !excluded.length || isBusy} onClick={handleApply}>
            <WandSparkles size={16} /> Apply {excluded.length || 0} manual exclusion{excluded.length === 1 ? '' : 's'}
          </button>
          <div className="nonclinical"><AlertTriangle size={15} /><span>ICLabel is advisory. Educational and research use only.</span></div>
        </aside>
      </main>

      <footer className="run-strip ica-run-strip">
        <div className="run-strip-title"><SlidersHorizontal size={16} /><span>ICA contract</span></div>
        <div className="ica-contract-flow">
          <span><small>FIT COPY</small>{recipe.fit_highpass_hz}–{recipe.fit_lowpass_hz} Hz</span><i />
          <span><small>DECOMPOSITION</small>{recipe.algorithm === 'infomax' ? 'Ext. Infomax' : 'FastICA'} · seed {recipe.seed}</span><i />
          <span><small>TARGET COPY</small>same channels · {recipe.reference} ref</span><i />
          <span className={applied?.compatibility_verified ? 'verified' : ''}><small>APPLY GATE</small>{applied?.compatibility_verified ? 'compatible' : 'pending'}</span>
        </div>
        <div className="strip-actions"><button onClick={() => updateRecipe('blink_amplitude_uv', 90)}><FlaskConical size={14} /> Restore planted blink</button></div>
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
