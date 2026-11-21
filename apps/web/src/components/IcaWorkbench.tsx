import {
  Activity,
  AlertTriangle,
  CircleHelp,
  Eye,
  EyeOff,
  FlaskConical,
  RefreshCw,
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

import { applyIca, fitIca, simulateIca } from '../lib/api'
import {
  defaultIcaRecipe,
  type IcaApplyResult,
  type IcaFitResult,
  type IcaRecipe,
  type IcaSimulationResult,
} from '../types'
import { LineChart } from './Charts'
import { ControlHint } from './ControlHint'
import { StackedEegBrowser, StackedEegComparison } from './StackedEegBrowser'
import { LabNavigator, type LabId } from './LabNavigator'
import { ScalpTopography } from './ScalpTopography'

const ICA_STEPS = [
  { label: '생성(Generate)', description: '깜박임을 심은 센서 EEG를 만듭니다.', icon: FlaskConical },
  { label: 'EEG 살펴보기', description: '깜박임이 어느 센서에 나타나는지 찾습니다.', icon: ScanSearch },
  { label: 'ICA 적합(Fit)', description: '필터링한 사본에서 성분을 추정합니다.', icon: Split },
  { label: '성분(IC) 살펴보기', description: '성분마다 증거를 비교합니다.', icon: Sparkles },
  { label: '제외(Exclude)', description: '제거할 성분을 고릅니다.', icon: CircleHelp },
  { label: '비교(Compare)', description: '아티팩트가 줄고 신경 신호가 남았는지 봅니다.', icon: ShieldCheck },
]

type IcaView = 'Component trace' | 'Component spectrum' | 'Before / after'
const ICA_VIEW_LABELS: Record<IcaView, string> = { 'Component trace': '성분 시계열', 'Component spectrum': '성분 스펙트럼', 'Before / after': '처리 전 / 후' }
type PipelineState =
  | { status: 'idle' }
  | { status: 'generating'; stage: string; progress: number }
  | { status: 'fitting'; stage: string; progress: number }
  | { status: 'applying'; stage: string; progress: number }
  | { status: 'error'; message: string }

export function IcaWorkbench({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [recipe, setRecipe] = useState<IcaRecipe>(() => structuredClone(defaultIcaRecipe))
  const [simulation, setSimulation] = useState<IcaSimulationResult | null>(null)
  const [fit, setFit] = useState<IcaFitResult | null>(null)
  const [applied, setApplied] = useState<IcaApplyResult | null>(null)
  const [selectedComponent, setSelectedComponent] = useState(0)
  const [excluded, setExcluded] = useState<number[]>([])
  const [truthVisible, setTruthVisible] = useState(false)
  const [view, setView] = useState<IcaView>('Component trace')
  const [pipeline, setPipeline] = useState<PipelineState>({ status: 'idle' })
  const [step, setStep] = useState(0)

  const hasPlantedBlink = recipe.blink_amplitude_uv > 0
  const lessonSteps = useMemo(() => hasPlantedBlink ? ICA_STEPS : ICA_STEPS.map((item, index) => {
    if (index === 0) return { ...item, description: '아티팩트를 심지 않은 센서 EEG를 만듭니다.' }
    if (index === 1) return { ...item, description: '어느 센서에도 깜박임이 없는지 확인합니다.' }
    if (index === 4) return { ...item, description: '제거할 성분이 있는지 판단합니다.' }
    if (index === 5) return { ...item, description: '불필요한 제거의 대가를 잽니다.' }
    return item
  }), [hasPlantedBlink])
  const component = fit?.components.find((item) => item.index === selectedComponent) ?? fit?.components[0]
  const isBusy = pipeline.status === 'generating' || pipeline.status === 'fitting' || pipeline.status === 'applying'
  const isComparison = Boolean(applied && view === 'Before / after')
  const comparisonChannelCount = fit && applied
    ? fit.compatibility.channel_names.filter((channel) => (
      applied.before_after_trace.series[`Before · ${channel}`]
      && applied.before_after_trace.series[`After · ${channel}`]
    )).length
    : 0
  const comparisonIsComplete = Boolean(fit && applied && comparisonChannelCount === fit.compatibility.channel_names.length)
  const comparisonNeedsRefresh = isComparison && !comparisonIsComplete
  const availableRank = fit?.compatibility.rank ?? simulation?.rank ?? (recipe.reference === 'average' ? 7 : 8)
  const excludedSummary = fit
    ? excluded.map((index) => {
      const item = fit.components.find((candidate) => candidate.index === index)
      return `IC ${String(index + 1).padStart(2, '0')}${item ? ` · ${item.suggested_label}` : ''}`
    }).join(', ')
    : ''

  function clearDecomposition() {
    setFit(null)
    setApplied(null)
    setExcluded([])
    setTruthVisible(false)
    setView('Component trace')
  }

  function updateInputRecipe<K extends 'blink_amplitude_uv' | 'sensor_noise_uv' | 'reference'>(key: K, value: IcaRecipe[K]) {
    setRecipe((current) => ({ ...current, [key]: value }))
    setSimulation(null)
    clearDecomposition()
    setStep(0)
  }

  function updateFitRecipe<K extends 'algorithm' | 'component_count'>(key: K, value: IcaRecipe[K]) {
    setRecipe((current) => ({ ...current, [key]: value }))
    clearDecomposition()
    setStep(simulation ? 1 : 0)
  }

  async function handleGenerate() {
    setPipeline({ status: 'generating', stage: '원천을 여덟 개 EEG 센서로 섞는 중', progress: 35 })
    clearDecomposition()
    try {
      const result = await simulateIca(recipe)
      setSimulation(result)
      setPipeline({ status: 'idle' })
      setStep(1)
    } catch (error) {
      setPipeline({ status: 'error', message: error instanceof Error ? error.message : 'EEG 시뮬레이션을 안전하게 멈췄습니다.' })
    }
  }

  async function handleFit() {
    if (!simulation) return
    setPipeline({ status: 'fitting', stage: `임시 ${recipe.fit_highpass_hz}–${recipe.fit_lowpass_hz} Hz 적합용 사본을 필터링하는 중`, progress: 20 })
    setApplied(null)
    setExcluded([])
    setTruthVisible(false)
    setStep(2)
    const timer = window.setInterval(() => {
      setPipeline((current) => {
        if (current.status !== 'fitting') return current
        const progress = Math.min(90, current.progress + 9)
        const stage = progress < 38
          ? '고역 통과 적합용 사본을 만드는 중'
          : progress < 67
            ? `${recipe.algorithm === 'infomax' ? 'extended Infomax' : 'FastICA'} 적합 중`
            : '시계열, 스펙트럼, 지형도를 추출하는 중'
        return { status: 'fitting', stage, progress }
      })
    }, 340)
    try {
      const result = await fitIca(recipe)
      window.clearInterval(timer)
      setFit(result)
      setSelectedComponent(0)
      setPipeline({ status: 'idle' })
      setStep(3)
    } catch (error) {
      window.clearInterval(timer)
      setPipeline({ status: 'error', message: error instanceof Error ? error.message : 'ICA 적합을 안전하게 멈췄습니다.' })
    }
  }

  function toggleExcluded(index: number) {
    setExcluded((current) => current.includes(index) ? current.filter((item) => item !== index) : [...current, index])
    setApplied(null)
    setStep(4)
  }

  async function handleApply() {
    if (!fit || !excluded.length) return
    setPipeline({ status: 'applying', stage: '적용 대상의 호환성을 확인하는 중', progress: 24 })
    setStep(4)
    const timer = window.setInterval(() => {
      setPipeline((current) => {
        if (current.status !== 'applying') return current
        const progress = Math.min(88, current.progress + 16)
        return {
          status: 'applying',
          stage: progress < 58 ? '직접 고른 제외를 적용하는 중' : '감쇠와 신경 신호 왜곡을 채점하는 중',
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
      setPipeline({ status: 'error', message: error instanceof Error ? error.message : 'ICA 적용을 안전하게 멈췄습니다.' })
    }
  }

  const hasTruthMatch = Boolean(component && component.matched_truth !== null && component.matched_correlation !== null)
  const activeMatch = truthVisible && component
    ? hasTruthMatch
      ? `${component.matched_truth} · r ${component.matched_correlation?.toFixed(2)}`
      : '심어 둔 원천 없음'
    : '공개 전까지 숨김'

  const scoreJudgement = useMemo(() => {
    if (!applied) return '제외를 직접 적용하면 복원 결과를 채점합니다.'
    if (!hasPlantedBlink) {
      return applied.neural_distortion_pct < 10
        ? '제외해도 거의 바뀌지 않았지만, 애초에 되찾을 아티팩트가 없었습니다.'
        : '아티팩트가 없는데도 제외 때문에 깨끗한 시뮬레이션 신호가 지워졌습니다.'
    }
    if (applied.artifact_attenuation_db > 25 && applied.neural_distortion_pct < 20) {
      return '알려진 깨끗한 신호를 비교적 적게 바꾸면서 깜박임 관련 패턴을 크게 줄였습니다.'
    }
    return '대가를 따져 봐야 합니다. 감쇠만으로는 충분하지 않습니다.'
  }, [applied, hasPlantedBlink])

  return (
    <>
      <main className="workspace ica-workspace">
        <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={lessonSteps} step={step} />

        <aside className="control-panel ica-controls">
          <div className="panel-heading">
            <span className="eyebrow">전처리 · 안내 실습</span>
            <h1>어느 성분이<br />눈 깜박임인가?</h1>
            <p>정답을 아는 EEG를 만들어 살펴본 뒤, ICA를 적합하고 제외할 성분을 고릅니다.</p>
          </div>

          <section className="rank-block">
            <div><ShieldCheck size={16} /><span>독립 차원 수(rank)</span></div>
            <strong>{availableRank}<small> ICA가 쓸 수 있음</small></strong>
            <p>{recipe.reference === 'average' ? '기록 채널 8개. 평균 기준이 제약 하나를 더해 독립 차원은 7개가 남습니다.' : '기록 채널 8개. 기준전극 제약이 없습니다.'}</p>
          </section>

          <section className="control-section">
            <div className="section-title"><span>시뮬레이션 EEG</span><small>1단계</small></div>
            <IcaRange label="깜박임 진폭(Blink amplitude)" ariaLabel="Blink amplitude" help="심어 둔 눈 깜박임 아티팩트의 크기입니다. 클수록 찾기 쉽지만 분해 결과를 지배할 수 있습니다." value={recipe.blink_amplitude_uv} min={0} max={160} step={10} unit="µV" onChange={(value) => updateInputRecipe('blink_amplitude_uv', value)} />
            <IcaRange label="센서 잡음(Sensor noise)" ariaLabel="Sensor noise" help="센서마다 더해지는 무작위 전압입니다. 잡음이 크면 성분 패턴과 아티팩트 판별을 믿기 어려워집니다." value={recipe.sensor_noise_uv} min={0} max={4} step={0.25} unit="µV" onChange={(value) => updateInputRecipe('sensor_noise_uv', value)} />
            <div className="preset-row">
              <button className={recipe.blink_amplitude_uv === 90 ? 'selected' : ''} onClick={() => updateInputRecipe('blink_amplitude_uv', 90)}>깜박임 심기</button>
              <button className={recipe.blink_amplitude_uv === 0 ? 'selected' : ''} onClick={() => updateInputRecipe('blink_amplitude_uv', 0)}>아티팩트 없는 대조군</button>
            </div>
            <div className="segmented-field stack">
              <span className="control-label">EEG 기준전극(Reference)<ControlHint>평균 기준은 생성된 센서 신호를 바꾸고, 기록 채널 8개에서 독립 차원 7개를 남깁니다.</ControlHint></span>
              <div role="group" aria-label="EEG reference">
                <button className={recipe.reference === 'average' ? 'selected' : ''} onClick={() => updateInputRecipe('reference', 'average')}>평균(Average)</button>
                <button className={recipe.reference === 'none' ? 'selected' : ''} onClick={() => updateInputRecipe('reference', 'none')}>없음(None)</button>
              </div>
            </div>
            <button className={simulation ? 'generate-button' : 'primary-button generate-button'} onClick={handleGenerate} disabled={isBusy}>
              <FlaskConical size={16} /> {simulation ? '시뮬레이션 EEG 다시 생성' : '시뮬레이션 EEG 생성(Generate)'}
            </button>
          </section>

          <section className="control-section">
            <div className="section-title"><span>ICA 설정</span><small>2단계</small></div>
            <div className="fit-copy-note">
              <span>ICA에 쓰는 자료</span>
              <strong>{recipe.fit_highpass_hz.toFixed(0)}–{recipe.fit_lowpass_hz.toFixed(0)} Hz</strong>
              <small>ICA는 필터링한 사본에서 추정합니다. 생성한 EEG는 덮어쓰지 않습니다.</small>
            </div>
            <div className="segmented-field stack">
              <span className="control-label">알고리즘(Algorithm)<ControlHint>ICA 최적화 방법을 고릅니다. 두 방법 모두 통계적으로 독립인 성분을 추정하지만, 서로 다른 분해로 수렴할 수 있습니다.</ControlHint></span>
              <div role="group" aria-label="ICA algorithm">
                <button className={recipe.algorithm === 'infomax' ? 'selected' : ''} onClick={() => updateFitRecipe('algorithm', 'infomax')}>Ext. Infomax</button>
                <button className={recipe.algorithm === 'fastica' ? 'selected' : ''} onClick={() => updateFitRecipe('algorithm', 'fastica')}>FastICA</button>
              </div>
            </div>
            <IcaRange label="성분 수(Components)" ariaLabel="Components" help={`ICA가 추정할 성분 수입니다. 현재 EEG의 독립 차원은 ${availableRank}개이므로 그보다 많이 추정할 수 없습니다.`} value={recipe.component_count} min={3} max={7} step={1} unit="개" onChange={(value) => updateFitRecipe('component_count', value)} />
            {!simulation && <p className="fit-prerequisite">ICA를 적합하기 전에 시뮬레이션 EEG를 생성해 살펴보세요.</p>}
            <button className="primary-button fit-button" onClick={handleFit} disabled={!simulation || isBusy}>
              <Split size={16} /> {fit ? 'ICA 다시 적합' : '생성한 EEG에 ICA 적합(Fit ICA)'}
            </button>
          </section>
        </aside>

        <section className="canvas-panel ica-canvas">
          <div className="canvas-toolbar ica-toolbar">
            <div>
              <span className="eyebrow">{isComparison ? '복원 비교' : fit ? '성분 작업대' : simulation ? '생성한 입력' : 'ICA 실습'}</span>
              <h2>{comparisonNeedsRefresh ? '처리 전 / 후 · 다시 만들어야 함' : isComparison ? '정리한 EEG · 8채널 처리 전 / 후' : component ? `IC ${String(component.index + 1).padStart(2, '0')} · 제외 전에 살펴보기` : simulation ? '시뮬레이션 EEG · ICA 전에 살펴보기' : '먼저 EEG를 생성하세요'}</h2>
            </div>
            {fit && <div className="view-tabs" role="tablist" aria-label="ICA visualization type">
              {(['Component trace', 'Component spectrum', 'Before / after'] as IcaView[]).map((item) => (
                <button key={item} role="tab" aria-selected={item === view} className={item === view ? 'active' : ''} disabled={item === 'Before / after' && !applied} onClick={() => setView(item)}>{ICA_VIEW_LABELS[item]}</button>
              ))}
            </div>}
          </div>

          <div className="ica-stage">
            {isBusy && (
              <div className="run-overlay" role="status" aria-live="polite">
                <div className="orbit"><Activity size={26} /></div>
                <span className="eyebrow">{pipeline.status === 'generating' ? 'EEG 시뮬레이션' : 'ICA 파이프라인'}</span>
                <h3>{pipeline.stage}</h3>
                <div className="progress-track"><i style={{ width: `${pipeline.progress}%` }} /></div>
                <p>{pipeline.progress}% · seed {recipe.seed}{pipeline.status === 'generating' ? '' : ` · ${recipe.algorithm}`}</p>
              </div>
            )}
            {pipeline.status === 'error' && (
              <div className="empty-stage error-stage">
                <AlertTriangle size={30} /><h3>현재 단계를 마치지 못했습니다</h3><p>{pipeline.message}</p>
                <button className="quiet-button" onClick={() => setPipeline({ status: 'idle' })}><X size={14} /> 닫기</button>
              </div>
            )}
            {!simulation && pipeline.status === 'idle' && (
              <div className="ica-start-state">
                <section>
                  <span className="eyebrow">1단계 · 입력 준비</span>
                  <h3>정리할 EEG부터 만듭니다.</h3>
                  <p>{hasPlantedBlink ? '왼쪽 설정은 신경 원천 세 개와 깜박임 하나를 만들어 센서 채널 여덟 개로 섞습니다.' : '대조군 설정은 깜박임 없이 신경 원천 세 개를 만들어 센서 채널 여덟 개로 섞습니다.'} ICA를 적합하기 전에 이 신호를 생성하세요.</p>
                  <dl className="ica-input-spec">
                    <div><dt>원천</dt><dd>{hasPlantedBlink ? '알파 · 세타 · 베타 · 깜박임' : '알파 · 세타 · 베타 · 아티팩트 없음'}</dd></div>
                    <div><dt>센서</dt><dd>EEG 8채널</dd></div>
                    <div><dt>길이</dt><dd>{recipe.duration_s.toFixed(0)} s · {recipe.sampling_rate_hz} Hz</dd></div>
                    <div><dt>기준전극</dt><dd>{recipe.reference === 'average' ? '평균(Average)' : '없음(None)'}</dd></div>
                  </dl>
                </section>
                <section className="ica-guide" aria-labelledby="ica-guide-title">
                  <span className="eyebrow">실습 안내</span>
                  <h4 id="ica-guide-title">네 단계로 신호를 따라갑니다.</h4>
                  <ol className="ica-sequence" aria-label="ICA 실습 순서">
                    <li><small>01</small><strong>설정하고 생성하기</strong><span>아티팩트, 잡음, 기준전극을 정한 뒤 센서 EEG를 만듭니다.</span></li>
                    <li><small>02</small><strong>센서 EEG 살펴보기</strong><span>{hasPlantedBlink ? '여덟 채널 전체에서 심어 둔 깜박임을 찾습니다.' : '어느 채널에도 깜박임이 없는지 확인합니다.'}</span></li>
                    <li><small>03</small><strong>ICA 적합하고 살펴보기</strong><span>복사한 자료에 적합하고 성분마다 증거를 비교합니다.</span></li>
                    <li><small>04</small><strong>제외하고 비교하기</strong><span>성분을 직접 표시해 적용하고, 얻은 것과 잃은 것을 따져 봅니다.</span></li>
                  </ol>
                </section>
              </div>
            )}
            {simulation && !fit && pipeline.status === 'idle' && (
              <div className="simulated-eeg-view">
                <div className="simulation-summary">
                  <span><small>EEG 브라우저</small>{simulation.channel_names.length}채널 · 공통 이득</span>
                  <span><small>심어 둔 아티팩트</small>{hasPlantedBlink ? `${recipe.blink_amplitude_uv} µV 깜박임` : '없음'}</span>
                  <p>{hasPlantedBlink ? '같은 시간 구간을 모든 센서에서 비교하세요. 앞쪽(전두부) 채널에서 깜박임이 가장 크게 보여야 합니다.' : '깜박임을 더하지 않은 깨끗한 대조군입니다. ICA를 적합하기 전에 센서 잡음을 살펴보세요.'}</p>
                </div>
                <StackedEegBrowser
                  x={simulation.sensor_trace.x}
                  series={simulation.sensor_trace.series}
                  ariaLabel="Eight-channel simulated contaminated EEG browser"
                />
              </div>
            )}
            {fit && pipeline.status === 'idle' && (
              <>
                {!isComparison && <div className="component-strip" aria-label="ICA 성분">
                  {fit.components.map((item) => (
                    <button
                      key={item.index}
                      className={`${item.index === selectedComponent ? 'active' : ''} ${excluded.includes(item.index) ? 'excluded' : ''}`}
                      onClick={() => setSelectedComponent(item.index)}
                    >
                      <span>IC {String(item.index + 1).padStart(2, '0')}</span>
                      <strong>{item.suggested_label}</strong>
                      <small>{Math.round(item.suggestion_probability * 100)}% 참고</small>
                      {excluded.includes(item.index) && <em><Trash2 size={11} /> 제외</em>}
                    </button>
                  ))}
                </div>}
                {isComparison && <div className="repair-summary">
                  <span><small>적용한 제외</small><strong>{excludedSummary}</strong></span>
                  <p>{comparisonNeedsRefresh ? `저장된 결과에는 ${fit.compatibility.channel_names.length}채널 중 ${comparisonChannelCount}채널만 있습니다.` : '성분 판단을 마쳤습니다. 아래에서 모든 센서에 미친 효과를 확인하세요.'}</p>
                </div>}
                <div className="component-detail">
                  {component && view !== 'Before / after' && (
                    <div className="component-visual">
                      <div className="topography-panel">
                        <ScalpTopography values={component.topography} label={`IC ${component.index + 1}`} />
                        <p className="topography-caption">센서별 상대 가중치 · 청록 + / 주황 − · 극성은 뒤집힐 수 있음</p>
                        <div className="variance-readout">
                          <small>설명한 EEG 분산</small>
                          <strong>{component.explained_variance_pct.toFixed(1)}%</strong>
                          <p>필터링한 8채널 적합용 사본 EEG의 분산 중 이 성분 하나가 설명하는 비율입니다.</p>
                        </div>
                      </div>
                      <div className="component-chart">
                        {view === 'Component trace' ? (
                          <StackedEegBrowser key={component.index} x={component.time_s} series={{ [`IC ${component.index + 1}`]: component.trace }} unit="a.u." ariaLabel={`Time course for ICA component ${component.index + 1}`} />
                        ) : (
                          <LineChart x={component.frequency_hz} series={[{ label: `IC ${component.index + 1} PSD`, values: component.power, color: '#087f83' }]} xDomain={[0, 80]} xLabel="주파수(Hz)" yLabel="파워 (log a.u.)" ariaLabel={`Power spectrum for ICA component ${component.index + 1}`} logY />
                        )}
                      </div>
                    </div>
                  )}
                  {applied && view === 'Before / after' && comparisonIsComplete && (
                    <StackedEegComparison
                      x={applied.before_after_trace.x}
                      series={applied.before_after_trace.series}
                      channelNames={fit.compatibility.channel_names}
                      ariaLabel="Eight-channel EEG before and after ICA repair"
                    />
                  )}
                  {applied && view === 'Before / after' && !comparisonIsComplete && (
                    <div className="stale-comparison" role="alert">
                      <AlertTriangle size={30} />
                      <span className="eyebrow">불완전한 비교 자료</span>
                      <h3>이전 결과에는 {fit.compatibility.channel_names.length}채널 중 {comparisonChannelCount}채널만 있습니다.</h3>
                      <p>현재 분석 서버로 다시 만들어 모든 센서에서 처리 전·후 EEG를 비교하세요.</p>
                      <button className="primary-button" onClick={handleApply} disabled={isBusy}><RefreshCw size={15} /> 8채널 비교 다시 만들기</button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="canvas-readout ica-readout">
            <div><small>시뮬레이션 입력</small><strong>{simulation ? `EEG ${simulation.channel_names.length}채널` : '생성 전'}</strong></div>
            <div><small>ICA 모델</small><strong>{fit ? `성분 ${fit.components.length}개` : '적합 전'}</strong></div>
            <div><small>제외</small><strong>{excluded.length ? excluded.map((index) => `IC ${index + 1}`).join(', ') : '없음'}</strong></div>
            <div><small>결과</small><strong>{comparisonNeedsRefresh ? '다시 만들어야 함' : applied ? `${applied.artifact_attenuation_db.toFixed(1)} dB · 보존율 ${applied.neural_retention_pct.toFixed(0)}%` : '적용 전'}</strong></div>
          </div>
        </section>

        <aside className="inspector-panel ica-inspector">
          <section className="inspector-lead">
            <span className="eyebrow">{isComparison ? '복원 결과' : component ? '성분 판단' : simulation ? '센서 살펴보기' : 'ICA 전'}</span>
            <h2>{comparisonNeedsRefresh ? '이 결과를 다시 만드세요.' : isComparison ? '모든 센서를 확인하세요.' : component ? `IC ${String(component.index + 1).padStart(2, '0')}` : simulation ? '섞인 EEG를 보세요.' : '입력을 생성하세요.'}</h2>
            <p>{comparisonNeedsRefresh ? '표시된 결과는 Fp1만 담긴 이전 응답입니다. 복원을 해석하기 전에 다시 만드세요.' : isComparison ? hasPlantedBlink ? '회색 점선은 생성한 입력, 청록 실선은 정리한 출력입니다. 좋은 복원은 관련 없는 EEG를 평평하게 만들지 않고 깜박임만 줄입니다.' : '회색 점선은 깨끗한 대조군 입력, 청록 실선은 제외 후 결과입니다. 바뀐 부분은 모두 아티팩트 복원이 아니라 제거의 대가입니다.' : component ? '시계열, 스펙트럼, 지형도, 참고 라벨을 함께 보세요. 단서 하나로는 부족합니다.' : simulation ? hasPlantedBlink ? '깜박임은 앞쪽 센서에 가장 크게 심어져 있습니다. ICA로 분리하기 전에 EEG를 먼저 살펴보세요.' : '깜박임을 심지 않았습니다. ICA로 분해하기 전에 대조군 EEG를 살펴보세요.' : '왼쪽에서 아티팩트와 기준전극을 정하세요. 첫 결과는 ICA 성분이 아니라 센서 EEG입니다.'}</p>
          </section>

          {component && !isComparison && (
            <section className="advisory-block">
              <div><Sparkles size={16} /><span>ICLabel 제안</span><small>참고용</small></div>
              <strong>{component.suggested_label}</strong>
              <p>예측 확률 {Math.round(component.suggestion_probability * 100)}% · 자동으로 선택하지 않음</p>
              <button className={excluded.includes(component.index) ? 'remove-exclusion' : 'mark-exclusion'} onClick={() => toggleExcluded(component.index)}>
                {excluded.includes(component.index) ? <><X size={15} /> 이 성분 남기기</> : <><Trash2 size={15} /> 제외로 표시(Mark for exclusion)</>}
              </button>
            </section>
          )}

          {fit && !isComparison && <section className={`truth-block ${truthVisible ? 'revealed' : ''}`}>
            <div className="truth-heading"><span><EyeOff size={16} /> 성분 정답(Truth)</span><span className="truth-state">{truthVisible ? '공개됨' : '숨김'}</span></div>
            {truthVisible && component ? (
              <div className="truth-content">
                <div className="truth-match"><small>{hasTruthMatch ? '대응하는 원천' : '대응 결과'}</small><strong>{activeMatch}</strong></div>
                <p>{hasTruthMatch ? '최적 일대일 배정 후 원천과의 상관 절댓값으로 대응시켰습니다. 시뮬레이션이라서 가능한 확인입니다.' : '이 성분에 대응하는 심어 둔 원천이 없습니다. 깜박임이 아니라 남은 센서 잡음이나 분해 잔여분입니다.'}</p>
              </div>
            ) : (
              <div className="truth-covered">
                <div className="blur-lines"><i /><i /><i /></div>
                <button className="reveal-button" disabled={!fit} onClick={() => setTruthVisible(true)}><Eye size={16} /> 원천 정체 공개(Reveal)</button>
              </div>
            )}
          </section>}

          {!isComparison && fit?.warnings.map((warning) => (
            <section className={`warning-card ${warning.severity}`} key={warning.code}>
              <div><AlertTriangle size={16} /><strong>{warning.title}</strong></div><p>{warning.explanation}</p>
            </section>
          ))}

          {applied && isComparison && comparisonIsComplete && (
            <section className="score-block">
              <span className="eyebrow">정답 기준 점수 · 시뮬레이션에서만</span>
              <div className="score-metric">
                <strong>{hasPlantedBlink ? applied.artifact_attenuation_db.toFixed(1) : applied.neural_distortion_pct.toFixed(1)}<small>{hasPlantedBlink ? ' dB' : '%'}</small></strong>
                <span><b>{hasPlantedBlink ? '깜박임 관련 파워 감소' : '불필요하게 지운 신호'}</b><small>{hasPlantedBlink ? '심어 둔 깜박임과 일치하는 신호가 센서 전체에서 줄어든 정도(로그 척도)입니다. 10 dB는 파워가 1/10이 되었다는 뜻입니다.' : '알려진 깨끗한 시뮬레이션 대비 RMS 변화입니다. 아티팩트가 없으니 낮을수록 좋습니다.'}</small></span>
              </div>
              <div className="score-metric">
                <strong>{applied.neural_retention_pct.toFixed(1)}<small>%</small></strong>
                <span><b>깨끗한 신호 보존율</b><small>100%에서 알려진 깨끗한 시뮬레이션 대비 RMS 변화를 뺀 값입니다. 실제 EEG만으로는 잴 수 없습니다.</small></span>
              </div>
              <p className="score-judgement">{scoreJudgement}</p>
            </section>
          )}

          {fit && !isComparison && <button className="primary-button apply-button" disabled={!excluded.length || isBusy} onClick={handleApply}>
            <WandSparkles size={16} /> 제외 {excluded.length || 0}개 적용(Apply)
          </button>}
          <div className="nonclinical"><AlertTriangle size={15} /><span>ICLabel은 참고용입니다. 교육·연구용입니다.</span></div>
        </aside>
      </main>

      <footer className="run-strip ica-run-strip">
        <div className="run-strip-title"><SlidersHorizontal size={16} /><span>현재 파이프라인</span></div>
        <div className="ica-contract-flow">
          <span className={simulation ? 'verified' : ''}><small>입력</small>{simulation ? '8채널 EEG 준비됨' : '생성 전'}</span><i />
          <span className={fit ? 'verified' : ''}><small>ICA 적합</small>{fit ? `성분 ${fit.components.length}개 · ${recipe.algorithm}` : `${recipe.fit_highpass_hz}–${recipe.fit_lowpass_hz} Hz · 대기`}</span><i />
          <span className={excluded.length ? 'verified' : ''}><small>직접 판단</small>{excluded.length ? `성분 ${excluded.length}개 선택` : '제외 없음'}</span><i />
          <span className={applied?.compatibility_verified ? 'verified' : ''}><small>출력</small>{applied?.compatibility_verified ? '정리한 사본 준비됨' : '적용 전'}</span>
        </div>
        <div className="strip-actions"><button onClick={() => updateInputRecipe('blink_amplitude_uv', 90)}><FlaskConical size={14} /> 깜박임 다시 심기</button></div>
      </footer>
    </>
  )
}

function IcaRange({ label, ariaLabel, help, value, min, max, step, unit, onChange }: { label: string; ariaLabel: string; help: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void }) {
  const progress = ((value - min) / (max - min)) * 100
  return (
    <label className="range-control">
      <span><span className="control-label">{label}<ControlHint>{help}</ControlHint></span><output>{value} {unit}</output></span>
      <input type="range" aria-label={ariaLabel} min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} style={{ '--range-progress': `${progress}%` } as React.CSSProperties} />
      <small><span>{min}</span><span>{max}</span></small>
    </label>
  )
}
