import { BookOpen, FolderOpen, GitCompareArrows, LayoutList, Network, Play, TriangleAlert, Waves } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { LabNavigator, type LabId } from '../../components/LabNavigator'
import { cancelFlowRun, createFlowRun, FlowApiError, getFlowConcepts, getFlowRun, listFlowRuns, validateFlow } from './api'
import { ConceptPrimer } from './ConceptPrimer'
import { FlowRunProgress, FlowSetup, type ActiveFlowRun, type FlowValidationState } from './FlowSetup'
import { MethodCards } from './MethodCards'
import {
  buildFlowRecipe,
  CONDITION_LABELS,
  defaultFlowDraft,
  draftFromRecipe,
  findDataset,
  formatSeconds,
  isTerminal,
  sameDraft,
  SPACE_LABELS,
  spacesOf,
  type FlowDraft,
} from './model'
import { SensorSourceComparison } from './SensorSourceComparison'
import type { ConceptCatalog, FlowResult, FlowRunStatus, FlowRunSummary } from './types'
import './flow.css'

const STEPS = [
  { label: '개념', description: 'SC·FC·유효 연결·정보 흐름과 Level 1–3을 구분합니다.', icon: BookOpen },
  { label: '정답 그래프', description: 'pair·chain·fork·수렴 모티프의 방향을 미리 압니다.', icon: Network },
  { label: '관측', description: '소스 그대로와 EEG forward, reference를 정합니다.', icon: Waves },
  { label: '검증·실행', description: '서버가 설정·비용을 검사하고 실제 단계를 보여줍니다.', icon: Play },
  { label: '방법 카드', description: 'GC·TE·DCM식 모델·activity flow·PID를 한 장씩 읽습니다.', icon: LayoutList },
  { label: '센서 vs 소스', description: 'G=0에서 센서에 나타나는 허위 방향을 확인합니다.', icon: GitCompareArrows },
]

export const FLOW_STORAGE_KEY = 'neurosignal-flow-last'

type Tab = 'concepts' | 'methods' | 'compare'
interface StoredIds { displayed: string | null; active: string | null }
interface Notice { tone: 'error' | 'info'; text: string }

const STATE_PHRASES: Record<string, string> = { failed: '실패했습니다', cancelled: '취소되었습니다', interrupted: '서버 재시작으로 중단되었습니다', unknown: '알 수 없는 상태로 끝났습니다' }

function readStored(): StoredIds {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FLOW_STORAGE_KEY) ?? 'null') as Partial<StoredIds> | null
    return { displayed: parsed?.displayed ?? null, active: parsed?.active ?? null }
  } catch {
    return { displayed: null, active: null }
  }
}

function writeStored(update: Partial<StoredIds>) {
  window.localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify({ ...readStored(), ...update }))
}

const messageOf = (error: unknown) => error instanceof FlowApiError ? error.message : error instanceof Error ? error.message : '알 수 없는 오류'

const runFromStatus = (status: FlowRunStatus, previous?: ActiveFlowRun | null): ActiveFlowRun => ({
  runId: status.run_id,
  state: status.state,
  stage: status.stage,
  job: status.job,
  recipe: status.recipe ?? previous?.recipe ?? null,
  cost: status.meta?.cost ?? previous?.cost ?? null,
})

/** Terminal state and the worker has exited (or this server never owned it). */
const runSettled = (run: ActiveFlowRun) => (run.state === 'unknown' || isTerminal(run.state)) && (!run.job?.worker || !run.job.worker.alive)
const runActive = (run: ActiveFlowRun | null) => !!run && (run.state === 'queued' || run.state === 'running')

export function FlowWorkbench({ activeLab, onLabChange, pollIntervalMs = 1500 }: {
  activeLab: LabId
  onLabChange: (lab: LabId) => void
  pollIntervalMs?: number
}) {
  const [catalog, setCatalog] = useState<ConceptCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [draft, setDraft] = useState<FlowDraft>(() => defaultFlowDraft())
  const [validation, setValidation] = useState<FlowValidationState | null>(null)
  const [validating, setValidating] = useState(false)
  const [run, setRun] = useState<ActiveFlowRun | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [pollError, setPollError] = useState<string | null>(null)
  const [displayed, setDisplayed] = useState<FlowResult | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [tab, setTab] = useState<Tab>('concepts')
  const [space, setSpace] = useState('source')
  const [condition, setCondition] = useState<'coupled' | 'control'>('coupled')
  const [history, setHistory] = useState<FlowRunSummary[]>([])
  const handled = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const recipe = useMemo(() => buildFlowRecipe(draft), [draft])
  const recipeKey = useMemo(() => JSON.stringify(recipe), [recipe])
  const active = runActive(run)
  const displayedDraft = useMemo(() => draftFromRecipe(displayed?.recipe), [displayed])
  const edited = displayed !== null && !sameDraft(draft, displayedDraft)

  const refreshHistory = useCallback(() => {
    listFlowRuns().then((data) => { if (mounted.current) setHistory(data.runs) }).catch(() => undefined)
  }, [])

  const showResult = useCallback((result: FlowResult) => {
    setDisplayed(result)
    const spaces = spacesOf(result)
    setSpace((current) => spaces.includes(current) ? current : spaces[0] ?? 'source')
    writeStored({ displayed: result.run_id })
  }, [])

  const openRun = useCallback(async (runId: string, role: 'displayed' | 'active') => {
    const status = await getFlowRun(runId, true)
    if (!mounted.current) return
    if (status.result) showResult(status.result)
    if (role === 'active' || status.state !== 'completed') {
      const next = runFromStatus(status)
      if (runSettled(next)) handled.current = `${next.runId}:${next.state}`
      setRun(next)
    }
  }, [showResult])

  useEffect(() => {
    getFlowConcepts()
      .then((data) => { if (mounted.current) setCatalog(data) })
      .catch((error: unknown) => { if (mounted.current) setCatalogError(messageOf(error)) })
    refreshHistory()
    const stored = readStored()
    const restore = async () => {
      if (stored.displayed) await openRun(stored.displayed, 'displayed').catch(() => writeStored({ displayed: null }))
      if (stored.active && stored.active !== stored.displayed) await openRun(stored.active, 'active').catch(() => writeStored({ active: null }))
    }
    void restore()
  }, [openRun, refreshHistory])

  // Poll the real run record (without the 0.5 MB result) until it is terminal and the worker exited.
  useEffect(() => {
    if (!run || runSettled(run) || pollError) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      getFlowRun(run.runId, false)
        .then((status) => { if (!cancelled) setRun((current) => current && current.runId === status.run_id ? runFromStatus(status, current) : current) })
        .catch((error: unknown) => { if (!cancelled) setPollError(messageOf(error)) })
    }, pollIntervalMs)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [run, pollError, pollIntervalMs])

  // Once settled: load the result when completed; otherwise keep whatever is displayed.
  useEffect(() => {
    if (!run || !runSettled(run)) return
    const token = `${run.runId}:${run.state}`
    if (handled.current === token) return
    handled.current = token
    refreshHistory()
    if (run.state === 'completed') {
      getFlowRun(run.runId, true)
        .then((status) => {
          if (!mounted.current) return
          if (status.result) {
            showResult(status.result)
            writeStored({ active: null })
            setNotice({ tone: 'info', text: `실행 ${run.runId} 완료 · 새 결과를 표시합니다.` })
          } else {
            setNotice({ tone: 'error', text: '실행은 끝났지만 결과 파일이 없습니다. 이전 결과를 유지합니다.' })
          }
        })
        .catch((error: unknown) => {
          if (mounted.current) setNotice({ tone: 'error', text: `결과를 불러오지 못했습니다 (${messageOf(error)}). 이전 결과를 유지합니다.` })
        })
    } else {
      const reason = run.job?.failures[0]
      setNotice({
        tone: 'error',
        text: `새 실행이 ${STATE_PHRASES[run.state] ?? `${run.state} 상태로 끝났습니다`}${reason?.reason_code ? ` (${reason.reason_code})` : ''}. ${displayed ? '아래에는 이전에 완료된 결과를 그대로 표시합니다.' : '표시할 이전 결과가 없습니다.'}`,
      })
      writeStored({ active: null })
    }
  }, [run, displayed, showResult, refreshHistory])

  async function validate() {
    const key = recipeKey
    setValidating(true)
    try {
      const report = await validateFlow(recipe)
      if (mounted.current) setValidation({ report, errors: [], recipeKey: key })
    } catch (error) {
      if (mounted.current) setValidation({ report: null, errors: error instanceof FlowApiError ? error.messages : [messageOf(error)], recipeKey: key })
    } finally {
      if (mounted.current) setValidating(false)
    }
  }

  async function startRun() {
    if (!validation?.report?.ok || validation.recipeKey !== recipeKey || active) return
    setActionBusy(true)
    setNotice(null)
    try {
      const handle = await createFlowRun(recipe)
      if (!mounted.current) return
      setPollError(null)
      setRun({ runId: handle.run_id, state: handle.job.state, stage: handle.job.stage, job: handle.job, recipe, cost: handle.cost })
      writeStored({ active: handle.run_id })
      refreshHistory()
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
      const response = await cancelFlowRun(run.runId)
      if (mounted.current) setRun((current) => current && current.runId === response.run_id ? { ...current, state: response.state, job: response.job ?? current.job } : current)
    } catch (error) {
      if (mounted.current) setNotice({ tone: 'error', text: `취소 요청 실패: ${messageOf(error)}` })
    } finally {
      if (mounted.current) setActionBusy(false)
    }
  }

  async function load(runId: string) {
    setActionBusy(true)
    try {
      await openRun(runId, 'displayed')
      if (mounted.current) setNotice({ tone: 'info', text: `${runId}를 불러왔습니다.` })
    } catch (error) {
      if (mounted.current) setNotice({ tone: 'error', text: `불러오기 실패: ${messageOf(error)}` })
    } finally {
      if (mounted.current) setActionBusy(false)
    }
  }

  const fresh = validation?.recipeKey === recipeKey && validation.report?.ok === true
  const step = displayed && tab === 'compare' ? 5 : displayed && tab === 'methods' ? 4 : active || fresh ? 3 : tab === 'concepts' ? 0 : 2
  const spaces = displayed ? spacesOf(displayed) : []
  const dataset = displayed ? findDataset(displayed, space, condition) : null

  return (
    <main className="workspace flw-workspace">
      <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={STEPS} step={step} />

      <aside className="control-panel flw-controls">
        <div className="panel-heading">
          <span className="eyebrow">Information Flow · 설정</span>
          <h1>연결성은<br />정보 흐름인가?</h1>
          <p>정답 방향을 아는 JR 소스를 EEG로 관측하고, 다섯 방법이 무엇을 보여주고 무엇을 놓치는지 확인합니다.</p>
        </div>
        <fieldset disabled={active} className="flw-fieldset">
          <legend className="flw-sr-only">시뮬레이션 설정</legend>
          <FlowSetup draft={draft} onChange={setDraft} validation={validation} currentKey={recipeKey} validating={validating}
            running={active || actionBusy} onValidate={() => void validate()} onRun={() => void startRun()} />
        </fieldset>
        {active && <p className="flw-help">실행 중에는 설정이 잠깁니다.</p>}
      </aside>

      <section className="canvas-panel flw-canvas">
        <div className="canvas-toolbar">
          <div>
            <span className="eyebrow">{tab === 'concepts' ? '개념 입문' : '표시 중인 결과'}</span>
            <h2>{tab === 'concepts' ? 'SC · FC · 유효 연결 · 정보 흐름' : displayed ? `${displayed.run_id} · ${displayed.profile}` : '아직 결과 없음'}</h2>
          </div>
          <div className="view-tabs" role="tablist" aria-label="Information Flow 보기">
            {([['concepts', '개념'], ['methods', '방법 카드'], ['compare', '센서 vs 소스']] as [Tab, string][]).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          <div className="canvas-status">
            <span>{displayed ? displayed.run_id : 'NO RESULT'}</span>
            {edited && <em data-testid="flow-edited-badge">편집 중 설정은 표시 결과와 다름</em>}
          </div>
        </div>

        <div className="flw-stage">
          {notice && <p className={notice.tone === 'error' ? 'flw-banner error' : 'flw-banner'} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'error' && <TriangleAlert size={14} />} {notice.text}</p>}
          {tab === 'concepts' && <ConceptPrimer catalog={catalog} error={catalogError} />}
          {tab !== 'concepts' && !displayed && (
            <div className="empty-stage">
              <span className="eyebrow">결과 없음</span>
              <h3>설정을 검증한 뒤 실행하세요.</h3>
              <p>왼쪽에서 결합 G, 신호 길이, 관측 방식을 정하고 ‘설정 검증’ → ‘생성·분석 실행’을 누르세요. 결과는 저장되어 다시 열 때 복원됩니다.</p>
            </div>
          )}
          {tab === 'methods' && displayed && (
            <>
              <div className="flw-dataset-picker">
                <div className="flw-segmented" role="group" aria-label="분석 공간">
                  {spaces.map((item) => <button key={item} type="button" aria-pressed={space === item} className={space === item ? 'active' : ''} onClick={() => setSpace(item)}>{SPACE_LABELS[item] ?? item}</button>)}
                </div>
                <div className="flw-segmented" role="group" aria-label="결합 조건">
                  {(['coupled', 'control'] as const).map((item) => <button key={item} type="button" aria-pressed={condition === item} className={condition === item ? 'active' : ''} onClick={() => setCondition(item)}>{CONDITION_LABELS[item]}</button>)}
                </div>
                {dataset && <small>{dataset.channel_names.length}채널 · G={dataset.G} · {dataset.sfreq} Hz · {dataset.n_samples} 표본 · 단위 {dataset.units}</small>}
              </div>
              {active && run?.runId !== displayed.run_id && <p className="flw-scope">새 실행이 진행 중입니다. 끝나기 전까지 이 결과를 유지합니다.</p>}
              {dataset
                ? <MethodCards key={`${displayed.run_id}-${dataset.dataset_id}`} result={displayed} dataset={dataset} catalog={catalog} />
                : <p className="flw-note">이 결과에는 {SPACE_LABELS[space] ?? space} · {CONDITION_LABELS[condition]} 데이터셋이 없습니다.</p>}
            </>
          )}
          {tab === 'compare' && displayed && <SensorSourceComparison key={displayed.run_id} result={displayed} catalog={catalog} />}
        </div>
      </section>

      <aside className="inspector-panel flw-inspector">
        <section className="inspector-lead">
          <span className="eyebrow">실행 상태</span>
          <h2>{run ? (active ? '실행 진행 중' : '마지막 실행') : '실행한 작업 없음'}</h2>
        </section>
        {run && <FlowRunProgress run={run} busy={actionBusy} pollError={pollError} onCancel={() => void cancel()} onRefresh={() => setPollError(null)} />}

        {displayed && (
          <section className="flw-provenance" aria-label="표시 중인 결과 정보">
            <span className="eyebrow">생성 정보</span>
            <dl>
              <div><dt>실행</dt><dd><code>{displayed.run_id}</code></dd></div>
              <div><dt>결합</dt><dd>G = {displayed.recipe.simulation.G} / {displayed.recipe.simulation.control_G}</dd></div>
              <div><dt>길이</dt><dd>{displayed.recipe.simulation.duration_s} s · seed {displayed.recipe.simulation.seed}</dd></div>
              <div><dt>데이터셋</dt><dd>{displayed.datasets.length}개</dd></div>
              <div><dt>소요</dt><dd>{formatSeconds(displayed.timings_s?.total_s)}</dd></div>
              <div><dt>고정 sha</dt><dd><code>{displayed.truth_isolation.frozen_analysis_sha256.slice(0, 12)}</code></dd></div>
            </dl>
            <p className="flw-muted">분석 결과는 정답 평가 전에 sha256으로 고정되었습니다. 정답은 소스 공간에서만 쓰입니다.</p>
            {displayedDraft && edited && <button type="button" className="quiet-button flw-secondary" disabled={active} onClick={() => setDraft(displayedDraft)}>이 결과의 설정을 편집기로 불러오기</button>}
          </section>
        )}

        <section className="flw-history" aria-label="저장된 실행">
          <span className="eyebrow">저장된 실행</span>
          {history.length === 0 && <p className="flw-muted">저장된 실행이 없습니다.</p>}
          <ul>
            {history.slice(0, 8).map((item) => (
              <li key={item.run_id}>
                <button type="button" className="quiet-button" disabled={!item.has_result || actionBusy || item.run_id === displayed?.run_id} onClick={() => void load(item.run_id)}>
                  <FolderOpen size={13} /> <span>{item.run_id}</span><small>{item.state}{item.created_at ? ` · ${item.created_at.slice(0, 16).replace('T', ' ')}` : ''}</small>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <div className="nonclinical"><TriangleAlert size={15} /><span>교육·연구용 시뮬레이션입니다.<br />임상 진단에 쓰지 마세요.</span></div>
      </aside>
    </main>
  )
}
