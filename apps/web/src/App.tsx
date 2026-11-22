import { CodeExport } from './components/CodeExport'
import { PracticeGames } from './components/PracticeGames'
import { filterScript } from './lessons/mneExport'
import { SignalJourney } from './components/SignalJourney'
import { StackedEegComparison } from './components/StackedEegBrowser'
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  CircleHelp,
  Eye,
  EyeOff,
  FolderKanban,
  History,
  Info,
  Layers3,
  Play,
  Plus,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react'
import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useState } from 'react'

import { AboutExperience } from './components/AboutDialog'
import { StartScreen } from './components/StartScreen'
import { MathSteps } from './components/MathSteps'
import { PhasePrimer } from './components/PhasePrimer'
import { RemovedSignalStrip } from './components/RemovedSignalStrip'
import { LineChart } from './components/Charts'
import { LookHere, PredictionChoices, PredictionFeedback, TryThisList, type PredictionAnswer } from './components/LessonPanels'
import { ConnectivityWorkbench } from './components/ConnectivityWorkbench'
import { IcaWorkbench } from './components/IcaWorkbench'
import { ControlHint } from './components/ControlHint'
import { LabNavigator, type LabId } from './components/LabNavigator'
import { RealDataWorkbench } from './components/RealDataWorkbench'
import { QeegWorkbench } from './components/QeegWorkbench'
import { SourceModelWorkbench } from './components/SourceModelWorkbench'
import { BenchmarkWorkbench } from './features/benchmarks/BenchmarkWorkbench'
import { checkHealth, runRecipe } from './lib/api'
import { computeSamplingPreview, previewAsResult } from './lib/samplingPreview'
import { BASELINE_PREDICTION, SAMPLING_EXPERIMENTS, aliasFrequency, experimentRecipe, matchesExperiment, peakChanges, summarizePeakChanges } from './lessons/samplingLesson'
import { defaultRecipe, type ExperimentRecipe, type ExperimentResult, type RequestState } from './types'
import type { GradedPrediction, SamplingExperiment } from './lessons/samplingLesson'

// The Information Flow lab is loaded on demand so it does not grow the initial bundle.
const FlowWorkbench = lazy(() => import('./features/flow/FlowWorkbench').then((module) => ({ default: module.FlowWorkbench })))

const STEPS = [
  { label: '예측(Predict)', description: '결과를 먼저 골라 둡니다.', icon: CircleHelp },
  { label: '생성(Generate)', description: '주파수를 아는 원천으로 EEG를 만듭니다.', icon: Sparkles },
  { label: '관찰(Observe)', description: '처리 전 센서 신호를 봅니다.', icon: Activity },
  { label: '필터(Filter)', description: '선택한 전처리를 적용합니다.', icon: SlidersHorizontal },
  { label: '비교(Compare)', description: '시간과 주파수에서 변화를 봅니다.', icon: Layers3 },
  { label: '공개(Reveal)', description: '정답과 내 예측을 대조합니다.', icon: Eye },
]

const VIEWS = ['Channel detail', 'Filter response'] as const
type View = (typeof VIEWS)[number]
const VIEW_LABELS: Record<View, string> = { 'Channel detail': '채널 상세', 'Filter response': '필터 응답' }
const SOURCE_LABELS: Record<string, string> = { delta: '느린 drift', alpha: '알파 리듬(Alpha)', line: '전원 잡음(Line noise)' }
const sourceLabel = (source: { id: string; label: string }) => SOURCE_LABELS[source.id] ?? source.label

const START_SEEN_STORAGE_KEY = 'neurosignal-start-seen'
const COMPLETED_STORAGE_KEY = 'neurosignal-lab01-completed-experiments'
const PROJECTS_STORAGE_KEY = 'neurosignal-workspace-projects'
const ACTIVE_PROJECT_STORAGE_KEY = 'neurosignal-active-workspace-project'
const LEGACY_PROJECTS_STORAGE_KEY = 'neurobridge-workspace-projects'
const LEGACY_ACTIVE_PROJECT_STORAGE_KEY = 'neurobridge-active-workspace-project'

const cloneRecipe = (recipe: ExperimentRecipe): ExperimentRecipe => structuredClone(recipe)
const formatWeight = (value: number | undefined) => value === undefined ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`

function App() {
  // First launch opens the question-first start screen; later launches go straight to Lab 01.
  const [activeLab, setActiveLabState] = useState<LabId>(() => window.localStorage.getItem(START_SEEN_STORAGE_KEY) ? 'filter' : 'start')
  const setActiveLab = (lab: LabId) => {
    if (lab !== 'start') window.localStorage.setItem(START_SEEN_STORAGE_KEY, '1')
    setActiveLabState(lab)
  }
  const [recipe, setRecipe] = useState<ExperimentRecipe>(() => cloneRecipe(defaultRecipe))
  const [request, setRequest] = useState<RequestState>({ status: 'idle' })
  const [baseline, setBaseline] = useState<ExperimentResult | null>(null)
  const [runs, setRuns] = useState<ExperimentResult[]>([])
  const [view, setView] = useState<View>('Channel detail')
  const [selectedChannel, setSelectedChannel] = useState(0)
  const [step, setStep] = useState(0)
  const [activeExperimentId, setActiveExperimentId] = useState<string | null>(null)
  const [answer, setAnswer] = useState<PredictionAnswer>(null)
  const [reason, setReason] = useState('')
  const [answeredFor, setAnsweredFor] = useState<{ experimentId: string | null; answer: PredictionAnswer; reason: string } | null>(null)
  const [completedExperiments, setCompletedExperiments] = useState<string[]>(() => {
    try { return JSON.parse(window.localStorage.getItem(COMPLETED_STORAGE_KEY) ?? '[]') as string[] } catch { return [] }
  })
  const [truthVisible, setTruthVisible] = useState(false)
  // Feedback is frozen at reveal time, so exploring afterwards does not regrade the answer.
  const [revealed, setRevealed] = useState<{ prediction: GradedPrediction; answer: PredictionAnswer; reason: string; graded: boolean; experiment: SamplingExperiment | null } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [serviceReady, setServiceReady] = useState<boolean | null>(null)
  const [projects, setProjects] = useState(() => {
    const saved = window.localStorage.getItem(PROJECTS_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_PROJECTS_STORAGE_KEY)
    return saved ? JSON.parse(saved) as { id: string; name: string }[] : [{ id: 'learning-workspace', name: '학습 작업공간' }]
  })
  const [activeProjectId, setActiveProjectId] = useState(() => (
    window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_ACTIVE_PROJECT_STORAGE_KEY)
      ?? 'learning-workspace'
  ))
  const [newProjectName, setNewProjectName] = useState('')

  const activeExperiment = SAMPLING_EXPERIMENTS.find((item) => item.id === activeExperimentId) ?? null
  const activePrediction = activeExperiment?.prediction ?? BASELINE_PREDICTION
  const result = request.status === 'success' ? request.data : runs[0] ?? null
  const dirty = result ? JSON.stringify(recipe) !== JSON.stringify(result.recipe) : true
  // The prediction locked in at the last run is the one that gets graded.
  const answeredExperiment = SAMPLING_EXPERIMENTS.find((item) => item.id === answeredFor?.experimentId) ?? null
  const answeredPrediction = answeredExperiment?.prediction ?? BASELINE_PREDICTION
  const predictionGraded = Boolean(result && answeredFor && matchesExperiment(result.recipe, answeredExperiment))
  // Sliders answer instantly only once guessing is over (after reveal, or when the learner skipped
  // predicting); before that the preview would give the answer away.
  const previewUnlocked = truthVisible || answer === 'skip'
  const deferredRecipe = useDeferredValue(recipe)
  const needsPreview = previewUnlocked && request.status !== 'loading' && dirty
  const preview = useMemo(() => needsPreview ? previewAsResult(computeSamplingPreview(deferredRecipe)) : null, [needsPreview, deferredRecipe])
  const shown: ExperimentResult | null = preview ?? result
  const nyquist = recipe.simulation.sampling_rate_hz / 2
  const foldedSources = recipe.simulation.sources.filter((source) => source.frequency_hz > nyquist)
  const showLookHere = Boolean(result && answeredFor && answeredFor.experimentId === activeExperimentId && activeExperiment && matchesExperiment(result.recipe, activeExperiment))
  const channelCount = shown?.recipe.simulation.channel_count ?? recipe.simulation.channel_count
  const selectedChannelIndex = Math.min(selectedChannel, Math.max(0, channelCount - 1))
  const selectedChannelName = `EEG ${String(selectedChannelIndex + 1).padStart(2, '0')}`
  const selectedRawTrace = shown?.traces.series[`Raw · ${selectedChannelName}`] ?? []
  const selectedFilteredTrace = shown?.traces.series[`Filtered · ${selectedChannelName}`] ?? []
  const selectedRawPower = shown?.spectrum.raw_power_by_channel?.[selectedChannelName] ?? []
  const selectedFilteredPower = shown?.spectrum.filtered_power_by_channel?.[selectedChannelName] ?? []
  const selectedChannelDataAvailable = selectedRawTrace.length > 0
    && selectedFilteredTrace.length > 0
    && selectedRawPower.length > 0
    && selectedFilteredPower.length > 0
  const removedTrace = selectedRawTrace.map((value, index) => value - (selectedFilteredTrace[index] ?? 0))
  const peakSummary = shown && selectedChannelDataAvailable
    ? summarizePeakChanges(peakChanges(shown, selectedChannelName), selectedChannelName, shown.recipe.preprocessing.reference)
    : ''
  const selectedMixingWeights = shown?.mixing_matrix[selectedChannelIndex] ?? []
  const referenceMeans = shown?.mixing_matrix[0]?.map((_, sourceIndex) => (
    shown.mixing_matrix.reduce((sum, row) => sum + (row[sourceIndex] ?? 0), 0) / shown.mixing_matrix.length
  )) ?? []
  const selectedEffectiveWeights = selectedMixingWeights.map((weight, sourceIndex) => (
    recipe.preprocessing.reference === 'average' ? weight - (referenceMeans[sourceIndex] ?? 0) : weight
  ))
  const sourceContributions = selectedEffectiveWeights.map((weight, sourceIndex) => (
    Math.abs(weight * (shown?.recipe.simulation.sources[sourceIndex]?.amplitude_uv ?? 0))
  ))
  const dominantSourceIndex = sourceContributions.length
    ? sourceContributions.indexOf(Math.max(...sourceContributions))
    : -1
  const dominantSource = dominantSourceIndex >= 0 ? shown?.recipe.simulation.sources[dominantSourceIndex] : undefined
  const dominantEffectiveWeight = dominantSourceIndex >= 0 ? selectedEffectiveWeights[dominantSourceIndex] : undefined
  const dominantContribution = dominantSourceIndex >= 0 ? sourceContributions[dominantSourceIndex] : undefined

  useEffect(() => {
    const controller = new AbortController()
    checkHealth(controller.signal).then(setServiceReady).catch(() => setServiceReady(false))
    return () => controller.abort()
  }, [])

  // Confirm a settled preview with the server; the confirmed run replaces the preview.
  useEffect(() => {
    if (!previewUnlocked || !result || !dirty || confirming || request.status === 'loading' || serviceReady === false) return
    const timer = window.setTimeout(() => { void confirmRun(recipe) }, 900)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe, previewUnlocked, result, dirty, confirming, request.status, serviceReady])

  useEffect(() => {
    window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects))
  }, [projects])

  useEffect(() => {
    window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeProjectId)
  }, [activeProjectId])

  useEffect(() => {
    window.localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify(completedExperiments))
  }, [completedExperiments])

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0]

  function createProject() {
    const name = newProjectName.trim()
    if (!name) return
    const project = { id: crypto.randomUUID(), name }
    setProjects((items) => [...items, project])
    setActiveProjectId(project.id)
    setNewProjectName('')
  }

  function updateSimulation<K extends keyof ExperimentRecipe['simulation']>(key: K, value: ExperimentRecipe['simulation'][K]) {
    setRecipe({ ...recipe, simulation: { ...recipe.simulation, [key]: value } })
  }

  function updatePreprocessing<K extends keyof ExperimentRecipe['preprocessing']>(key: K, value: ExperimentRecipe['preprocessing'][K]) {
    setRecipe({ ...recipe, preprocessing: { ...recipe.preprocessing, [key]: value } })
  }

  function selectExperiment(id: string | null) {
    const experiment = SAMPLING_EXPERIMENTS.find((item) => item.id === id) ?? null
    setActiveExperimentId(experiment?.id ?? null)
    setRecipe(experimentRecipe(experiment))
    setView(experiment?.view ?? 'Channel detail')
    setAnswer(null)
    setReason('')
    setTruthVisible(false)
    setRevealed(null)
    setStep(0)
  }

  async function execute() {
    if (answer === null) {
      setStep(0)
      return
    }
    setAnsweredFor({ experimentId: activeExperimentId, answer, reason })
    setTruthVisible(false)
    setStep(1)
    setRequest({ status: 'loading', stage: '알려진 원천을 만드는 중', progress: 18 })
    const progressTimer = window.setInterval(() => {
      setRequest((current) => {
        if (current.status !== 'loading') return current
        const next = Math.min(current.progress + 14, 88)
        const stage = next < 45 ? '센서로 투영하는 중' : next < 72 ? '기준전극과 필터를 적용하는 중' : '스펙트럼과 실행 기록을 계산하는 중'
        return { status: 'loading', stage, progress: next }
      })
    }, 180)
    try {
      const nextResult = await runRecipe(recipe)
      window.clearInterval(progressTimer)
      setRequest({ status: 'success', data: nextResult })
      setRuns((items) => [nextResult, ...items.filter((item) => item.run_id !== nextResult.run_id)].slice(0, 8))
      setBaseline((current) => current ?? nextResult)
      setStep(2)
      setServiceReady(true)
    } catch (error) {
      window.clearInterval(progressTimer)
      setRequest({ status: 'error', message: error instanceof Error ? error.message : '실행을 마치지 못했습니다.' })
      setServiceReady(false)
    }
  }

  async function confirmRun(target: ExperimentRecipe) {
    setConfirming(true)
    try {
      const nextResult = await runRecipe(target)
      setRequest({ status: 'success', data: nextResult })
      setRuns((items) => [nextResult, ...items.filter((item) => item.run_id !== nextResult.run_id)].slice(0, 8))
      setServiceReady(true)
    } catch {
      setServiceReady(false)
    } finally {
      setConfirming(false)
    }
  }

  function revealTruth() {
    if (answeredFor) {
      setRevealed({ prediction: answeredPrediction, answer: answeredFor.answer, reason: answeredFor.reason, graded: predictionGraded, experiment: predictionGraded ? answeredExperiment : null })
    }
    setTruthVisible(true)
    setStep(5)
    if (result && answeredFor && answeredFor.experimentId && matchesExperiment(result.recipe, answeredExperiment)) {
      const id = answeredFor.experimentId
      setCompletedExperiments((items) => items.includes(id) ? items : [...items, id])
    }
    // Predicting is done for this run; the next run asks again.
    setAnswer(null)
    setReason('')
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><Activity size={22} strokeWidth={2.1} /></div>
          <div>
            <strong>NeuroSignal</strong>
            <span>TESTBED</span>
          </div>
        </div>
        <details className="project-menu">
          <summary>
            <FolderKanban size={17} />
            <span><span className="eyebrow">현재 프로젝트</span><strong>{activeProject?.name ?? '학습 작업공간'}</strong></span>
            <ChevronDown size={14} />
          </summary>
          <div className="project-menu-panel">
            <p>프로젝트는 브라우저의 Lab 작업공간을 서로 분리합니다. 가져온 기록은 각자의 로컬 FIF 작업 사본 기록을 따로 가집니다.</p>
            <span className="eyebrow">프로젝트 열기</span>
            <div className="project-list" role="list" aria-label="프로젝트 열기">
              {projects.map((project) => <button key={project.id} role="listitem" className={project.id === activeProjectId ? 'active' : ''} onClick={() => setActiveProjectId(project.id)}>{project.id === 'learning-workspace' && project.name === 'Learning workspace' ? '학습 작업공간' : project.name}</button>)}
            </div>
            <label className="project-create-field"><span>새 프로젝트 이름</span><input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && createProject()} placeholder="예: Pilot 01" /></label>
            <button className="project-create" onClick={createProject} disabled={!newProjectName.trim()}><Plus size={15} /> 새 프로젝트</button>
          </div>
        </details>
        <div className="header-actions">
          <AboutExperience />
          <span className={`service-state ${serviceReady === false ? 'offline' : ''}`}>
            <i />{serviceReady === null ? '분석 서버 확인 중' : serviceReady ? '로컬 분석 서버 준비됨' : '분석 서버 꺼짐'}
          </span>

        </div>
      </header>

      {activeLab === 'start' ? <StartScreen onLabChange={setActiveLab} /> : activeLab === 'phase' ? <PhasePrimer activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'journey' ? <SignalJourney activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'practice' ? <PracticeGames activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'ica' ? <IcaWorkbench activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'connectivity' ? <ConnectivityWorkbench activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'source' ? <SourceModelWorkbench activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'real' ? <RealDataWorkbench activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'qeeg' ? <QeegWorkbench activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'benchmark' ? <BenchmarkWorkbench activeLab={activeLab} onLabChange={setActiveLab} /> : activeLab === 'flow' ? <Suspense fallback={<main className="workspace"><p className="empty-stage" role="status">Information Flow 실습을 불러오는 중…</p></main>}><FlowWorkbench activeLab={activeLab} onLabChange={setActiveLab} /></Suspense> : <>
        <main className="workspace">
        <LabNavigator activeLab={activeLab} onLabChange={setActiveLab} steps={STEPS} step={step} />

        <aside className="control-panel">
          <div className="panel-heading">
            <span className="eyebrow">기초 · 안내 실습</span>
            <h1>센서를 거치면<br />무엇이 남는가?</h1>
            <p>한 번에 한 가지만 바꿉니다. 정답을 공개하기 전에 결과를 먼저 예측합니다.</p>
          </div>

          <TryThisList
            items={SAMPLING_EXPERIMENTS}
            activeId={activeExperimentId}
            completed={completedExperiments}
            disabled={request.status === 'loading'}
            onSelect={selectExperiment}
          />

          <PredictionChoices
            prediction={activePrediction}
            answer={answer}
            onAnswer={setAnswer}
            reason={reason}
            onReason={setReason}
            locked={request.status === 'loading'}
          />

          <section className="control-section">
            <div className="section-title"><span>신호(Signal)</span><small>알려진 원천</small></div>
            <div className="source-list">
              {recipe.simulation.sources.map((source) => (
                <div className="source-row" key={source.id}>
                  <span><i className={`source-dot ${source.id}`} />{sourceLabel(source)}</span>
                  <strong>{source.frequency_hz} Hz</strong>
                  <small>{source.amplitude_uv} µV</small>
                </div>
              ))}
            </div>
            <RangeControl
              label="표본화율(Sampling rate)"
              ariaLabel="Sampling rate"
              help="1초에 몇 번 측정하는지입니다. 표본화율이 낮으면 빠른 신호가 엉뚱한 주파수에 나타날 수 있습니다(aliasing)."
              value={recipe.simulation.sampling_rate_hz}
              min={100}
              max={500}
              step={50}
              unit="Hz"
              onChange={(value) => updateSimulation('sampling_rate_hz', value)}
            />
            {previewUnlocked && (
              <p className="live-readout" aria-live="polite">
                Nyquist <b>{nyquist} Hz</b>
                {foldedSources.length
                  ? foldedSources.map((source) => <span key={source.id}> · {source.frequency_hz} Hz → <b>{aliasFrequency(source.frequency_hz, recipe.simulation.sampling_rate_hz)} Hz</b>에 나타남</span>)
                  : <span> · 심어 둔 원천은 모두 그대로 표현됨</span>}
              </p>
            )}
            <RangeControl
              label="EEG 배경 활동(Background)"
              ariaLabel="EEG background"
              help="1/f 형태의 배경 활동과 작은 백색 센서 잡음의 RMS 크기입니다. 값이 클수록 심어 둔 진동을 찾기 어려워집니다."
              value={recipe.simulation.noise_uv}
              min={0}
              max={20}
              step={1}
              unit="µV"
              onChange={(value) => updateSimulation('noise_uv', value)}
            />
          </section>

          <section className="control-section">
            <div className="section-title"><span>변환(Transform)</span><small>되돌릴 수 있음</small></div>
            <RangeControl
              label="고역 통과(High-pass)"
              ariaLabel="High-pass"
              help="이 주파수보다 느린 변화를 줄입니다. drift를 없애지만, 너무 높이면 느린 EEG 활동까지 왜곡합니다."
              value={recipe.preprocessing.highpass_hz ?? 0}
              min={0.5}
              max={8}
              step={0.5}
              unit="Hz"
              onChange={(value) => updatePreprocessing('highpass_hz', value)}
            />
            <RangeControl
              label="저역 통과(Low-pass)"
              ariaLabel="Low-pass"
              help="이 주파수보다 빠른 변화를 줄입니다. 고주파 잡음과 이 Lab에 심어 둔 60 Hz 신호를 줄입니다."
              value={recipe.preprocessing.lowpass_hz ?? 40}
              min={15}
              max={90}
              step={5}
              unit="Hz"
              onChange={(value) => updatePreprocessing('lowpass_hz', value)}
            />
            <div className="segmented-field">
              <span className="control-label">기준전극(Reference)<ControlHint>모든 채널의 공통 전압 기준을 정합니다. 평균 기준(Average)은 자료의 rank를 바꾸고 센서 신호의 모양도 바꿀 수 있습니다.</ControlHint></span>
              <div role="group" aria-label="Reference method">
                <button className={recipe.preprocessing.reference === 'average' ? 'selected' : ''} onClick={() => updatePreprocessing('reference', 'average')}>평균(Average)</button>
                <button className={recipe.preprocessing.reference === 'none' ? 'selected' : ''} onClick={() => updatePreprocessing('reference', 'none')}>없음(None)</button>
              </div>
            </div>
          </section>

          {previewUnlocked
            ? <p className="preview-note"><b>실시간 미리보기</b> 슬라이더를 움직이면 그래프가 바로 따라옵니다. 손을 떼면 분석 서버가 같은 설정으로 다시 계산해 확정합니다.</p>
            : <p className="preview-note locked">예측을 공개하고 나면 슬라이더가 즉시 반응합니다(실시간 미리보기).</p>}
          {answer === null && !truthVisible && <p className="run-prerequisite">위에서 예측을 고르거나 "예측 없이 진행"을 누르면 실행할 수 있습니다.</p>}
          {answer === null && truthVisible && <p className="run-prerequisite">새 실행을 채점받으려면 예측을 다시 고르세요.</p>}
          <button className="primary-button sampling-run-button" onClick={execute}
            disabled={request.status === 'loading' || answer === null}>
            <Play size={15} fill="currentColor" />
            {request.status === 'loading' ? 'EEG 생성 중…' : result ? 'EEG 다시 생성(Regenerate)' : 'EEG 생성(Generate)'}
          </button>

        </aside>

        <section className="canvas-panel sampling-canvas">
          <div className="canvas-toolbar">
            <div>
              <span className="eyebrow">주 캔버스 · <span className="data-kind simulated">시뮬레이션 · 정답을 앎</span></span>
              <h2>{view === 'Channel detail' ? `${selectedChannelName} · 신호, 스펙트럼, 가중치` : VIEW_LABELS[view]}</h2>
              {view === 'Channel detail' && (
                <div className="channel-switcher" role="group" aria-label="Simulated sensor channel">
                  {Array.from({ length: channelCount }, (_, index) => {
                    const label = `EEG ${String(index + 1).padStart(2, '0')}`
                    return <button key={label} aria-pressed={index === selectedChannelIndex} className={index === selectedChannelIndex ? 'active' : ''} onClick={() => setSelectedChannel(index)}>{label}</button>
                  })}
                </div>
              )}
            </div>
            <div className="view-tabs" role="tablist" aria-label="Visualization type">
              {VIEWS.map((item) => <button key={item} role="tab" aria-selected={item === view} className={item === view ? 'active' : ''} title={item} onClick={() => setView(item)}>{VIEW_LABELS[item]}</button>)}
            </div>
            <div className="canvas-status">
              {preview
                ? <span className="preview-badge" role="status">미리보기 · 브라우저 계산</span>
                : <span>{result ? `RUN ${result.run_id.slice(-4).toUpperCase()}` : '실행 없음'}</span>}
              {preview ? <em>{confirming ? '서버 확정 중…' : '손을 떼면 서버가 확정'}</em> : dirty && <em>바뀐 설정 있음</em>}
            </div>
          </div>

          <div className="visual-stage">
            {request.status === 'loading' && (
              <div className="run-overlay" role="status" aria-live="polite">
                <div className="orbit"><Activity size={26} /></div>
                <span className="eyebrow">분석 파이프라인</span>
                <h3>{request.stage}</h3>
                <div className="progress-track"><i style={{ width: `${request.progress}%` }} /></div>
                <p>{request.progress}% · 결정론적 실행 · seed {recipe.simulation.seed}</p>
              </div>
            )}
            {request.status === 'error' && (
              <div className="empty-stage error-stage">
                <AlertTriangle size={30} />
                <h3>실행을 안전하게 멈췄습니다</h3>
                <p>{request.message}</p>
                <p>설정을 확인한 뒤 왼쪽의 EEG 생성 버튼으로 다시 시도하세요.</p>
              </div>
            )}
            {!shown && request.status !== 'loading' && request.status !== 'error' && (
              <div className="empty-stage">
                <div className="empty-wave" aria-hidden="true"><Activity size={42} /></div>
                <span className="eyebrow">실험 준비 완료</span>
                <h3>설정으로 EEG를 만들어 보세요.</h3>
                <p>왼쪽에서 실험 과제를 하나 고르고 결과를 예측한 뒤 EEG 생성(Generate)을 누르세요.</p>
              </div>
            )}
            {shown && request.status !== 'loading' && view === 'Channel detail' && selectedChannelDataAvailable && (
              <div className="channel-detail">
                {showLookHere && activeExperiment && <LookHere>{activeExperiment.lookAt}</LookHere>}
                <section className="channel-plot signal-plot">
                  <div className="plot-heading">
                    <span><b>01</b><span><strong>신호(Signal)</strong><small>시간에 따른 전압</small></span></span>
                    <small className="layer-legend"><span className="before">처리 전</span><span className="after">처리 후</span><span className="removed">제거된 것</span></small>
                  </div>
                  <StackedEegComparison
                    x={shown.traces.x}
                    series={{ [`Before · ${selectedChannelName}`]: selectedRawTrace, [`After · ${selectedChannelName}`]: selectedFilteredTrace }}
                    channelNames={[selectedChannelName]}
                    beforeLabel="처리 전 EEG (Raw)"
                    afterLabel="처리 후 EEG (Processed)"
                    ariaLabel={`Raw and processed ${selectedChannelName} time series`}
                  />
                  <RemovedSignalStrip x={shown.traces.x} values={removedTrace} channelName={selectedChannelName} />
                </section>
                <section className="channel-plot spectrum-plot">
                  <div className="plot-heading">
                    <span><b>02</b><span><strong>스펙트럼(Spectrum)</strong><small>주파수별 파워</small></span></span>
                    <small>Welch PSD · 이 채널만</small>
                  </div>
                  <LineChart
                    x={shown.spectrum.frequency_hz}
                    series={[
                      { label: `처리 전 PSD · ${selectedChannelName}`, values: selectedRawPower, color: BEFORE_COLOR, dashed: true },
                      { label: `처리 후 PSD · ${selectedChannelName}`, values: selectedFilteredPower, color: '#087f83' },
                    ]}
                    xDomain={[0, Math.min(80, shown.recipe.simulation.sampling_rate_hz / 2)]}
                    xLabel="주파수(Hz)"
                    yLabel="파워 (log µV²/Hz)"
                    ariaLabel={`Raw and processed ${selectedChannelName} Welch power spectral density`}
                    logY
                    markers={truthVisible ? shown.truth_peaks_hz : []}
                    height={220}
                  />
                </section>
              </div>
            )}
            {shown && request.status !== 'loading' && view === 'Channel detail' && !selectedChannelDataAvailable && (
              <div className="empty-stage stale-result-stage" role="status">
                <AlertTriangle size={30} />
                <span className="eyebrow">불완전한 실행 결과</span>
                <h3>{selectedChannelName}의 신호나 스펙트럼이 없습니다.</h3>
                <p>로컬 분석 서버를 다시 시작한 뒤 왼쪽의 EEG 다시 생성을 눌러 신호와 스펙트럼을 함께 만드세요.</p>
              </div>
            )}
            {shown && request.status !== 'loading' && view === 'Filter response' && (
              <div className="filter-response-view">
              {showLookHere && activeExperiment && <LookHere>{activeExperiment.lookAt}</LookHere>}
              <LineChart
                x={shown.filter_response.frequency_hz}
                series={[{ label: filterResponseLabel(shown.recipe), values: shown.filter_response.gain_db, color: '#087f83' }]}
                xDomain={[0, shown.recipe.simulation.sampling_rate_hz / 2]}
                xLabel="주파수(Hz)"
                yLabel="이득(Gain, dB)"
                yDomain={[-80, 5]}
                ariaLabel="Actual digital filter response in decibels"
              />
              </div>
            )}
          </div>

          <div className="channel-weight-readout" aria-label={`${selectedChannelName} source weights`}>
            <div className="weight-intro">
              <span className="eyebrow">03 · 원천 가중치(Source weights)</span>
              <strong>{selectedChannelName}</strong>
              <small>Raw 혼합 / {recipe.preprocessing.reference === 'average' ? '평균 기준 적용 후' : '재기준화 없음'}</small>
            </div>
            {recipe.simulation.sources.map((source, sourceIndex) => (
              <div className="weight-source" key={source.id}>
                <span><i className={`source-dot ${source.id}`} />{sourceLabel(source)}</span>
                <strong>{source.frequency_hz} Hz</strong>
                <dl>
                  <div><dt>Raw</dt><dd>{formatWeight(selectedMixingWeights[sourceIndex])}</dd></div>
                  <div><dt>처리 후</dt><dd>{formatWeight(selectedEffectiveWeights[sourceIndex])}</dd></div>
                </dl>
              </div>
            ))}
            <p className="weight-note">가중치는 심어 둔 세 진동에 대한 값입니다. 1/f 배경은 그 뒤에 더해집니다. 음수는 위상 반전을 뜻하며 불량 채널이라는 뜻이 아닙니다.</p>
          </div>
        </section>

        <aside className="inspector-panel">
          <section className="inspector-lead">
            <span className="eyebrow">해석(Interpretation)</span>
            <h2>{shown ? `${selectedChannelName}가 이렇게 보이는 이유` : '공개하기 전에 추론하기'}</h2>
            {truthVisible && peakSummary && <p className="result-sentence"><b>결과 한 문장</b> {peakSummary}</p>}
            <p>{shown && dominantSource
              ? `처리된 신호에 가장 크게 기여하는 원천은 ${sourceLabel(dominantSource)}(${dominantSource.frequency_hz} Hz)입니다. 시간 필터 전 기준으로 약 ${dominantContribution?.toFixed(1)} µV입니다.`
              : 'EEG를 생성한 뒤 한 채널의 신호, 스펙트럼, 원천 가중치를 함께 비교하세요.'}</p>
          </section>

          {shown && dominantSource && (
            <section className="channel-explanation">
              <div>
                <strong>가중치가 뜻하는 것</strong>
                <p>{sourceLabel(dominantSource)}의 처리 후 가중치는 {formatWeight(dominantEffectiveWeight)}입니다. 절댓값이 클수록 영향이 크고, 음수이면 파형의 위상이 뒤집힙니다.</p>
              </div>
              <div>
                <strong>Raw와 처리 후가 다른 이유</strong>
                <p>Raw는 원래 혼합 그대로입니다. 처리 후는 {recipe.preprocessing.reference === 'average' ? '먼저 평균 기준을 적용해 모든 채널의 유효 가중치를 바꾼 다음' : '재기준화 없이'} 시간 필터를 적용한 결과입니다.</p>
              </div>
              <div>
                <strong>너무 규칙적으로 보이는 이유</strong>
                <p>이 교육용 신호에는 1/f 형태의 배경 활동과 천천히 변하는 알파 burst 포락선이 들어 있습니다. EEG에 가깝지만 실제 기록보다 단순하며 눈, 근육, 움직임, 전극 아티팩트는 없습니다.</p>
              </div>
            </section>
          )}

          {shown?.warnings.map((warning) => (
            <section className={`warning-card ${warning.severity}`} key={warning.code}>
              <div>{warning.severity === 'warning' ? <AlertTriangle size={17} /> : <Info size={17} />}<strong>{warning.title}</strong></div>
              <p>{warning.explanation}</p>
              {warning.suggestion && <small>{warning.suggestion}</small>}
            </section>
          ))}

          <section className={`truth-block ${truthVisible ? 'revealed' : ''}`}>
            <div className="truth-heading">
              <span><EyeOff size={16} /> 시뮬레이션 정답(Truth)</span>
              <span className="truth-state">{truthVisible ? '공개됨' : '숨김'}</span>
            </div>
            {truthVisible && result ? (
              <div className="truth-content">
                <div className="truth-peaks">
                  {result.truth_peaks_hz.map((peak) => <span key={peak}><strong>{peak}</strong> Hz</span>)}
                </div>
                {revealed && <PredictionFeedback prediction={revealed.prediction} answer={revealed.answer} reason={revealed.reason} graded={revealed.graded} />}
                {revealed?.experiment && <p className="experiment-learn"><b>배우는 것</b> {revealed.experiment.learn}</p>}
                <p>10 Hz 알파 원천은 통과대역 안에 있습니다. 60 Hz 원천은 40 Hz 저역 통과에서 크게 줄어듭니다. 100 Hz로 표본화하면 60 Hz는 필터링 전에 이미 40 Hz로 접힙니다.</p>
              </div>
            ) : (
              <div className="truth-covered">
                <div className="blur-lines"><i /><i /><i /></div>
                <button className="reveal-button" disabled={!result} onClick={revealTruth}><Eye size={16} /> 예측과 대조하기(Reveal)</button>
              </div>
            )}
          </section>

          <MathSteps lab="filter" />
          <CodeExport lab="Lab 01 · 표본화" filename="lab01_sampling.py" code={filterScript(recipe)} />

          <div className="nonclinical"><AlertTriangle size={15} /><span>교육·연구용입니다.<br />임상 진단에 쓰지 마세요.</span></div>
        </aside>
      </main>

      <footer className="run-strip">
        <div className="run-strip-title"><History size={16} /><span>실행 기록(Run history)</span><small>로컬 {runs.length}개</small></div>
        <div className="run-list">
          {!runs.length && <span className="no-runs">마친 실행이 여기에 쌓여 A/B 비교에 쓰입니다.</span>}
          {runs.map((item, index) => (
            <button
              key={item.run_id}
              className={`${result?.run_id === item.run_id ? 'active' : ''} ${baseline?.run_id === item.run_id ? 'baseline' : ''}`}
              onClick={() => setRequest({ status: 'success', data: item })}
            >
              <span>RUN {String(runs.length - index).padStart(2, '0')}</span>
              <strong>{item.recipe.simulation.sampling_rate_hz} Hz · {item.recipe.preprocessing.lowpass_hz} Hz LP</strong>
              <small>{baseline?.run_id === item.run_id ? '고정한 기준 실행' : item.provenance.recipe_hash}</small>
            </button>
          ))}
        </div>
        <div className="strip-actions">
          <button onClick={() => result && setBaseline(result)} disabled={!result}><Save size={15} /> 기준 실행 고정(Pin)</button>
          <button onClick={() => selectExperiment(activeExperimentId)}><RotateCcw size={15} /> 설정 되돌리기</button>
        </div>
        </footer>
      </>}
    </div>
  )
}

const BEFORE_COLOR = '#9a9d97'

interface RangeControlProps {
  label: string
  ariaLabel: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (value: number) => void
}

// Names only the stages that were actually applied; filters at or above Nyquist are skipped.
function filterResponseLabel(recipe: ExperimentRecipe): string {
  const nyquist = recipe.simulation.sampling_rate_hz / 2
  const applied = (value: number | null) => value !== null && value < nyquist ? value : null
  const highpass = applied(recipe.preprocessing.highpass_hz)
  const lowpass = applied(recipe.preprocessing.lowpass_hz)
  const notch = applied(recipe.preprocessing.notch_hz)
  const passband = highpass !== null && lowpass !== null ? `${highpass}–${lowpass} Hz 대역 통과(band-pass)`
    : highpass !== null ? `${highpass} Hz 고역 통과`
      : lowpass !== null ? `${lowpass} Hz 저역 통과` : null
  const stages = [passband, notch !== null ? `${notch} Hz 노치` : null].filter((stage) => stage !== null)
  return stages.length ? `${stages.join(' + ')} · 영위상 이득` : '적용된 필터 없음'
}

function RangeControl({ label, ariaLabel, help, value, min, max, step, unit, onChange }: RangeControlProps & { help: string }) {
  const progress = ((value - min) / (max - min)) * 100
  return (
    <label className="range-control">
      <span><span className="control-label">{label}<ControlHint>{help}</ControlHint></span><output>{value} {unit}</output></span>
      <input
        type="range"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ '--range-progress': `${progress}%` } as React.CSSProperties}
      />
      <small><span>{min}</span><span>{max}</span></small>
    </label>
  )
}

export default App
