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
import { RealDataTracePanel } from './RealDataTracePanel'

const STEPS = [
  { label: '찾기(Resolve)', description: '지원하는 기록 파일을 안전하게 찾습니다.', icon: FolderInput },
  { label: '점검(Inspect)', description: '파일을 만들기 전에 메타데이터를 봅니다.', icon: FileSearch },
  { label: '사본(Copy)', description: '별도의 FIF 작업 사본을 만듭니다.', icon: HardDrive },
  { label: '품질 점검(QC)', description: '기술적 품질 지표를 계산합니다.', icon: ClipboardCheck },
  { label: '보고서(Report)', description: '출처 기록과 QC 근거를 내보냅니다.', icon: FileOutput },
  { label: '검토(Review)', description: '임상적 주장 없이 결과를 해석합니다.', icon: ShieldCheck },
] as const
const ACTIVE_REAL_PROJECT_KEY = 'neurosignal-active-real-data-project'

export function RealDataWorkbench({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [sourcePath, setSourcePath] = useState('')
  const [projectName, setProjectName] = useState('로컬 EEG 검토')
  const [inspection, setInspection] = useState<RecordingInspection | null>(null)
  const [result, setResult] = useState<RealDataImportResult | null>(null)
  const [eegbci, setEegbci] = useState<EegbciLessonStatus | null>(null)
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState<'inspect' | 'import' | 'report' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { getEegbciLessonStatus().then(setEegbci).catch(() => setEegbci(null)) }, [])
  useEffect(() => {
    if (result) window.localStorage.setItem(ACTIVE_REAL_PROJECT_KEY, result.project.project_id)
  }, [result])

  const request = { source_path: sourcePath, project_name: projectName }
  const warnings = result ? [...result.inspection.warnings, ...result.qc.warnings] : inspection?.warnings ?? []

  async function inspect() {
    if (!sourcePath.trim()) return
    setBusy('inspect'); setError(null)
    try { setInspection(await inspectRealData(request)); setResult(null); setStep(1) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '이 로컬 파일을 점검하지 못했습니다.') }
    finally { setBusy(null) }
  }

  async function importRecording() {
    if (!sourcePath.trim()) return
    setBusy('import'); setError(null)
    try { setResult(await importRealData(request)); setStep(3) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '로컬 작업 사본을 만들지 못했습니다.') }
    finally { setBusy(null) }
  }

  async function importCachedRun(run: 1 | 2) {
    setBusy('import'); setError(null)
    try { setResult(await importCachedEegbci({ run, project_name: `EEGBCI 오프라인 실습 · R${String(run).padStart(2, '0')}` })); setStep(3) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '캐시된 EEGBCI 기록을 열지 못했습니다.') }
    finally { setBusy(null) }
  }

  async function exportReport() {
    if (!result) return
    setBusy('report'); setError(null)
    try {
      const report = await exportQcReport(result.project.project_id)
      window.open(reportDownloadUrl(report.download_path), '_blank', 'noopener,noreferrer')
      setStep(4)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'QC 보고서를 내보내지 못했습니다.') }
    finally { setBusy(null) }
  }

  return <>
    <main className="workspace real-data-workspace">
      <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={STEPS} step={step} />
      <aside className="control-panel real-data-controls">
        <div className="panel-heading"><span className="eyebrow">실제 자료 · 로컬 전용</span><h1>먼저 점검하고,<br />그다음 복사한다.</h1><p>고른 원본은 읽기 전용으로 엽니다. 분석과 보고서는 별도의 FIF 작업 사본을 씁니다.</p></div>
        <section className="control-section"><div className="section-title"><span>파일 찾기 안내</span><small>FIF · EDF · BDF · VHDR · SET</small></div><label className="path-field"><span>로컬 기록 경로</span><input value={sourcePath} onChange={(event) => { setSourcePath(event.target.value); setInspection(null); setResult(null); setStep(0) }} placeholder="/Volumes/Data/recording_raw.fif" /></label><label className="path-field"><span>프로젝트 이름</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><button className="quiet-button full-button" onClick={inspect} disabled={!sourcePath.trim() || busy !== null}><FileSearch size={15} /> {busy === 'inspect' ? '점검 중' : '파일 점검(Inspect)'}</button><button className="primary-button fit-button" onClick={importRecording} disabled={!sourcePath.trim() || busy !== null}><FolderInput size={16} /> {busy === 'import' ? '작업 사본 만드는 중' : '로컬 FIF 사본 만들기'}</button></section>
        <section className="control-section cache-note"><div className="section-title"><span>EEGBCI 오프라인 실습</span><small>피험자 1 · 눈 뜨고/감고</small></div><p>{eegbci?.message ?? '로컬 캐시를 확인하는 중…'}</p>{eegbci && <small>쓸 수 있는 기록: {eegbci.available_runs.length ? eegbci.available_runs.map((run) => `R${String(run).padStart(2, '0')}`).join(' · ') : '없음'}</small>}{eegbci?.state === 'cached' && <div className="eegbci-actions"><button onClick={() => importCachedRun(1)} disabled={busy !== null}>눈 뜬 기록 쓰기</button><button onClick={() => importCachedRun(2)} disabled={busy !== null}>눈 감은 기록 쓰기</button></div>}</section>
      </aside>
      <section className="canvas-panel real-data-canvas"><div className="canvas-toolbar real-data-toolbar"><div><span className="eyebrow"><span className="data-kind real">실제 기록 · 정답 없음</span> 바뀌지 않는 원본 → FIF 파생본 → QC 기록</span><h2>{result ? `${result.project.project_name} · 보고서 준비됨` : inspection ? `${inspection.source_name} · 읽기 전용으로 점검함` : '로컬 기록을 고르세요'}</h2></div><span className="real-data-status">{result ? '작업 사본 준비됨' : inspection ? '점검함' : '파일 대기 중'}</span></div><div className="real-data-stage">{error && <div className="empty-stage error-stage"><AlertTriangle size={30} /><h3>가져오기를 안전하게 멈췄습니다</h3><p>{error}</p></div>}{!error && !inspection && !result && <div className="real-data-empty"><HardDrive size={42} /><span className="eyebrow">원본 자료는 건드리지 않습니다</span><h3>분석 전에 파일부터 확인합니다.</h3><p>NeuroSignal이 FIF 파생본을 쓰기 전에 메타데이터, 채널, 주석(annotation), 단위 가정, 센서 위치를 먼저 보여 줍니다.</p></div>}{!error && (inspection || result) && (result ? <div className="real-data-review-content"><details className="real-data-import-details"><summary>가져오기 근거 · {result.inspection.channel_count}채널 · {result.inspection.duration_s.toFixed(1)} s</summary><InspectionCanvas inspection={result.inspection} result={result} /></details><RealDataTracePanel projectId={result.project.project_id} /></div> : <InspectionCanvas inspection={inspection!} result={null} />)}</div><div className="canvas-readout real-data-readout"><div><small>EEG 채널</small><strong>{(result?.inspection ?? inspection)?.eeg_channel_count ?? '—'}</strong></div><div><small>표본화율</small><strong>{(result?.inspection ?? inspection) ? `${(result?.inspection ?? inspection)?.sampling_rate_hz.toFixed(0)} Hz` : '—'}</strong></div><div><small>주석</small><strong>{(result?.inspection ?? inspection)?.annotation_count ?? '—'}</strong></div><div><small>작업 사본</small><strong>{result ? 'FIF' : '—'}</strong></div></div></section>
      <aside className="inspector-panel real-data-inspector"><section className="inspector-lead"><span className="eyebrow">해석(Interpretation)</span><h2>{result ? 'QC는 검토를 돕지만 판단하지는 않는다.' : '메타데이터도 증거다.'}</h2><p>{result ? '보고서는 관찰한 파일 속성, QC 요약, 출처 기록, 주의 사항을 남깁니다. 신호를 되살렸다고 주장하지 않습니다.' : '몽타주, 주석, 전처리 단계가 필요한지 정하기 전에 가져오기 근거를 살펴보세요.'}</p></section>{warnings.map((warning) => <section className={`warning-card ${warning.severity}`} key={warning.code}><div><AlertTriangle size={16} /><strong>{warning.title}</strong></div><p>{warning.explanation}</p>{warning.suggestion && <small>{warning.suggestion}</small>}</section>)}{result && <section className="qc-summary"><div className="section-title"><span>QC 요약</span><small>기술적</small></div><dl><div><dt>평평할 수 있는 채널</dt><dd>{result.qc.flat_channels.join(', ') || '없음'}</dd></div><div><dt>불량 표시 채널</dt><dd>{result.qc.bad_channels.join(', ') || '없음'}</dd></div><div><dt>8–12 Hz 상대 파워</dt><dd>{result.qc.alpha_relative_power?.toFixed(3) ?? '—'}</dd></div><div><dt>스키마</dt><dd>v{result.project.schema_version} · {result.project.migration_status}</dd></div></dl><button className="primary-button fit-button" onClick={exportReport} disabled={busy !== null}><Download size={15} /> {busy === 'report' ? '내보내는 중' : 'HTML 보고서 내보내기'}</button><button className="quiet-button fit-button" onClick={() => onLabChange('qeeg')}>QEEG 분석으로 이어 가기</button></section>}<div className="nonclinical"><AlertTriangle size={15} /><span>로컬 기술적 QC일 뿐입니다.<br />임상 진단이 아닙니다.</span></div></aside>
    </main>
    <footer className="run-strip real-data-run-strip"><div className="run-strip-title"><RefreshCw size={16} /><span>복구 약속</span></div><div className="real-data-contract-flow"><span><small>원본</small>읽기 전용</span><i /><span><small>찾기</small>메타데이터 표시</span><i /><span><small>파생본</small>FIF 작업 사본</span><i /><span><small>복구</small>스키마 이전</span><i /><span><small>보고서</small>로컬 HTML</span></div><div className="strip-actions"><button onClick={exportReport} disabled={!result || busy !== null}><FileOutput size={14} /> QC 내보내기</button></div></footer>
  </>
}

function InspectionCanvas({ inspection, result }: { inspection: RecordingInspection; result: RealDataImportResult | null }) {
  return <div className="inspection-canvas"><div className="inspection-card"><span className="eyebrow">가져오기 근거</span><h3>{inspection.source_name}</h3><p>{inspection.format.toUpperCase()} · {inspection.duration_s.toFixed(1)} s · {inspection.channel_count}채널</p><code>{inspection.source_sha256.slice(0, 20)}…</code></div><div className="inspection-grid"><div><small>채널 종류</small><strong>{Object.entries(inspection.channel_types).map(([type, count]) => `${count} ${type}`).join(' · ')}</strong></div><div><small>필터 메타데이터</small><strong>{inspection.highpass_hz ?? '—'}–{inspection.lowpass_hz ?? '—'} Hz</strong></div><div><small>전극 좌표(Digitization)</small><strong>{inspection.montage_present ? `${inspection.digitization_point_count}점` : '없음'}</strong></div><div><small>프로젝트 상태</small><strong>{result ? `FIF 저장됨 · ${result.project.project_id}` : '파생본 없음'}</strong></div></div></div>
}
