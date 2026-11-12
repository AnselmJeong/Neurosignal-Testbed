import { CircleHelp, FolderOpen, GitCompareArrows, ListChecks, Network, Play, ShieldCheck, TriangleAlert, Waves } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { LabNavigator, type LabId } from '../../components/LabNavigator'
import {
  BenchmarkApiError,
  cancelBenchmarkJob,
  createBenchmarkExperiment,
  getBenchmarkCapabilities,
  getBenchmarkExperiment,
  getBenchmarkJob,
  resumeBenchmarkExperiment,
  validateBenchmark,
} from './api'
import { ExperimentDesigner, type ValidationState } from './ExperimentDesigner'
import { JobProgress } from './JobProgress'
import { MetricCatalog } from './MetricCatalog'
import { buildRecipe, defaultDraft, draftFromRecipe, jobActive, jobSettled, sameDraft } from './model'
import { ResultsExplorer } from './ResultsExplorer'
import type { BenchmarkCapabilities, BenchmarkDraft, BenchmarkJob, ExperimentResults } from './types'
import './benchmarks.css'

const STEPS = [
  { label: '질문', description: '답할 질문을 고릅니다. 지금은 Q1만 실행됩니다.', icon: CircleHelp },
  { label: '회로', description: 'JR 노드 수, 결합 G, seed, 신호 길이를 정합니다.', icon: Network },
  { label: '관측', description: 'identity probe와 EEG forward, reference, 센서 noise를 정합니다.', icon: Waves },
  { label: '지표', description: 'PLV·wPLI·wSMI를 같은 신호에서 계산합니다.', icon: ListChecks },
  { label: '검증·비용', description: '서버가 설정을 검사하고 task 수·시간·저장량을 추정합니다.', icon: ShieldCheck },
  { label: '실행', description: '실제 완료 task 수와 단계를 보며 취소·재개합니다.', icon: Play },
  { label: '조건 비교', description: 'A–D 조건과 seed paired 효과·CI를 읽습니다.', icon: GitCompareArrows },
]

export const BENCHMARK_STORAGE_KEY = 'neurosignal-jr-benchmark-last'

interface StoredIds { displayed: string | null; active: string | null }
interface ActiveRun { experimentId: string; job: BenchmarkJob }
interface Notice { tone: 'error' | 'info'; text: string }

const STATE_PHRASES: Record<string, string> = { failed: '실패했습니다', cancelled: '취소되었습니다', interrupted: '서버 재시작으로 중단되었습니다' }

function readStored(): StoredIds {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(BENCHMARK_STORAGE_KEY) ?? 'null') as Partial<StoredIds> | null
    return { displayed: parsed?.displayed ?? null, active: parsed?.active ?? null }
  } catch {
    return { displayed: null, active: null }
  }
}

function writeStored(update: Partial<StoredIds>) {
  window.localStorage.setItem(BENCHMARK_STORAGE_KEY, JSON.stringify({ ...readStored(), ...update }))
}

const messageOf = (error: unknown) => error instanceof BenchmarkApiError ? error.message : error instanceof Error ? error.message : '알 수 없는 오류'
const hasResults = (results: ExperimentResults) => results.comparisons.some((comparison) => comparison.summary)

export function BenchmarkWorkbench({ activeLab, onLabChange, pollIntervalMs = 1500 }: {
  activeLab: LabId
  onLabChange: (lab: LabId) => void
  pollIntervalMs?: number
}) {
  const [capabilities, setCapabilities] = useState<BenchmarkCapabilities | null>(null)
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)
  const [draft, setDraft] = useState<BenchmarkDraft>(() => defaultDraft())
  const [validation, setValidation] = useState<ValidationState | null>(null)
  const [validating, setValidating] = useState(false)
  const [run, setRun] = useState<ActiveRun | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [pollError, setPollError] = useState<string | null>(null)
  const [displayed, setDisplayed] = useState<ExperimentResults | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [tab, setTab] = useState<'results' | 'catalog'>('results')
  const [loadId, setLoadId] = useState('')
  const handledJob = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const recipe = useMemo(() => buildRecipe(draft), [draft])
  const recipeKey = useMemo(() => JSON.stringify(recipe), [recipe])
  const active = jobActive(run?.job)
  const displayedDraft = useMemo(() => draftFromRecipe(displayed?.recipe), [displayed])
  const edited = displayed !== null && !sameDraft(draft, displayedDraft)

  const settleToken = (job: BenchmarkJob) => `${job.job_id}:${job.state}:${job.updated_at}`

  const openExperiment = useCallback(async (experimentId: string, role: 'displayed' | 'active') => {
    const results = await getBenchmarkExperiment(experimentId)
    if (!mounted.current) return
    if (hasResults(results)) {
      setDisplayed(results)
      writeStored({ displayed: results.experiment_id })
    }
    const job = results.job
    if (job && (role === 'active' || job.state !== 'completed')) {
      if (jobSettled(job)) handledJob.current = settleToken(job)
      setRun({ experimentId, job })
    }
  }, [])

  useEffect(() => {
    getBenchmarkCapabilities()
      .then((data) => { if (mounted.current) setCapabilities(data) })
      .catch((error: unknown) => { if (mounted.current) setCapabilitiesError(messageOf(error)) })
    const stored = readStored()
    const restore = async () => {
      if (stored.displayed) await openExperiment(stored.displayed, 'displayed').catch(() => writeStored({ displayed: null }))
      if (stored.active && stored.active !== stored.displayed) await openExperiment(stored.active, 'active').catch(() => writeStored({ active: null }))
    }
    void restore()
  }, [openExperiment])

  // Poll the real job record until it is terminal and its worker has exited.
  useEffect(() => {
    if (!run || jobSettled(run.job) || pollError) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      getBenchmarkJob(run.job.job_id)
        .then((job) => { if (!cancelled) setRun((current) => current && current.job.job_id === job.job_id ? { ...current, job } : current) })
        .catch((error: unknown) => { if (!cancelled) setPollError(messageOf(error)) })
    }, pollIntervalMs)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [run, pollError, pollIntervalMs])

  // On a settled job: load new results when completed; otherwise keep whatever is displayed.
  useEffect(() => {
    if (!run || !jobSettled(run.job)) return
    const token = settleToken(run.job)
    if (handledJob.current === token) return
    handledJob.current = token
    const { experimentId, job } = run
    if (job.state === 'completed') {
      getBenchmarkExperiment(experimentId)
        .then((results) => {
          if (!mounted.current) return
          if (hasResults(results)) {
            setDisplayed(results)
            writeStored({ displayed: experimentId, active: null })
            setNotice({ tone: 'info', text: `작업 ${job.job_id.slice(-8)} 완료 · 새 결과를 표시합니다.` })
          } else {
            setNotice({ tone: 'error', text: '작업은 끝났지만 비교 결과가 없습니다. 이전 결과를 유지합니다.' })
          }
        })
        .catch((error: unknown) => {
          if (mounted.current) setNotice({ tone: 'error', text: `결과를 불러오지 못했습니다 (${messageOf(error)}). 이전 결과를 유지합니다.` })
        })
    } else {
      const phrase = STATE_PHRASES[job.state] ?? `${job.state} 상태로 끝났습니다`
      setNotice({ tone: 'error', text: `새 실행이 ${phrase}. ${displayed ? '아래에는 이전에 완료된 결과를 그대로 표시합니다.' : ''} 완료된 artifact는 보존되며 ‘이어서 실행’으로 재개할 수 있습니다.` })
    }
  }, [run, displayed])

  async function validate() {
    const key = recipeKey
    setValidating(true)
    try {
      const report = await validateBenchmark(recipe)
      if (mounted.current) setValidation({ report, errors: [], recipeKey: key })
    } catch (error) {
      if (mounted.current) setValidation({ report: null, errors: error instanceof BenchmarkApiError ? error.messages : [messageOf(error)], recipeKey: key })
    } finally {
      if (mounted.current) setValidating(false)
    }
  }

  async function startRun() {
    if (!validation?.report?.ok || validation.recipeKey !== recipeKey || active) return
    setActionBusy(true)
    setNotice(null)
    try {
      const handle = await createBenchmarkExperiment(recipe)
      if (!mounted.current) return
      setPollError(null)
      setRun({ experimentId: handle.experiment_id, job: handle.job })
      writeStored({ active: handle.experiment_id })
    } catch (error) {
      if (mounted.current) setNotice({ tone: 'error', text: `실행을 시작하지 못했습니다: ${messageOf(error)}${displayed ? ' 이전 결과를 유지합니다.' : ''}` })
    } finally {
      if (mounted.current) setActionBusy(false)
    }
  }

  async function cancel() {
    if (!run) return
    setActionBusy(true)
    try {
      const job = await cancelBenchmarkJob(run.job.job_id)
      if (mounted.current) setRun((current) => current && current.job.job_id === job.job_id ? { ...current, job } : current)
    } catch (error) {
      if (mounted.current) setNotice({ tone: 'error', text: `취소 요청 실패: ${messageOf(error)}` })
    } finally {
      if (mounted.current) setActionBusy(false)
    }
  }

  async function resume() {
    if (!run) return
    setActionBusy(true)
    try {
      const handle = await resumeBenchmarkExperiment(run.experimentId)
      if (!mounted.current) return
      setPollError(null)
      setNotice(null)
      setRun({ experimentId: handle.experiment_id, job: handle.job })
      writeStored({ active: handle.experiment_id })
    } catch (error) {
      if (mounted.current) setNotice({ tone: 'error', text: `재개 실패: ${messageOf(error)}` })
    } finally {
      if (mounted.current) setActionBusy(false)
    }
  }

  async function loadById() {
    const id = loadId.trim()
    if (!id) return
    setActionBusy(true)
    try {
      await openExperiment(id, 'active')
      setNotice({ tone: 'info', text: `${id}를 불러왔습니다.` })
    } catch (error) {
      setNotice({ tone: 'error', text: `불러오기 실패: ${messageOf(error)}` })
    } finally {
      if (mounted.current) setActionBusy(false)
    }
  }

  const fresh = validation?.recipeKey === recipeKey && validation.report?.ok === true
  const step = displayed && !active ? 6 : run ? 5 : fresh ? 4 : 0

  return (
    <main className="workspace jrb-workspace">
      <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={STEPS} step={step} />

      <aside className="control-panel jrb-controls">
        <div className="panel-heading">
          <span className="eyebrow">JR Benchmark · 실험 설계</span>
          <h1>결합과 관측을<br />나눠서 본다</h1>
          <p>JR 네트워크로 네 조건을 생성하고, 같은 신호에서 PLV·wPLI·wSMI의 seed paired 효과를 비교합니다.</p>
        </div>
        {capabilitiesError && <p className="jrb-error" role="alert">지표·질문 정보를 불러오지 못했습니다: {capabilitiesError}</p>}
        <fieldset disabled={active} className="jrb-fieldset">
          <legend className="sr-only">실험 설정</legend>
          <ExperimentDesigner capabilities={capabilities} draft={draft} onChange={setDraft} validation={validation} currentKey={recipeKey}
            validating={validating} running={active || actionBusy} onValidate={() => void validate()} onRun={() => void startRun()} />
        </fieldset>
        {active && <p className="jrb-help">작업이 진행되는 동안 설정은 잠깁니다. 취소하거나 끝난 뒤 다시 편집하세요.</p>}
      </aside>

      <section className="canvas-panel jrb-canvas">
        <div className="canvas-toolbar">
          <div>
            <span className="eyebrow">{tab === 'results' ? '표시 중인 결과' : '보조 탭'}</span>
            <h2>{tab === 'results' ? (displayed ? `${displayed.preset} · ${displayed.profile} · seed ${displayed.seeds.length}개` : '아직 결과 없음') : '지표 카탈로그'}</h2>
          </div>
          <div className="view-tabs" role="tablist" aria-label="JR Benchmark 보기">
            <button type="button" role="tab" aria-selected={tab === 'results'} className={tab === 'results' ? 'active' : ''} onClick={() => setTab('results')}>결과</button>
            <button type="button" role="tab" aria-selected={tab === 'catalog'} className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>지표 카탈로그</button>
          </div>
          <div className="canvas-status">
            <span>{displayed ? displayed.experiment_id : 'NO RESULT'}</span>
            {edited && <em data-testid="edited-badge">편집 중 설정은 표시 결과와 다름</em>}
          </div>
        </div>

        <div className="jrb-stage">
          {notice && <p className={notice.tone === 'error' ? 'jrb-banner error' : 'jrb-banner'} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'error' && <TriangleAlert size={14} />} {notice.text}</p>}
          {tab === 'catalog' && (capabilities
            ? <MetricCatalog capabilities={capabilities} inRun={draft.metrics} />
            : <p className="jrb-note">지표 카탈로그를 불러오는 중입니다.</p>)}
          {tab === 'results' && (displayed ? (
            <>
              <p className="jrb-scope">
                첫 구현 단위 결과입니다: Q1 · 4조건 · {displayed.recipe?.benchmark?.metrics?.map((m) => m.id).join('·')}.
                29개 지표 전체 분석이 아니며{displayed.profile === 'preview' ? ', preview profile은 연구 비교 완료가 아닙니다' : ''}.
                {active && run?.experimentId !== displayed.experiment_id && ' 새 작업이 진행 중이며, 끝나기 전까지 이 결과를 유지합니다.'}
              </p>
              <ResultsExplorer key={displayed.experiment_id + (displayed.job?.job_id ?? '')} results={displayed} capabilities={capabilities} />
            </>
          ) : (
            <div className="empty-stage">
              <span className="eyebrow">결과 없음</span>
              <h3>설정을 검증한 뒤 실행하세요.</h3>
              <p>질문 → 회로 → 관측 → 지표 순서로 설정하고, 예상 비용을 확인한 다음 ‘생성·분석 실행’을 누르세요. 결과는 저장되어 다시 열 때 복원됩니다.</p>
            </div>
          ))}
        </div>
      </section>

      <aside className="inspector-panel jrb-inspector">
        <section className="inspector-lead">
          <span className="eyebrow">실행 상태</span>
          <h2>{run ? (active ? '작업 진행 중' : '마지막 작업') : '실행한 작업 없음'}</h2>
        </section>
        {run && <JobProgress job={run.job} busy={actionBusy} pollError={pollError} onCancel={() => void cancel()} onResume={() => void resume()} onRefresh={() => setPollError(null)} />}

        {displayed && (
          <section className="jrb-provenance" aria-label="표시 중인 결과 정보">
            <span className="eyebrow">생성 정보</span>
            <dl>
              <div><dt>실험</dt><dd><code>{displayed.experiment_id}</code></dd></div>
              <div><dt>seed</dt><dd>{displayed.seeds.join(', ')}</dd></div>
              <div><dt>결합 수준</dt><dd>G = {displayed.coupling_levels.join(' / ')}</dd></div>
              <div><dt>노드</dt><dd>{displayed.recipe?.simulation?.n_nodes ?? '—'}개 · {displayed.recipe?.simulation?.duration_s ?? '—'}초</dd></div>
              <div><dt>작업</dt><dd>{displayed.job?.state ?? '—'} · {displayed.job?.tasks.total ?? '—'} task</dd></div>
            </dl>
            {displayedDraft && edited && <button type="button" className="quiet-button jrb-secondary" disabled={active} onClick={() => setDraft(displayedDraft)}>이 결과의 설정을 편집기로 불러오기</button>}
            {displayed.warnings.length > 0 && (
              <details className="jrb-warnings"><summary>실행 경고 {displayed.warnings.length}개</summary><ul>{displayed.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>
            )}
          </section>
        )}

        <section className="jrb-load" aria-label="저장된 실험 불러오기">
          <span className="eyebrow">저장된 실험</span>
          <label className="jrb-field">실험 ID<input value={loadId} placeholder="jr-…" onChange={(event) => setLoadId(event.target.value)} /></label>
          <button type="button" className="quiet-button jrb-secondary" onClick={() => void loadById()} disabled={!loadId.trim() || actionBusy || active}><FolderOpen size={14} /> 불러오기</button>
        </section>

        <div className="nonclinical"><TriangleAlert size={15} /><span>교육·연구용 시뮬레이션입니다.<br />임상 진단에 쓰지 마세요.</span></div>
      </aside>
    </main>
  )
}
