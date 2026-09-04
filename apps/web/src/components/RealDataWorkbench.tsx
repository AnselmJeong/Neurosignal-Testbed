import {
  AlertTriangle,
  ClipboardCheck,
  Download,
  FileOutput,
  FileSearch,
  FolderInput,
  HardDrive,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  exportQcReport,
  getEegbciLessonStatus,
  importCachedEegbci,
  importRealData,
  inspectRealData,
  reportDownloadUrl,
} from '../lib/api'
import type { EegbciLessonStatus, RealDataImportResult, RecordingInspection } from '../types'
import { LabNavigator, type LabId } from './LabNavigator'

const STEPS = [
  { label: 'Resolve', icon: FolderInput },
  { label: 'Inspect', icon: FileSearch },
  { label: 'Copy', icon: HardDrive },
  { label: 'QC', icon: ClipboardCheck },
  { label: 'Report', icon: FileOutput },
  { label: 'Review', icon: ShieldCheck },
] as const

export function RealDataWorkbench({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [sourcePath, setSourcePath] = useState('')
  const [projectName, setProjectName] = useState('Local EEG review')
  const [inspection, setInspection] = useState<RecordingInspection | null>(null)
  const [result, setResult] = useState<RealDataImportResult | null>(null)
  const [eegbci, setEegbci] = useState<EegbciLessonStatus | null>(null)
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState<'inspect' | 'import' | 'report' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { getEegbciLessonStatus().then(setEegbci).catch(() => setEegbci(null)) }, [])

  const request = { source_path: sourcePath, project_name: projectName }
  const warnings = result ? [...result.inspection.warnings, ...result.qc.warnings] : inspection?.warnings ?? []

  async function inspect() {
    if (!sourcePath.trim()) return
    setBusy('inspect'); setError(null)
    try { setInspection(await inspectRealData(request)); setResult(null); setStep(1) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not inspect this local file.') }
    finally { setBusy(null) }
  }

  async function importRecording() {
    if (!sourcePath.trim()) return
    setBusy('import'); setError(null)
    try { setResult(await importRealData(request)); setStep(3) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create the local working copy.') }
    finally { setBusy(null) }
  }

  async function importCachedRun(run: 1 | 2) {
    setBusy('import'); setError(null)
    try { setResult(await importCachedEegbci({ run, project_name: `EEGBCI offline lesson · R${String(run).padStart(2, '0')}` })); setStep(3) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open the cached EEGBCI run.') }
    finally { setBusy(null) }
  }

  async function exportReport() {
    if (!result) return
    setBusy('report'); setError(null)
    try {
      const report = await exportQcReport(result.project.project_id)
      window.open(reportDownloadUrl(report.download_path), '_blank', 'noopener,noreferrer')
      setStep(4)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not export the QC report.') }
    finally { setBusy(null) }
  }

  return <>
    <main className="workspace real-data-workspace">
      <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={STEPS} step={step} onStep={setStep} />
      <aside className="control-panel real-data-controls">
        <div className="panel-heading"><span className="eyebrow">Real data · local-only</span><h1>Inspect first.<br />Copy second.</h1><p>The selected original is opened read-only. Analysis and reports use a separate FIF working copy.</p></div>
        <section className="control-section"><div className="section-title"><span>Guided resolver</span><small>FIF · EDF · BDF · VHDR · SET</small></div><label className="path-field"><span>Local recording path</span><input value={sourcePath} onChange={(event) => { setSourcePath(event.target.value); setInspection(null); setResult(null); setStep(0) }} placeholder="/Volumes/Data/recording_raw.fif" /></label><label className="path-field"><span>Project name</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><button className="quiet-button full-button" onClick={inspect} disabled={!sourcePath.trim() || busy !== null}><FileSearch size={15} /> {busy === 'inspect' ? 'Inspecting' : 'Inspect file'}</button><button className="primary-button fit-button" onClick={importRecording} disabled={!sourcePath.trim() || busy !== null}><FolderInput size={16} /> {busy === 'import' ? 'Creating working copy' : 'Create local FIF copy'}</button></section>
        <section className="control-section cache-note"><div className="section-title"><span>EEGBCI offline lesson</span><small>SUBJECT 1 · EYES</small></div><p>{eegbci?.message ?? 'Checking the local cache…'}</p>{eegbci && <small>Available runs: {eegbci.available_runs.length ? eegbci.available_runs.map((run) => `R${String(run).padStart(2, '0')}`).join(' · ') : 'none'}</small>}{eegbci?.state === 'cached' && <div className="eegbci-actions"><button onClick={() => importCachedRun(1)} disabled={busy !== null}>Use eyes open</button><button onClick={() => importCachedRun(2)} disabled={busy !== null}>Use eyes closed</button></div>}</section>
      </aside>
      <section className="canvas-panel real-data-canvas"><div className="canvas-toolbar real-data-toolbar"><div><span className="eyebrow">Immutable source → FIF derivative → QC record</span><h2>{result ? `${result.project.project_name} · ready for report` : inspection ? `${inspection.source_name} · inspected read-only` : 'Select a local recording'}</h2></div><span className="real-data-status">{result ? 'WORKING COPY READY' : inspection ? 'INSPECTED' : 'AWAITING FILE'}</span></div><div className="real-data-stage">{error && <div className="empty-stage error-stage"><AlertTriangle size={30} /><h3>Import stopped safely</h3><p>{error}</p></div>}{!error && !inspection && !result && <div className="real-data-empty"><HardDrive size={42} /><span className="eyebrow">Original data stays untouched</span><h3>Resolve the file before any analysis.</h3><p>Metadata, channels, annotations, unit assumptions, and sensor locations are surfaced before NeuroBridge writes its FIF derivative.</p></div>}{!error && (inspection || result) && <InspectionCanvas inspection={result?.inspection ?? inspection!} result={result} />}</div><div className="canvas-readout real-data-readout"><div><small>EEG CHANNELS</small><strong>{(result?.inspection ?? inspection)?.eeg_channel_count ?? '—'}</strong></div><div><small>SAMPLING RATE</small><strong>{(result?.inspection ?? inspection) ? `${(result?.inspection ?? inspection)?.sampling_rate_hz.toFixed(0)} Hz` : '—'}</strong></div><div><small>ANNOTATIONS</small><strong>{(result?.inspection ?? inspection)?.annotation_count ?? '—'}</strong></div><div><small>WORKING COPY</small><strong>{result ? 'FIF' : '—'}</strong></div></div></section>
      <aside className="inspector-panel real-data-inspector"><section className="inspector-lead"><span className="eyebrow">Interpretation</span><h2>{result ? 'QC informs review; it does not decide.' : 'Metadata is evidence.'}</h2><p>{result ? 'The report records observed file properties, QC summaries, provenance, and caveats. It makes no recovery claim.' : 'Inspect the import evidence before deciding whether a montage, annotation, or preprocessing step is justified.'}</p></section>{warnings.map((warning) => <section className={`warning-card ${warning.severity}`} key={warning.code}><div><AlertTriangle size={16} /><strong>{warning.title}</strong></div><p>{warning.explanation}</p>{warning.suggestion && <small>{warning.suggestion}</small>}</section>)}{result && <section className="qc-summary"><div className="section-title"><span>QC summary</span><small>DESCRIPTIVE</small></div><dl><div><dt>Potentially flat</dt><dd>{result.qc.flat_channels.join(', ') || 'None'}</dd></div><div><dt>Marked bad</dt><dd>{result.qc.bad_channels.join(', ') || 'None'}</dd></div><div><dt>8–12 Hz relative power</dt><dd>{result.qc.alpha_relative_power?.toFixed(3) ?? '—'}</dd></div><div><dt>Schema</dt><dd>v{result.project.schema_version} · {result.project.migration_status}</dd></div></dl><button className="primary-button fit-button" onClick={exportReport} disabled={busy !== null}><Download size={15} /> {busy === 'report' ? 'Exporting' : 'Export HTML report'}</button></section>}<div className="nonclinical"><AlertTriangle size={15} /><span>Local descriptive QC only.<br />Not clinical diagnosis.</span></div></aside>
    </main>
    <footer className="run-strip real-data-run-strip"><div className="run-strip-title"><RefreshCw size={16} /><span>Recovery contract</span></div><div className="real-data-contract-flow"><span><small>ORIGINAL</small>read-only</span><i /><span><small>RESOLVE</small>metadata visible</span><i /><span><small>DERIVATIVE</small>FIF working copy</span><i /><span><small>RECOVER</small>schema migration</span><i /><span><small>REPORT</small>local HTML</span></div><div className="strip-actions"><button onClick={exportReport} disabled={!result || busy !== null}><FileOutput size={14} /> Export QC</button></div></footer>
  </>
}

function InspectionCanvas({ inspection, result }: { inspection: RecordingInspection; result: RealDataImportResult | null }) {
  return <div className="inspection-canvas"><div className="inspection-card"><span className="eyebrow">Import evidence</span><h3>{inspection.source_name}</h3><p>{inspection.format.toUpperCase()} · {inspection.duration_s.toFixed(1)} s · {inspection.channel_count} channels</p><code>{inspection.source_sha256.slice(0, 20)}…</code></div><div className="inspection-grid"><div><small>CHANNEL TYPES</small><strong>{Object.entries(inspection.channel_types).map(([type, count]) => `${count} ${type}`).join(' · ')}</strong></div><div><small>FILTER METADATA</small><strong>{inspection.highpass_hz ?? '—'}–{inspection.lowpass_hz ?? '—'} Hz</strong></div><div><small>DIGITIZATION</small><strong>{inspection.montage_present ? `${inspection.digitization_point_count} points` : 'Not attached'}</strong></div><div><small>PROJECT STATUS</small><strong>{result ? `FIF saved · ${result.project.project_id}` : 'No derivative written'}</strong></div></div></div>
}
