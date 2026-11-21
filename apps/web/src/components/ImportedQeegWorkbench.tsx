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
  { label: '설정(Configure)', description: '근거를 댈 수 있는 전처리 설정을 고릅니다.', icon: Filter },
  { label: '필터(Filter)', description: '필터링한 새 파생본을 만듭니다.', icon: Activity },
  { label: 'ICA 검토', description: '제외하기 전에 성분을 살펴봅니다.', icon: ScanSearch },
  { label: '정량화(Quantify)', description: 'PSD, 대역 파워, 세타/베타를 계산합니다.', icon: ChartNoAxesCombined },
  { label: '지도(Map)', description: '지형도, 코히어런스, PLV를 비교합니다.', icon: Network },
  { label: '해석(Interpret)', description: '주의 사항을 남기고 진단적 주장을 피합니다.', icon: CircleDot },
] as const

const VIEWS = ['PSD', 'Band power', 'Topomap', 'Coherence', 'PLV', 'ICA review'] as const
type View = (typeof VIEWS)[number]
const VIEW_LABELS: Record<View, string> = { PSD: 'PSD', 'Band power': '대역 파워', Topomap: '지형도', Coherence: '코히어런스', PLV: 'PLV', 'ICA review': 'ICA 검토' }

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
        <div className="panel-heading"><span className="eyebrow"><span className="data-kind real">실제 기록 · 정답 없음</span> 실제 자료 · QEEG</span><h1>먼저 정리하고,<br />해석은 마지막에.</h1><p>모든 실행은 바뀌지 않는 FIF 작업 사본에서 시작해 별도의 파생본을 씁니다.</p></div>
        <section className="control-section">
          <div className="section-title"><span>프로젝트</span><small>로컬 ID</small></div>
          <label className="path-field"><span>가져온 프로젝트 ID</span><input value={projectId} onChange={(event) => updateProjectId(event.target.value)} placeholder="real_…" /></label>
          {!projectId && <small className="field-note">먼저 실제 자료 Lab에서 EEG 기록을 가져오거나 여세요.</small>}
        </section>
        <section className="control-section qeeg-setting-grid">
          <div className="section-title"><span>전처리</span><small>새 파생본</small></div>
          <NumberSetting label="고역 통과(High-pass)" value={request.highpass_hz} min={0.1} max={20} step={0.5} unit="Hz" onChange={(value) => update('highpass_hz', value)} />
          <NumberSetting label="저역 통과(Low-pass)" value={request.lowpass_hz} min={10} max={100} step={5} unit="Hz" onChange={(value) => update('lowpass_hz', value)} />
          <label className="select-field"><span>기준전극(Reference)</span><select value={request.reference} onChange={(event) => update('reference', event.target.value as 'average' | 'none')}><option value="average">평균(Average)</option><option value="none">현재 그대로</option></select></label>
          <label className="toggle-row"><input type="checkbox" checked={request.notch_hz !== null} onChange={(event) => update('notch_hz', event.target.checked ? 60 : null)} /><span>60 Hz 노치(Notch)</span></label>
          <label className="toggle-row"><input type="checkbox" checked={request.reject_by_annotation} onChange={(event) => update('reject_by_annotation', event.target.checked)} /><span>bad 주석 구간 제외</span></label>
        </section>
        <section className="control-section">
          <div className="section-title"><span>ICA</span><small>직접 검토</small></div>
          <label className="toggle-row"><input type="checkbox" checked={request.ica_enabled} onChange={(event) => update('ica_enabled', event.target.checked)} /><span>ICA 성분 적합(Fit ICA components)</span></label>
          {request.ica_enabled && <><label className="select-field"><span>방법</span><select value={request.ica_method} onChange={(event) => update('ica_method', event.target.value as 'fastica' | 'infomax')}><option value="fastica">FastICA</option><option value="infomax">Extended Infomax</option></select></label><label className="path-field"><span>검토 후 제외할 성분</span><input value={excludeText} onChange={(event) => setExcludeText(event.target.value)} placeholder="예: 0, 3" /></label><small className="field-note">첫 적합에서는 비워 두세요. 성분을 자동으로 제외하지 않습니다.</small></>}
        </section>
        <section className="control-section">
          <div className="section-title"><span>연결성</span><small>MULTITAPER</small></div>
          <label className="select-field"><span>대역</span><select value={request.connectivity_band} onChange={(event) => update('connectivity_band', event.target.value as 'theta' | 'alpha' | 'beta')}><option value="theta">세타(Theta) · 4–8 Hz</option><option value="alpha">알파(Alpha) · 8–13 Hz</option><option value="beta">베타(Beta) · 13–30 Hz</option></select></label>
        </section>
        <button className="primary-button fit-button" onClick={run} disabled={!projectId.trim() || busy}><Play size={15} fill="currentColor" /> {busy ? '파생본 분석 중' : 'QEEG 분석 실행'}</button>
      </aside>

      <section className="canvas-panel qeeg-canvas">
        <div className="canvas-toolbar qeeg-toolbar"><div><span className="eyebrow">PSD · 대역 비 · 센서 연결성</span><h2>{result ? `${result.channel_names.length}채널 · ${result.analyzed_duration_s.toFixed(1)} s 분석` : '가져온 기록을 설정하세요'}</h2></div><div className="view-tabs" role="tablist">{VIEWS.map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => { setView(item); if (item === 'Topomap' || item === 'Coherence' || item === 'PLV') setStep(4) }} disabled={!result || (item === 'ICA review' && !result.ica_components.length)}>{VIEW_LABELS[item]}</button>)}</div></div>
        <div className="qeeg-stage">
          {error && <div className="empty-stage error-stage"><AlertTriangle size={30} /><h3>분석을 안전하게 멈췄습니다</h3><p>{error}</p></div>}
          {!error && !result && <div className="qeeg-empty"><Brain size={42} /><span className="eyebrow">규준 비교 없음</span><h3>과정이 투명한 QEEG 파생본을 만듭니다.</h3><p>로컬 프로젝트를 쓰고, 전처리 선택을 모두 기록하고, ICA 성분은 제외하기 전에 살펴보세요.</p></div>}
          {!error && result && view === 'PSD' && <div className="qeeg-chart"><LineChart x={result.frequency_hz} series={[{ label: '평균 PSD', values: result.mean_psd_uv2_hz }]} xLabel="주파수(Hz)" yLabel="µV²/Hz" ariaLabel="Mean channel power spectral density" logY height={430} /></div>}
          {!error && result && view === 'Band power' && <BandPowerView bands={result.band_powers} ratio={result.mean_theta_beta_ratio} />}
          {!error && result && view === 'Topomap' && <div className="topomap-view"><div className="band-tabs">{result.band_powers.map((band) => <button key={band.name} className={selectedBand === band.name ? 'active' : ''} onClick={() => setSelectedBand(band.name)}>{band.name}<small>{band.low_hz}–{band.high_hz} Hz</small></button>)}</div>{selectedTopomap?.available ? <SensorTopomap names={selectedTopomap.channel_names} positions={selectedTopomap.sensor_positions} values={selectedTopomap.relative_power} label={`${selectedBand} relative power`} /> : <div className="empty-stage"><AlertTriangle size={28} /><h3>확인된 전극 위치가 필요합니다</h3><p>이 파일에는 완전한 센서 위치가 없어서 NeuroSignal은 지형도를 지어내지 않습니다.</p></div>}<div className="topomap-caption"><strong>{selectedBand.toUpperCase()}</strong><span>평균 상대 파워 {(100 * (selectedBandPower?.mean_relative_power ?? 0)).toFixed(1)}%</span></div></div>}
          {!error && result && (view === 'Coherence' || view === 'PLV') && selectedMatrix && <ConnectivityHeatmap matrix={{ node_names: selectedMatrix.channel_names, values: selectedMatrix.values, space: 'sensor', metric: selectedMatrix.method, band_hz: selectedMatrix.band_hz }} threshold={1.1} />}
          {!error && result && view === 'ICA review' && <IcaReview result={result} />}
        </div>
        <div className="canvas-readout qeeg-readout"><div><small>세타 / 베타</small><strong>{result?.mean_theta_beta_ratio?.toFixed(2) ?? '—'}</strong></div><div><small>ICA 제외</small><strong>{result?.ica_excluded_components.join(', ') || '없음'}</strong></div><div><small>연결성 epoch</small><strong>{result?.coherence.epoch_count ?? '—'}</strong></div><div><small>출력</small><strong>{result ? 'FIF + JSON' : '—'}</strong></div></div>
      </section>

      <aside className="inspector-panel qeeg-inspector"><section className="inspector-lead"><span className="eyebrow">해석의 안전장치</span><h2>숫자는 설정에 달려 있다.</h2><p>대역 경계, 기준전극, 각성 상태, 아티팩트, epoch 길이, 몽타주가 모두 결과를 바꿉니다. 세타/베타는 비율일 뿐 그 자체로 진단이 아닙니다.</p></section>{result?.warnings.map((warning) => <section className={`warning-card ${warning.severity}`} key={warning.code}><div><AlertTriangle size={16} /><strong>{warning.title}</strong></div><p>{warning.explanation}</p>{warning.suggestion && <small>{warning.suggestion}</small>}</section>)}{result && <section className="qc-summary"><div className="section-title"><span>재현 가능성</span><small>실행 기록</small></div><dl><div><dt>실행</dt><dd>{result.run_id}</dd></div><div><dt>MNE</dt><dd>{result.provenance.mne_version}</dd></div><div><dt>MNE-Connectivity</dt><dd>{result.provenance.mne_connectivity_version}</dd></div><div><dt>Recipe 해시</dt><dd>{result.provenance.recipe_hash.slice(0, 12)}…</dd></div></dl></section>}</aside>
    </main>
    <footer className="run-strip qeeg-run-strip"><div className="run-strip-title"><Activity size={16} /><span>QEEG 파생본</span></div><div className="real-data-contract-flow"><span><small>작업 사본</small>바뀌지 않음</span><i /><span><small>필터</small>{request.highpass_hz}–{request.lowpass_hz} Hz</span><i /><span><small>ICA</small>{request.ica_enabled ? '검토함' : '끔'}</span><i /><span><small>정량화</small>PSD + 대역</span><i /><span><small>연결성</small>coh + PLV</span></div><div className="strip-actions"><button onClick={() => setStep(5)} disabled={!result}>주의 사항 검토</button></div></footer>
  </>
}

function NumberSetting({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void }) {
  return <label className="number-setting"><span>{label}</span><span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /><small>{unit}</small></span></label>
}

function BandPowerView({ bands, ratio }: { bands: QeegBandPower[]; ratio: number | null }) {
  const maximum = Math.max(...bands.map((band) => band.mean_relative_power), 0.01)
  return <div className="band-power-view"><span className="eyebrow">평균 상대 파워</span><div className="band-bars">{bands.map((band) => <div key={band.name}><span><strong>{band.name}</strong><small>{band.low_hz}–{band.high_hz} Hz</small></span><i><b style={{ width: `${(band.mean_relative_power / maximum) * 100}%` }} /></i><em>{(band.mean_relative_power * 100).toFixed(1)}%</em></div>)}</div><div className="ratio-card"><small>평균 세타 / 베타</small><strong>{ratio?.toFixed(3) ?? '없음'}</strong><p>채널마다 4–8 Hz와 13–30 Hz 상대 파워로 비를 구한 뒤 유한한 비들을 평균했습니다.</p></div></div>
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
  return <div className="ica-review-grid">{result.ica_components.map((component) => <article key={component.index} className={result.ica_excluded_components.includes(component.index) ? 'excluded' : ''}><span>IC {component.index}</span><strong>{component.explained_variance_pct.toFixed(1)}%</strong><small>봉우리 {component.peak_frequency_hz?.toFixed(1) ?? '—'} Hz</small><div>{component.topography.map((value, index) => <i key={index} style={{ height: `${18 + Math.abs(value) * 42}px`, background: value >= 0 ? '#087f83' : '#c7653c' }} />)}</div>{result.ica_excluded_components.includes(component.index) && <em>제외됨</em>}</article>)}</div>
}
