import {
  Activity,
  AlertTriangle,
  Brain,
  ChartNoAxesCombined,
  CircleDot,
  Filter,
  Network,
  Play,
  ScanSearch,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { runRealDataQeeg } from '../lib/api'
import {
  defaultRealDataQeegRequest,
  type QeegBandPower,
  type RealDataQeegRequest,
  type RealDataQeegResult,
} from '../types'
import { LineChart } from './Charts'
import { ConnectivityHeatmap } from './ConnectivityViews'
import { LabNavigator, type LabId } from './LabNavigator'

const ACTIVE_REAL_PROJECT_KEY = 'neurosignal-active-real-data-project'
const STEPS = [
  { label: 'Configure', description: 'Choose a defensible preprocessing recipe.', icon: Filter },
  { label: 'Filter', description: 'Create a new filtered derivative.', icon: Activity },
  { label: 'Review ICA', description: 'Inspect components before excluding any.', icon: ScanSearch },
  { label: 'Quantify', description: 'Compute PSD, band power, and theta/beta.', icon: ChartNoAxesCombined },
  { label: 'Map', description: 'Compare topography, coherence, and PLV.', icon: Network },
  { label: 'Interpret', description: 'Record caveats and avoid diagnostic claims.', icon: CircleDot },
] as const

const VIEWS = ['PSD', 'Band power', 'Topomap', 'Coherence', 'PLV', 'ICA review'] as const
type View = (typeof VIEWS)[number]

export function parseIcaExclusions(value: string): number[] {
  return value.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(Number)
    .filter((item) => Number.isInteger(item) && item >= 0)
}

export function ImportedQeegWorkbench({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [projectId, setProjectId] = useState(() => window.localStorage.getItem(ACTIVE_REAL_PROJECT_KEY) ?? '')
  const [request, setRequest] = useState<RealDataQeegRequest>({ ...defaultRealDataQeegRequest })
  const [excludeText, setExcludeText] = useState('')
  const [result, setResult] = useState<RealDataQeegResult | null>(null)
  const [view, setView] = useState<View>('PSD')
  const [selectedBand, setSelectedBand] = useState<QeegBandPower['name']>('alpha')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState(0)

  const parsedExclusions = useMemo(() => parseIcaExclusions(excludeText), [excludeText])

  function update<K extends keyof RealDataQeegRequest>(key: K, value: RealDataQeegRequest[K]) {
    setRequest((current) => ({ ...current, [key]: value }))
    setStep(0)
  }

  function updateProjectId(value: string) {
    setProjectId(value)
    if (value.trim()) window.localStorage.setItem(ACTIVE_REAL_PROJECT_KEY, value.trim())
    else window.localStorage.removeItem(ACTIVE_REAL_PROJECT_KEY)
  }

  async function run() {
    if (!projectId.trim()) return
    setBusy(true); setError(null); setStep(1)
    try {
      const next = await runRealDataQeeg(projectId.trim(), {
        ...request,
        ica_exclude_components: request.ica_enabled ? parsedExclusions : [],
      })
      setResult(next)
      setStep(request.ica_enabled && parsedExclusions.length === 0 ? 2 : 3)
      setView(request.ica_enabled && parsedExclusions.length === 0 ? 'ICA review' : 'PSD')
      window.localStorage.setItem(ACTIVE_REAL_PROJECT_KEY, projectId.trim())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'QEEG analysis stopped safely.')
      setStep(0)
    } finally { setBusy(false) }
  }

  const selectedTopomap = result?.topomaps.find((item) => item.band === selectedBand)
  const selectedBandPower = result?.band_powers.find((item) => item.name === selectedBand)
  const selectedMatrix = view === 'PLV' ? result?.plv : result?.coherence

  return <>
    <main className="workspace qeeg-workspace">
      <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={STEPS} step={step} />
      <aside className="control-panel qeeg-controls">
        <div className="panel-heading"><span className="eyebrow">Real data · QEEG</span><h1>Clean first.<br />Interpret last.</h1><p>Every run starts from the immutable FIF working copy and writes a separate derivative.</p></div>
        <section className="control-section">
          <div className="section-title"><span>Project</span><small>LOCAL ID</small></div>
          <label className="path-field"><span>Imported project ID</span><input value={projectId} onChange={(event) => updateProjectId(event.target.value)} placeholder="real_…" /></label>
          {!projectId && <small className="field-note">Import or open an EEG recording in Real data first.</small>}
        </section>
        <section className="control-section qeeg-setting-grid">
          <div className="section-title"><span>Preprocessing</span><small>NEW DERIVATIVE</small></div>
          <NumberSetting label="High-pass" value={request.highpass_hz} min={0.1} max={20} step={0.5} unit="Hz" onChange={(value) => update('highpass_hz', value)} />
          <NumberSetting label="Low-pass" value={request.lowpass_hz} min={10} max={100} step={5} unit="Hz" onChange={(value) => update('lowpass_hz', value)} />
          <label className="select-field"><span>Reference</span><select value={request.reference} onChange={(event) => update('reference', event.target.value as 'average' | 'none')}><option value="average">Average</option><option value="none">Keep current</option></select></label>
          <label className="toggle-row"><input type="checkbox" checked={request.notch_hz !== null} onChange={(event) => update('notch_hz', event.target.checked ? 60 : null)} /><span>60 Hz notch</span></label>
          <label className="toggle-row"><input type="checkbox" checked={request.reject_by_annotation} onChange={(event) => update('reject_by_annotation', event.target.checked)} /><span>Reject bad annotations</span></label>
        </section>
        <section className="control-section">
          <div className="section-title"><span>ICA</span><small>MANUAL REVIEW</small></div>
          <label className="toggle-row"><input type="checkbox" checked={request.ica_enabled} onChange={(event) => update('ica_enabled', event.target.checked)} /><span>Fit ICA components</span></label>
          {request.ica_enabled && <><label className="select-field"><span>Method</span><select value={request.ica_method} onChange={(event) => update('ica_method', event.target.value as 'fastica' | 'infomax')}><option value="fastica">FastICA</option><option value="infomax">Extended Infomax</option></select></label><label className="path-field"><span>Exclude after review</span><input value={excludeText} onChange={(event) => setExcludeText(event.target.value)} placeholder="e.g. 0, 3" /></label><small className="field-note">Leave blank for the first fit. Component numbers are never auto-excluded.</small></>}
        </section>
        <section className="control-section">
          <div className="section-title"><span>Connectivity</span><small>MULTITAPER</small></div>
          <label className="select-field"><span>Band</span><select value={request.connectivity_band} onChange={(event) => update('connectivity_band', event.target.value as 'theta' | 'alpha' | 'beta')}><option value="theta">Theta · 4–8 Hz</option><option value="alpha">Alpha · 8–13 Hz</option><option value="beta">Beta · 13–30 Hz</option></select></label>
        </section>
        <button className="primary-button fit-button" onClick={run} disabled={!projectId.trim() || busy}><Play size={15} fill="currentColor" /> {busy ? 'Analyzing derivative' : 'Run QEEG analysis'}</button>
      </aside>

      <section className="canvas-panel qeeg-canvas">
        <div className="canvas-toolbar qeeg-toolbar"><div><span className="eyebrow">PSD · band ratios · sensor connectivity</span><h2>{result ? `${result.channel_names.length} channels · ${result.analyzed_duration_s.toFixed(1)} s analyzed` : 'Configure an imported recording'}</h2></div><div className="view-tabs" role="tablist">{VIEWS.map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => { setView(item); if (item === 'Topomap' || item === 'Coherence' || item === 'PLV') setStep(4) }} disabled={!result || (item === 'ICA review' && !result.ica_components.length)}>{item}</button>)}</div></div>
        <div className="qeeg-stage">
          {error && <div className="empty-stage error-stage"><AlertTriangle size={30} /><h3>Analysis stopped safely</h3><p>{error}</p></div>}
          {!error && !result && <div className="qeeg-empty"><Brain size={42} /><span className="eyebrow">No normative comparison</span><h3>Build a transparent QEEG derivative.</h3><p>Use a local project, record every preprocessing choice, and inspect ICA components before excluding them.</p></div>}
          {!error && result && view === 'PSD' && <div className="qeeg-chart"><LineChart x={result.frequency_hz} series={[{ label: 'Mean PSD', values: result.mean_psd_uv2_hz }]} xLabel="Frequency (Hz)" yLabel="µV²/Hz" ariaLabel="Mean channel power spectral density" logY height={430} /></div>}
          {!error && result && view === 'Band power' && <BandPowerView bands={result.band_powers} ratio={result.mean_theta_beta_ratio} />}
          {!error && result && view === 'Topomap' && <div className="topomap-view"><div className="band-tabs">{result.band_powers.map((band) => <button key={band.name} className={selectedBand === band.name ? 'active' : ''} onClick={() => setSelectedBand(band.name)}>{band.name}<small>{band.low_hz}–{band.high_hz} Hz</small></button>)}</div>{selectedTopomap?.available ? <SensorTopomap names={selectedTopomap.channel_names} positions={selectedTopomap.sensor_positions} values={selectedTopomap.relative_power} label={`${selectedBand} relative power`} /> : <div className="empty-stage"><AlertTriangle size={28} /><h3>Verified positions required</h3><p>This file has no complete sensor geometry, so NeuroSignal does not invent a topomap.</p></div>}<div className="topomap-caption"><strong>{selectedBand.toUpperCase()}</strong><span>Mean relative power {(100 * (selectedBandPower?.mean_relative_power ?? 0)).toFixed(1)}%</span></div></div>}
          {!error && result && (view === 'Coherence' || view === 'PLV') && selectedMatrix && <ConnectivityHeatmap matrix={{ node_names: selectedMatrix.channel_names, values: selectedMatrix.values, space: 'sensor', metric: selectedMatrix.method, band_hz: selectedMatrix.band_hz }} threshold={1.1} />}
          {!error && result && view === 'ICA review' && <IcaReview result={result} />}
        </div>
        <div className="canvas-readout qeeg-readout"><div><small>THETA / BETA</small><strong>{result?.mean_theta_beta_ratio?.toFixed(2) ?? '—'}</strong></div><div><small>ICA EXCLUDED</small><strong>{result?.ica_excluded_components.join(', ') || 'None'}</strong></div><div><small>CONNECTIVITY EPOCHS</small><strong>{result?.coherence.epoch_count ?? '—'}</strong></div><div><small>OUTPUT</small><strong>{result ? 'FIF + JSON' : '—'}</strong></div></div>
      </section>

      <aside className="inspector-panel qeeg-inspector"><section className="inspector-lead"><span className="eyebrow">Interpretation guardrail</span><h2>Numbers depend on the recipe.</h2><p>Band boundaries, reference, vigilance, artifacts, epoch length, and montage all change the result. Theta/beta is a ratio, not a standalone diagnosis.</p></section>{result?.warnings.map((warning) => <section className={`warning-card ${warning.severity}`} key={warning.code}><div><AlertTriangle size={16} /><strong>{warning.title}</strong></div><p>{warning.explanation}</p>{warning.suggestion && <small>{warning.suggestion}</small>}</section>)}{result && <section className="qc-summary"><div className="section-title"><span>Reproducibility</span><small>RUN RECORD</small></div><dl><div><dt>Run</dt><dd>{result.run_id}</dd></div><div><dt>MNE</dt><dd>{result.provenance.mne_version}</dd></div><div><dt>MNE-Connectivity</dt><dd>{result.provenance.mne_connectivity_version}</dd></div><div><dt>Recipe hash</dt><dd>{result.provenance.recipe_hash.slice(0, 12)}…</dd></div></dl></section>}</aside>
    </main>
    <footer className="run-strip qeeg-run-strip"><div className="run-strip-title"><Activity size={16} /><span>QEEG derivative</span></div><div className="real-data-contract-flow"><span><small>WORKING COPY</small>immutable</span><i /><span><small>FILTER</small>{request.highpass_hz}–{request.lowpass_hz} Hz</span><i /><span><small>ICA</small>{request.ica_enabled ? 'reviewed' : 'off'}</span><i /><span><small>QUANTIFY</small>PSD + bands</span><i /><span><small>CONNECT</small>coh + PLV</span></div><div className="strip-actions"><button onClick={() => setStep(5)} disabled={!result}>Review caveats</button></div></footer>
  </>
}

function NumberSetting({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void }) {
  return <label className="number-setting"><span>{label}</span><span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /><small>{unit}</small></span></label>
}

function BandPowerView({ bands, ratio }: { bands: QeegBandPower[]; ratio: number | null }) {
  const maximum = Math.max(...bands.map((band) => band.mean_relative_power), 0.01)
  return <div className="band-power-view"><span className="eyebrow">Mean relative power</span><div className="band-bars">{bands.map((band) => <div key={band.name}><span><strong>{band.name}</strong><small>{band.low_hz}–{band.high_hz} Hz</small></span><i><b style={{ width: `${(band.mean_relative_power / maximum) * 100}%` }} /></i><em>{(band.mean_relative_power * 100).toFixed(1)}%</em></div>)}</div><div className="ratio-card"><small>MEAN THETA / BETA</small><strong>{ratio?.toFixed(3) ?? 'Unavailable'}</strong><p>Calculated channel by channel from relative 4–8 Hz and 13–30 Hz power, then averaged across finite ratios.</p></div></div>
}

function mapColor(value: number, low: number, high: number): string {
  const amount = high > low ? Math.max(0, Math.min(1, (value - low) / (high - low))) : 0.5
  return `hsl(${205 - amount * 165} 56% ${62 - amount * 18}%)`
}

function SensorTopomap({ names, positions, values, label }: { names: string[]; positions: [number, number][]; values: number[]; label: string }) {
  const low = Math.min(...values); const high = Math.max(...values)
  return <svg className="real-sensor-map" viewBox="0 0 320 330" role="img" aria-label={label}><path className="head-outline" d="M160 25 C88 25 52 80 52 168 C52 249 98 289 160 289 C222 289 268 249 268 168 C268 80 232 25 160 25Z" /><path className="head-detail" d="M142 28 L160 8 L178 28 M52 125 C30 128 30 182 53 188 M268 125 C290 128 290 182 267 188" />{positions.map(([x, y], index) => <g key={names[index]} transform={`translate(${160 + x * 108} ${160 - y * 108})`}><circle r="13" fill={mapColor(values[index] ?? 0, low, high)}><title>{names[index]}: {((values[index] ?? 0) * 100).toFixed(2)}%</title></circle><text y="3" textAnchor="middle">{names[index]}</text></g>)}</svg>
}

function IcaReview({ result }: { result: RealDataQeegResult }) {
  return <div className="ica-review-grid">{result.ica_components.map((component) => <article key={component.index} className={result.ica_excluded_components.includes(component.index) ? 'excluded' : ''}><span>IC {component.index}</span><strong>{component.explained_variance_pct.toFixed(1)}%</strong><small>{component.peak_frequency_hz?.toFixed(1) ?? '—'} Hz peak</small><div>{component.topography.map((value, index) => <i key={index} style={{ height: `${18 + Math.abs(value) * 42}px`, background: value >= 0 ? '#087f83' : '#c7653c' }} />)}</div>{result.ica_excluded_components.includes(component.index) && <em>EXCLUDED</em>}</article>)}</div>
}
