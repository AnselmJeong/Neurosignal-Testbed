import { CheckCircle2, Play, ShieldCheck, SlidersHorizontal, TriangleAlert } from 'lucide-react'

import { PROFILE_DEFAULTS, formatBytes, formatDuration } from './model'
import type { BenchmarkCapabilities, BenchmarkDraft, ValidationReport } from './types'

// Korean copy for the plan §1.3 questions; the server's preset list decides which are runnable.
export const QUESTION_COPY: Record<string, string> = {
  Q1: '실제 결합을 바꾸면 무엇이 달라지는가?',
  Q2: '결합 없이 혼합·reference만 바꿔도 연결이 생기는가?',
  Q3: '진동 세기·주파수·배경 변화와 결합을 구별하는가?',
  Q4: '시간 패턴의 다양성과 집단 간 의존성은 함께 변하는가?',
  Q5: '기록 길이·구간·seed가 바뀌어도 결과를 믿을 수 있는가?',
  Q6: 'artifact 제거가 오염을 줄이며 신경 신호도 보존하는가?',
  Q7: '방향성·PAC가 알려진 대조에서 구별되는가?',
}

const QUESTION_IDS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7']

export interface ValidationState {
  report: ValidationReport | null
  /** Messages from a 422 schema rejection (no report). */
  errors: string[]
  /** JSON of the recipe that was validated; a different draft makes the result stale. */
  recipeKey: string
}

export function ExperimentDesigner({ capabilities, draft, onChange, validation, currentKey, validating, running, onValidate, onRun }: {
  capabilities: BenchmarkCapabilities | null
  draft: BenchmarkDraft
  onChange: (draft: BenchmarkDraft) => void
  validation: ValidationState | null
  currentKey: string
  validating: boolean
  running: boolean
  onValidate: () => void
  onRun: () => void
}) {
  const presets = new Map((capabilities?.presets ?? []).map((preset) => [preset.id, preset]))
  const q1 = presets.get('Q1')
  const fresh = validation !== null && validation.recipeKey === currentKey
  const canRun = fresh && validation.report?.ok === true && !running && !validating
  const runnableMetrics = (capabilities?.metric_ids ?? [])
    .map((id) => capabilities?.metrics[id])
    .filter((metric) => metric?.status === 'implemented')
  const primary = q1?.primary_metrics ?? ['M14', 'M17', 'M23']

  const set = <K extends keyof BenchmarkDraft>(key: K, value: BenchmarkDraft[K]) => onChange({ ...draft, [key]: value })
  const num = (key: keyof BenchmarkDraft, min?: number) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = Number(event.target.value)
    if (Number.isFinite(value) && (min === undefined || value >= min)) set(key, value as never)
  }
  const toggleMetric = (id: string) => set('metrics', draft.metrics.includes(id) ? draft.metrics.filter((item) => item !== id) : [...draft.metrics, id])
  const applyProfile = (profile: BenchmarkDraft['profile']) => onChange({ ...draft, profile, ...PROFILE_DEFAULTS[profile] })

  return (
    <div className="jrb-designer">
      <section className="control-section" aria-labelledby="jrb-q-title">
        <div className="section-title"><span id="jrb-q-title">1 · 질문</span><small>PRESET</small></div>
        <div className="jrb-questions" role="radiogroup" aria-label="분석 질문">
          {QUESTION_IDS.map((id) => {
            const preset = presets.get(id)
            const implemented = preset?.status === 'implemented'
            return (
              <label key={id} className={`jrb-question ${implemented ? '' : 'planned'} ${draft.preset === id ? 'selected' : ''}`}>
                <input type="radio" name="jrb-question" value={id} checked={draft.preset === id} disabled={!implemented} onChange={() => set('preset', id)} />
                <span><b>{id}</b> {QUESTION_COPY[id]}</span>
                <small className={`jrb-status ${implemented ? 'implemented' : 'planned'}`}>{implemented ? '실행 가능' : '계획됨'}</small>
              </label>
            )
          })}
        </div>
        {q1?.notes?.[0] && <p className="jrb-help">{q1.notes[0]}</p>}
      </section>

      <section className="control-section" aria-labelledby="jrb-circuit-title">
        <div className="section-title"><span id="jrb-circuit-title">2 · 회로</span><small>JANSEN–RIT</small></div>
        <div className="segmented-field">
          <span className="control-label">실행 profile</span>
          <div role="group" aria-label="실행 profile">
            <button type="button" className={draft.profile === 'preview' ? 'selected' : ''} aria-pressed={draft.profile === 'preview'} onClick={() => applyProfile('preview')}>preview</button>
            <button type="button" className={draft.profile === 'core-comparison' ? 'selected' : ''} aria-pressed={draft.profile === 'core-comparison'} onClick={() => applyProfile('core-comparison')}>core-comparison</button>
          </div>
        </div>
        <p className="jrb-help">{draft.profile === 'preview'
          ? 'preview: 짧은 신호·적은 seed로 흐름과 대략적 PSD를 확인합니다. 연구 비교 완료가 아닙니다.'
          : 'core-comparison: 4조건 × source/sensor의 PLV·wPLI·wSMI 비교입니다. 30 seed·120초 기본값은 시간이 오래 걸립니다.'}</p>
        <label className="jrb-field">노드 수
          <select value={draft.nNodes} onChange={num('nNodes', 2)}>{[4, 8, 16, 32].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <label className="jrb-field">결합 켬 G<input type="number" min={0.1} step={0.5} value={draft.gOn} onChange={num('gOn', 0)} /></label>
        <p className="jrb-help">결합은 G = 0(끔)과 G = {draft.gOn}(켬) 두 수준입니다. 연결 구조 C는 ring lattice(k = 2, 행 정규화), 지연 D = 8 ms입니다.</p>
        <div className="jrb-field-pair">
          <label className="jrb-field">첫 seed<input type="number" step={1} value={draft.seedStart} onChange={num('seedStart', 0)} /></label>
          <label className="jrb-field">seed 수<input type="number" min={1} step={1} value={draft.seedCount} onChange={num('seedCount', 1)} /></label>
        </div>
        <label className="jrb-field">신호 길이 (초)<input type="number" min={1} step={10} value={draft.durationS} onChange={num('durationS', 1)} /></label>
        {q1?.required_length && <p className="jrb-help">Q1 최소 {q1.required_length.min_duration_s ?? 40}초, 권장 {q1.required_length.recommended_duration_s ?? 120}초 · CI에는 seed {q1.required_length.min_seeds_for_ci ?? 2}개 이상이 필요합니다.</p>}
      </section>

      <section className="control-section" aria-labelledby="jrb-obs-title">
        <div className="section-title"><span id="jrb-obs-title">3 · 관측</span><small>2 × 2</small></div>
        <table className="jrb-design-table" aria-label="네 가지 핵심 조건">
          <thead><tr><th /><th>G = 0</th><th>G = {draft.gOn}</th></tr></thead>
          <tbody>
            <tr><th>identity probe</th><td>A</td><td>B</td></tr>
            <tr><th>EEG forward</th><td>C</td><td>D</td></tr>
          </tbody>
        </table>
        <p className="jrb-help">identity probe는 노드마다 probe 하나(혼합 없음), EEG forward는 sphere 모델로 {draft.eegSensors}전극에 섞입니다. source 원신호는 항상 함께 분석합니다.</p>
        <label className="jrb-field">EEG 전극 수
          <select value={draft.eegSensors} onChange={num('eegSensors', 1)}>{[16, 32].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <div className="segmented-field">
          <span className="control-label">Reference</span>
          <div role="group" aria-label="Reference">
            <button type="button" className={draft.reference === 'none' ? 'selected' : ''} aria-pressed={draft.reference === 'none'} onClick={() => set('reference', 'none')}>none</button>
            <button type="button" className={draft.reference === 'average' ? 'selected' : ''} aria-pressed={draft.reference === 'average'} onClick={() => set('reference', 'average')}>average</button>
          </div>
        </div>
        <label className="jrb-field">센서 noise (µV, 표준편차)<input type="number" min={0} step={0.5} value={draft.sensorNoiseUv} onChange={num('sensorNoiseUv', 0)} /></label>
        {draft.sensorNoiseUv > 0 && <p className="jrb-warn-inline"><TriangleAlert size={13} /> 관측 gain은 아직 보정되지 않은 값(1e-8 A·m/mV)입니다. noise를 더하기 전에 gain을 보정해야 SNR을 해석할 수 있습니다.</p>}
      </section>

      <section className="control-section" aria-labelledby="jrb-metric-title">
        <div className="section-title"><span id="jrb-metric-title">4 · 지표</span><small>Q1 PRIMARY</small></div>
        <div className="jrb-metric-checks" role="group" aria-label="실행할 지표">
          {runnableMetrics.map((metric) => metric && (
            <label key={metric.id} className={primary.includes(metric.id) ? 'primary' : ''}>
              <input type="checkbox" checked={draft.metrics.includes(metric.id)} disabled={!metric.dependency_available} onChange={() => toggleMetric(metric.id)} />
              <span>{metric.id} · {metric.name}</span>
              {primary.includes(metric.id) && <small>주요</small>}
            </label>
          ))}
          {!capabilities && <p className="jrb-help">지표 목록을 불러오는 중입니다.</p>}
        </div>
        <p className="jrb-help">같은 생성 신호에서 지표만 바꾸면 신호 artifact를 재사용합니다. 계획 단계 지표는 ‘지표 카탈로그’ 탭에서 확인하세요.</p>
        <details className="jrb-advanced">
          <summary><SlidersHorizontal size={13} /> 고급 설정</summary>
          <label className="jrb-field">epoch 길이 (초)<input type="number" min={1} step={1} value={draft.epochS} onChange={num('epochS', 1)} /></label>
          <label className="jrb-field">burn-in (초)<input type="number" min={0} step={1} value={draft.burnInS} onChange={num('burnInS', 0)} /></label>
          <label className="jrb-field">bootstrap 반복<input type="number" min={19} step={100} value={draft.nBootstrap} onChange={num('nBootstrap', 1)} /></label>
          <label className="jrb-field">surrogate 반복<input type="number" min={1} step={10} value={draft.nSurrogates} onChange={num('nSurrogates', 1)} /></label>
          <p className="jrb-help">독립 반복 단위는 simulation seed입니다. epoch는 반복 수로 세지 않습니다.</p>
        </details>
      </section>

      <section className="control-section" aria-labelledby="jrb-validate-title">
        <div className="section-title"><span id="jrb-validate-title">5 · 검증과 예상 비용</span></div>
        <button type="button" className="quiet-button jrb-secondary jrb-wide" onClick={onValidate} disabled={validating || running || draft.metrics.length === 0}>
          <ShieldCheck size={14} /> {validating ? '검증 중…' : '설정 검증'}
        </button>
        {draft.metrics.length === 0 && <p className="jrb-error">지표를 하나 이상 선택하세요.</p>}
        {validation && <ValidationSummary validation={validation} stale={!fresh} />}
        <button type="button" className="primary-button jrb-wide" onClick={onRun} disabled={!canRun}>
          <Play size={14} fill="currentColor" /> {running ? '작업 진행 중' : '생성·분석 실행'}
        </button>
        {!fresh && !running && <p className="jrb-help">실행하려면 현재 설정을 먼저 검증하세요.</p>}
      </section>
    </div>
  )
}

function ValidationSummary({ validation, stale }: { validation: ValidationState; stale: boolean }) {
  const { report, errors } = validation
  const allErrors = [...errors, ...(report?.errors ?? [])]
  return (
    <div className={`jrb-validation ${stale ? 'stale' : ''}`} aria-label="검증 결과">
      {stale && <p className="jrb-note">설정이 바뀌어 아래 검증 결과는 이전 설정 기준입니다.</p>}
      {report?.ok && allErrors.length === 0
        ? <p className="jrb-ok"><CheckCircle2 size={14} /> 검증 통과 · {report.experiment_id}</p>
        : <ul className="jrb-error-list" role="alert">{allErrors.map((message) => <li key={message}>{message}</li>)}</ul>}
      {report?.cost && (
        <dl className="jrb-cost" aria-label="예상 비용">
          <div><dt>전체 task</dt><dd>{report.cost.n_tasks}</dd></div>
          <div><dt>JR 적분</dt><dd>{report.cost.n_simulations}회 · {Math.round(report.cost.simulated_seconds)}초 신호</dd></div>
          <div><dt>관측 기록</dt><dd>{report.cost.n_observations}</dd></div>
          <div><dt>지표 task</dt><dd>{report.cost.n_metric_tasks}</dd></div>
          <div><dt>예상 시간</dt><dd>{formatDuration(report.cost.estimated_runtime_s)}</dd></div>
          <div><dt>예상 저장량</dt><dd>{formatBytes(report.cost.estimated_bytes)}</dd></div>
        </dl>
      )}
      {report?.cost && <p className="jrb-muted">{report.cost.basis}</p>}
      {(report?.warnings.length ?? 0) > 0 && (
        <details className="jrb-warnings"><summary>경고 {report?.warnings.length}개</summary>
          <ul>{report?.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </details>
      )}
    </div>
  )
}
