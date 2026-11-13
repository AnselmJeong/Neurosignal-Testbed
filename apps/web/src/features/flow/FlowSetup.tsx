import { CircleStop, Play, ShieldCheck, TriangleAlert } from 'lucide-react'

import { BASE_RECIPE, formatSeconds, stageProgress, type FlowDraft, type ReferenceChoice } from './model'
import { SourceGraph } from './Visuals'
import type { FlowCost, FlowJob, FlowJobState, FlowRecipe, FlowValidationReport } from './types'

export interface FlowValidationState {
  report: FlowValidationReport | null
  errors: string[]
  recipeKey: string
}

const MOTIFS: { name: string; text: string }[] = [
  { name: 'pair', text: 'P1 → P2 · 단방향 쌍' },
  { name: 'chain', text: 'A → B → C · 사슬 (A와 C 사이는 간접 경로)' },
  { name: 'fork', text: 'C → D, C → E · 공통 구동 (D와 E 사이에는 간선 없음)' },
  { name: 'convergence', text: 'P1 → F ← A · 수렴 (PID 대상)' },
]

const REFERENCE_OPTIONS: { value: ReferenceChoice; label: string }[] = [
  { value: 'none', label: '없음' },
  { value: 'average', label: '평균' },
  { value: 'both', label: '둘 다' },
]

export function FlowSetup({ draft, onChange, validation, currentKey, validating, running, onValidate, onRun }: {
  draft: FlowDraft
  onChange: (draft: FlowDraft) => void
  validation: FlowValidationState | null
  currentKey: string
  validating: boolean
  running: boolean
  onValidate: () => void
  onRun: () => void
}) {
  const set = <K extends keyof FlowDraft>(key: K, value: FlowDraft[K]) => onChange({ ...draft, [key]: value })
  const stale = validation !== null && validation.recipeKey !== currentKey
  const fresh = validation !== null && !stale && validation.report?.ok === true
  return (
    <div className="flw-setup">
      <section className="flw-control" aria-label="정답 소스 그래프">
        <div className="section-title"><span>정답 그래프</span><small>KNOWN · 8 JR NODES</small></div>
        <SourceGraph nodes={BASE_RECIPE.graph.nodes.map((node) => node.id)} edges={BASE_RECIPE.graph.edges} ariaLabel="시뮬레이션 정답 소스 그래프" />
        <ul className="flw-motifs">{MOTIFS.map((motif) => <li key={motif.name}><b>{motif.name}</b> {motif.text}</li>)}</ul>
        <p className="flw-help">정답 C[target, source]는 시뮬레이션과, 결과가 고정된 뒤의 소스 공간 평가에만 쓰입니다. 분석 함수는 정답을 받지 않습니다.</p>
      </section>

      <section className="flw-control" aria-label="결합">
        <div className="section-title"><span>결합</span><small>G ON · G=0 CONTROL</small></div>
        <label className="flw-field">결합 켬 조건의 G <output>{draft.G}</output>
          <input type="range" aria-label="결합 G" min={2} max={20} step={1} value={draft.G} onChange={(event) => set('G', Number(event.target.value))} />
        </label>
        <p className="flw-help">결합 끔(G=0) 대조 조건은 같은 seed로 항상 함께 생성됩니다. 같은 도로망(SC)이어도 G=0이면 신호가 흐르지 않습니다.</p>
        <div className="flw-field-pair">
          <label className="flw-field">신호 길이
            <select aria-label="신호 길이" value={draft.durationS} onChange={(event) => set('durationS', Number(event.target.value))}>
              {[20, 30, 60].map((value) => <option key={value} value={value}>{value} s</option>)}
            </select>
          </label>
          <label className="flw-field">seed
            <input type="number" aria-label="seed" min={0} value={draft.seed} onChange={(event) => set('seed', Math.max(0, Math.round(Number(event.target.value) || 0)))} />
          </label>
        </div>
      </section>

      <section className="flw-control" aria-label="관측">
        <div className="section-title"><span>관측</span><small>SOURCE · EEG FORWARD</small></div>
        <label className="flw-check"><input type="checkbox" checked={draft.includeSource} onChange={(event) => set('includeSource', event.target.checked)} /> 소스 신호 그대로 분석 (정답 비교 가능)</label>
        <label className="flw-field">EEG 센서 수
          <select aria-label="EEG 센서 수" value={draft.nSensors} onChange={(event) => set('nSensors', Number(event.target.value))}>
            {[16, 32].map((value) => <option key={value} value={value}>{value}채널 (sphere forward)</option>)}
          </select>
        </label>
        <span className="flw-field-label">EEG reference</span>
        <div className="flw-segmented" role="group" aria-label="EEG reference">
          {REFERENCE_OPTIONS.map((option) => <button key={option.value} type="button" aria-pressed={draft.reference === option.value} className={draft.reference === option.value ? 'active' : ''} onClick={() => set('reference', option.value)}>{option.label}</button>)}
        </div>
        <span className="flw-field-label">0.5 Hz high-pass 위상</span>
        <div className="flw-segmented" role="group" aria-label="high-pass 위상">
          <button type="button" aria-pressed={draft.highpassPhase === 'causal'} className={draft.highpassPhase === 'causal' ? 'active' : ''} onClick={() => set('highpassPhase', 'causal')}>causal (기본)</button>
          <button type="button" aria-pressed={draft.highpassPhase === 'zero_phase'} className={draft.highpassPhase === 'zero_phase' ? 'active' : ''} onClick={() => set('highpassPhase', 'zero_phase')}>zero-phase</button>
        </div>
        <p className="flw-help">zero-phase(양방향) 필터는 미래 표본을 섞어 GC의 시간 순서를 흐립니다. 미리보기에서 G=0 조건부 GC 거짓 양성이 3/56 → 35/56으로 늘었습니다.</p>
      </section>

      <section className="flw-control" aria-label="검증과 실행">
        <button type="button" className="quiet-button flw-secondary" onClick={onValidate} disabled={validating || running}><ShieldCheck size={14} /> {validating ? '검증 중…' : '설정 검증'}</button>
        {validation && (
          <div className={stale ? 'flw-validation stale' : 'flw-validation'} aria-live="polite">
            {stale && <p className="flw-help">설정이 바뀌었습니다. 다시 검증하세요.</p>}
            {validation.report?.ok && <p className="flw-ok">검증 통과</p>}
            {[...validation.errors, ...(validation.report?.errors ?? [])].length > 0 && (
              <ul className="flw-error-list" role="alert">{[...validation.errors, ...(validation.report?.errors ?? [])].map((error) => <li key={error}>{error}</li>)}</ul>
            )}
            {(validation.report?.warnings ?? []).map((warning) => <p key={warning} className="flw-warn"><TriangleAlert size={12} /> {warning}</p>)}
            {validation.report && <CostSummary cost={validation.report.cost} />}
          </div>
        )}
        <button type="button" className="primary-button flw-run" onClick={onRun} disabled={!fresh || running}><Play size={15} fill="currentColor" /> 생성·분석 실행</button>
      </section>
    </div>
  )
}

export function CostSummary({ cost }: { cost: FlowCost }) {
  return (
    <dl className="flw-cost" aria-label="예상 비용">
      <div><dt>예상 시간</dt><dd>{formatSeconds(cost.estimated_wall_s)}</dd></div>
      <div><dt>데이터셋</dt><dd>{cost.n_datasets}개 ({cost.dataset_channels.join('·')}ch × 2조건)</dd></div>
      <div><dt>분석 표본</dt><dd>{cost.analysed_samples_per_dataset} @ {cost.analysis_sfreq} Hz</dd></div>
      <div><dt>시뮬레이션</dt><dd>{cost.simulated_seconds} s</dd></div>
    </dl>
  )
}

const STATE_LABELS: Record<string, string> = {
  queued: '대기 중', running: '실행 중', completed: '완료', failed: '실패', cancelled: '취소됨', interrupted: '중단됨 (서버 재시작)', unknown: '알 수 없음',
}

export interface ActiveFlowRun {
  runId: string
  state: FlowJobState | 'unknown'
  stage: string | null
  job: FlowJob | null
  recipe: FlowRecipe | null
  cost: FlowCost | null
}

export function FlowRunProgress({ run, busy, pollError, onCancel, onRefresh }: {
  run: ActiveFlowRun
  busy: boolean
  pollError: string | null
  onCancel: () => void
  onRefresh: () => void
}) {
  const progress = stageProgress(run.stage, run.state, run.recipe)
  const active = run.state === 'queued' || run.state === 'running'
  const started = run.job ? Date.parse(run.job.created_at) : Number.NaN
  const updated = run.job ? Date.parse(active ? new Date().toISOString() : run.job.updated_at) : Number.NaN
  const elapsed = Number.isFinite(started) && Number.isFinite(updated) ? Math.max(0, (updated - started) / 1000) : null
  return (
    <section className={`flw-job ${run.state}`} aria-label="정보 흐름 실행 진행" aria-live="polite">
      <div className="flw-job-head"><span className="eyebrow">실행 {run.runId}</span><strong data-testid="flow-job-state">{STATE_LABELS[run.state] ?? run.state}</strong></div>
      <p className="flw-job-stage">현재 단계 · <b data-testid="flow-job-stage">{progress.label}</b></p>
      <div className="progress-track" role="progressbar" aria-label="파이프라인 진행" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.fraction * 100)}>
        <i style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
      </div>
      <p className="flw-muted">진행률은 서버가 보고한 실제 단계에서 계산합니다. 경과 {elapsed === null ? '—' : formatSeconds(elapsed)}{run.cost ? ` · 예상 ${formatSeconds(run.cost.estimated_wall_s)}` : ''}</p>
      {run.job?.cancel_requested && active && <p className="flw-note">취소 요청됨 · 현재 단계가 끝나면 멈춥니다.</p>}
      {run.job?.worker && <p className="flw-muted">worker pid {run.job.worker.pid ?? '—'} · {run.job.worker.alive ? '실행 중' : `종료 (exit ${run.job.worker.exitcode ?? '—'})`}</p>}
      {(run.job?.failures ?? []).length > 0 && (
        <ul className="flw-error-list">{run.job!.failures.map((failure) => <li key={failure.task_id}><code>{failure.reason_code ?? '이유 코드 없음'}</code>{failure.message ? ` — ${failure.message}` : ''}</li>)}</ul>
      )}
      {pollError && <p className="flw-error" role="alert">상태 확인 실패: {pollError}</p>}
      <div className="flw-job-actions">
        {active && <button type="button" onClick={onCancel} disabled={busy || run.job?.cancel_requested === true}><CircleStop size={14} /> 취소</button>}
        {pollError && <button type="button" onClick={onRefresh} disabled={busy}>상태 다시 확인</button>}
      </div>
    </section>
  )
}
