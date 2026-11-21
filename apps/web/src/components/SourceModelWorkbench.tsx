import { useState } from 'react'
import { AlertTriangle, BrainCircuit, CircleHelp, Crosshair, Eye, Play, ScanLine, Waves } from 'lucide-react'
import { runSourceModel, simulateSourceModel } from '../lib/api'
import { defaultSourceModelRecipe, type SourceModelRecipe, type SourceModelResult, type SourceModelSimulation } from '../types'
import { ControlHint } from './ControlHint'
import { LookHere, PredictionChoices, PredictionFeedback, TryThisList } from './LessonPanels'
import { SOURCE_BASELINE_PREDICTION, SOURCE_EXPERIMENTS, summarizeSourceResult } from '../lessons/sourceLesson'
import { useGradedLesson } from '../lessons/useGradedLesson'
import { LabNavigator, type LabId } from './LabNavigator'
import { StackedEegBrowser } from './StackedEegBrowser'
import { CandidateForwardMap, CandidateTraces, coordinates, SourcePowerView, TruthDiagnostics } from './SourcePowerViews'
import './source-localization.css'

const STEPS = [
  { label: '예측(Predict)', description: '원천들이 서로 구별될까?', icon: CircleHelp },
  { label: '생성(Generate)', description: '심어 둔 전류를 두피 EEG로 투영합니다.', icon: Waves },
  { label: '추정(Estimate)', description: '후보 지점마다 전류를 추정합니다.', icon: BrainCircuit },
  { label: '살펴보기(Inspect)', description: '정답 없이 파워 봉우리를 찾습니다.', icon: ScanLine },
  { label: '공개(Reveal)', description: '놓친 원천과 짝 없는 봉우리를 셉니다.', icon: Eye },
] as const
const VIEWS = ['Sensor EEG', 'Power map', 'Candidate trace', 'Forward map', 'Truth diagnostics'] as const
type View = typeof VIEWS[number]
const VIEW_LABELS: Record<View, string> = { 'Sensor EEG': '센서 EEG', 'Power map': '파워 지도', 'Candidate trace': '후보 전류', 'Forward map': '순방향 지도', 'Truth diagnostics': '정답 진단' }
const GUIDES: Record<View, [string, string]> = {
  'Sensor EEG': ['이 14개 파형은 원천 전류가 섞인 것입니다.', '순방향 모형(forward model)이 뇌 안의 원천을 두피 전극 전체로 섞고, 잡음을 더한 뒤 평균 기준을 적용합니다. 원천은 모든 채널을 함께 써서 추정합니다. 센서 파형이 크다고 원천이 그 아래에 있는 것은 아닙니다.'],
  'Power map': ['재구성한 파워는 어디에 모이는가?', 'Minimum norm이 모든 후보 전류를 추정하고, 고정된 세타·알파·베타 대역으로 파워를 요약합니다. 검출기는 공간 극댓값과 내가 정한 임계값만 씁니다. 심어 둔 파형, 위치, 원천 수는 받지 않습니다.'],
  'Candidate trace': ['아무 후보 위치의 전류나 살펴보세요.', '좌표로 후보를 고르거나 파워 지도의 점을 누르세요. 이 파형은 EEG에서 재구성한 것이며, 그 지점에 진짜 원천이 없어도 만들어집니다.'],
  'Forward map': ['이 후보는 센서에 어떤 패턴을 만들까?', '이 lead field는 EEG를 보기 전에 정해지는, 선택한 후보의 센서 패턴입니다. 서로 다른 후보의 패턴이 비슷하면 역문제가 그 위치들을 혼동하는 이유가 됩니다.'],
  'Truth diagnostics': ['정답으로 끝난 추정을 평가합니다.', '이 진단은 알려진 심은 좌표를 씁니다. 봉우리를 고르지는 않습니다. 파형 일치를 해석하기 전에 파워 지도에서 놓친 원천과 짝 없는 봉우리를 먼저 보세요.'],
}

export function SourceModelWorkbench({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [recipe, setRecipe] = useState<SourceModelRecipe>(() => structuredClone(defaultSourceModelRecipe))
  const [simulation, setSimulation] = useState<SourceModelSimulation | null>(null)
  const [result, setResult] = useState<SourceModelResult | null>(null)
  const [view, setView] = useState<View>('Sensor EEG')
  const [bandId, setBandId] = useState('alpha')
  const [selected, setSelected] = useState(0)
  const [truthVisible, setTruthVisible] = useState(false)
  const [busy, setBusy] = useState<'generate' | 'estimate' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lesson = useGradedLesson({ storageKey: 'neurosignal-lab04-completed-experiments', experiments: SOURCE_EXPERIMENTS, baseline: SOURCE_BASELINE_PREDICTION, defaultRecipe: defaultSourceModelRecipe as SourceModelRecipe })
  const showLookHere = Boolean(result && lesson.active && lesson.lockedIn?.experimentId === lesson.activeId && lesson.onCard(lesson.lockedIn.recipe))
  const band = result?.power_maps.find((b) => b.id === bandId) ?? result?.power_maps[0]
  const count = simulation?.candidate_positions_mm.length ?? (recipe.grid_spacing_mm === 20 ? 250 : 26)
  const step = truthVisible ? 4 : result ? 3 : simulation ? 2 : busy === 'generate' ? 1 : 0

  function clearEstimate() {
    setResult(null); setTruthVisible(false); setView('Sensor EEG'); setError(null)
  }
  function updateSimulation<K extends keyof SourceModelRecipe>(key: K, value: SourceModelRecipe[K]) {
    setRecipe((current) => ({ ...current, [key]: value }))
    setSimulation(null); clearEstimate()
  }
  function updateInverse(key: keyof SourceModelRecipe['inverse'], value: number) {
    setRecipe((current) => ({ ...current, inverse: { ...current.inverse, [key]: value } }))
    clearEstimate()
  }
  async function generate() {
    setBusy('generate'); setSimulation(null); clearEstimate()
    try { setSimulation(await simulateSourceModel(recipe)) }
    catch (e) { setError(e instanceof Error ? e.message : 'EEG 생성에 실패했습니다.') }
    finally { setBusy(null) }
  }
  async function estimate() {
    if (!simulation) return
    setBusy('estimate'); clearEstimate()
    lesson.lockIn(recipe)
    try {
      // The same seeded input is reproduced; inverse settings never change sensor EEG.
      const data = await runSourceModel({ ...simulation.recipe, inverse: recipe.inverse })
      setResult(data); setBandId('alpha'); setView('Power map')
      const alpha = data.power_maps.find((item) => item.id === 'alpha')!
      setSelected(alpha.peaks[0]?.vertex_index ?? alpha.power_nam2.indexOf(Math.max(...alpha.power_nam2)))
    } catch (e) { setError(e instanceof Error ? e.message : '원천 추정에 실패했습니다.') }
    finally { setBusy(null) }
  }
  function selectExperiment(id: string | null) {
    setRecipe(lesson.select(id))
    setSimulation(null); clearEstimate()
  }
  function reveal() {
    lesson.reveal()
    setTruthVisible(true); setView('Power map')
  }
  function chooseBand(id: string) {
    setBandId(id)
    const next = result!.power_maps.find((item) => item.id === id)!
    setSelected(next.peaks[0]?.vertex_index ?? next.power_nam2.indexOf(Math.max(...next.power_nam2)))
  }

  return <>
    <main className="workspace source-workspace">
      <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={STEPS} step={step} />
      <aside className="control-panel source-controls">
        <div className="panel-heading"><span className="eyebrow">원천 국소화 · 안내 실습</span><h1>EEG로 원천까지<br />거슬러 갈 수 있는가?</h1><p>먼저 추정합니다. 그다음 무엇이 옮겨 갔고, 합쳐졌고, 사라졌는지 잽니다.</p></div>
        <TryThisList items={SOURCE_EXPERIMENTS} activeId={lesson.activeId} completed={lesson.completed} disabled={!!busy} onSelect={selectExperiment} baselineNote="위상 지연 55° · 잡음 0.08 µV · λ² 0.111" />
        <PredictionChoices prediction={lesson.prediction} answer={lesson.answer} onAnswer={lesson.setAnswer} reason={lesson.reason} onReason={lesson.setReason} locked={!!busy} reasonPlaceholder="예: 잡음이 커지면 가짜 극댓값이 생긴다" />
        <section className="control-section"><div className="section-title"><span>신호 생성하기</span></div>
          <SourceRange label="알파 위상 지연(Alpha phase lag)" ariaLabel="Alpha phase lag" help="앞쪽 두 10 Hz 전류 사이의 시간 차이입니다. 0°이면 동기화되어 공간적 기여를 떼어 내기 어려워집니다." value={recipe.phase_lag_deg} min={0} max={180} step={5} unit="°" disabled={!!busy} onChange={(v) => updateSimulation('phase_lag_deg', v)} />
          <SourceRange label="원천 진폭(Source amplitude)" ariaLabel="Source amplitude" help="심어 둔 기준 전류(nAm)입니다. 나머지 원천은 이 값의 88%, 58%, 42%로 유지됩니다." value={recipe.source_amplitude_nam} min={5} max={50} step={1} unit="nAm" disabled={!!busy} onChange={(v) => updateSimulation('source_amplitude_nam', v)} />
          <SourceRange label="센서 잡음(Sensor noise)" ariaLabel="Sensor noise" help="평균 기준 전에 더하는 독립 전압 잡음입니다. 심은 원천과 무관한 강한 파워 봉우리를 만들어 낼 수 있습니다." value={recipe.sensor_noise_uv} min={0} max={5} step={0.01} unit="µV" disabled={!!busy} onChange={(v) => updateSimulation('sensor_noise_uv', v)} />
          <label className="source-select">후보 격자(Candidate grid)<ControlHint>격자 간격은 표현할 수 있는 위치를 정할 뿐, 실제 국소화 정확도를 정하지 않습니다. 두 선택 모두 같은 네 개의 심은 좌표를 씁니다.</ControlHint><select aria-label="Candidate grid spacing" value={recipe.grid_spacing_mm} disabled={!!busy} onChange={(e) => updateSimulation('grid_spacing_mm', Number(e.target.value) as 20 | 40)}><option value="20">20 mm · 후보 250개</option><option value="40">40 mm · 후보 26개</option></select></label>
          <p className="source-reading-note">두피 전극 14개 · 반지름 90 mm 구. 평균 기준 후 독립 측정값은 최대 13개입니다.</p>
          <button className="primary-button" disabled={!!busy} onClick={generate}><Play size={15} /> 1 · 센서 EEG 생성(Generate)</button>
        </section>
        <section className="control-section"><div className="section-title"><span>EEG에서 추정하기</span></div>
          <label className="source-select">정규화(Regularization) λ²<ControlHint>Minimum norm은 전체 전류가 작은 해를 고릅니다. λ²를 키우면 약하거나 잡음 많은 성분이 눌리고 퍼짐이 바뀝니다. 작은 값이 더 나은 위치를 보장하지는 않습니다.</ControlHint><select aria-label="Inverse regularization" value={recipe.inverse.lambda2} disabled={!!busy} onChange={(e) => updateInverse('lambda2', Number(e.target.value))}><option value={0.01}>0.01 · 약함</option><option value={1 / 9}>0.111 · 기본</option><option value={1}>1 · 강함</option><option value={10}>10 · 매우 강함</option></select></label>
          <SourceRange label="봉우리 임계값(Peak threshold)" ariaLabel="Peak threshold" help="대역마다 가장 강한 지점 대비 최소 파워 비율입니다. 기술적 기준선일 뿐 유의성 검정이나 확률이 아닙니다. 봉우리 수는 정해져 있지 않습니다." value={recipe.inverse.peak_threshold * 100} min={5} max={100} step={5} unit="%" disabled={!!busy} onChange={(v) => updateInverse('peak_threshold', v / 100)} />
          <SourceRange label="봉우리 간격(Peak separation)" ariaLabel="Peak separation" help="강한 극댓값부터 남기고 이 거리보다 가까운 봉우리는 지웁니다. 간격을 크게 하면 진짜 원천 둘이 봉우리 하나로 합쳐질 수 있습니다." value={recipe.inverse.peak_separation_mm} min={20} max={100} step={10} unit="mm" disabled={!!busy} onChange={(v) => updateInverse('peak_separation_mm', v)} />
          {!lesson.ready && <p className="run-prerequisite">위에서 예측을 고르거나 "예측 없이 진행"을 누르면 추정할 수 있습니다.</p>}
          <button className="source-estimate-button" disabled={!simulation || !!busy || !lesson.ready} onClick={estimate}><Crosshair size={15} /> 2 · 원천 추정(Estimate)</button>
          <p className="source-reading-note">이 설정은 생성한 EEG를 그대로 씁니다. 바꾸면 이전 추정과 정답 공개가 지워집니다.</p>
        </section>
      </aside>

      <section className="canvas-panel source-canvas">
        <div className="canvas-toolbar source-toolbar"><div><span className="eyebrow"><span className="data-kind simulated">시뮬레이션 · 정답을 앎</span> 센서 EEG → 후보 전류 → 파워 봉우리 → 공개</span><h2>{result ? `후보 전류 ${count}개 추정 · 원천 수를 미리 정하지 않음` : simulation ? '센서 EEG 준비됨 · 역해 계산 전' : '순방향 시뮬레이션부터 시작하세요'}</h2></div>
          <div className="view-tabs" role="tablist" aria-label="원천 모델링 시각화 종류">{VIEWS.map((item) => <button key={item} role="tab" aria-selected={view === item} className={view === item ? 'active' : ''} disabled={!!busy || (item === 'Sensor EEG' ? !simulation : !result) || (item === 'Truth diagnostics' && !truthVisible)} title={item} onClick={() => setView(item)}>{VIEW_LABELS[item]}</button>)}</div>
        </div>
        <div className="source-stage">
          {busy ? <div className="empty-stage" role="status"><BrainCircuit size={30} /><h3>{busy === 'generate' ? '네 전류를 두피 EEG로 투영하는 중…' : '모든 후보를 재구성하고 공간 파워 봉우리를 찾는 중…'}</h3><p>{busy === 'estimate' ? '추정기에는 EEG, 순방향 기하, 분석 설정만 들어갑니다.' : '재현 가능한 입력을 만드는 중입니다.'}</p></div>
            : error ? <div className="empty-stage error-stage" role="alert"><AlertTriangle /><h3>실행을 마치지 못했습니다</h3><p>{error}</p><button onClick={simulation ? estimate : generate}>다시 시도</button></div>
            : !simulation ? <SourceIntroduction count={count} recipe={recipe} />
            : <div className="source-result-view">
              <div className="source-view-guide"><div><h3>{GUIDES[view][0]}</h3><p>{GUIDES[view][1]}</p></div>{!result && <button disabled={!lesson.ready} onClick={estimate}>이 EEG에서 추정하기</button>}</div>
              {result && band && view !== 'Sensor EEG' && view !== 'Truth diagnostics' && <div className="source-analysis-toolbar">
                <label className="source-select">주파수 대역<select aria-label="Source frequency band" value={band.id} onChange={(e) => chooseBand(e.target.value)}>{result.power_maps.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <label className="source-select">후보 살펴보기(Inspect candidate)<select aria-label="Inspect source candidate" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>{result.candidate_positions_mm.map((position, i) => <option key={i} value={i}>v{i} · {coordinates(position)} mm</option>)}</select></label>
              </div>}
              {showLookHere && lesson.active && <LookHere>{lesson.active.lookAt}</LookHere>}
              <div className={'source-view-body ' + (view === 'Sensor EEG' ? 'sensor-view-body' : '')}>
                {view === 'Sensor EEG' && <StackedEegBrowser x={simulation.sensor_trace.x} series={simulation.sensor_trace.series} ariaLabel="심은 네 원천을 순방향 투영한 센서 EEG" />}
                {result && band && view === 'Power map' && <SourcePowerView result={result} band={band} selected={selected} onSelect={setSelected} truthVisible={truthVisible} />}
                {result && view === 'Candidate trace' && <CandidateTraces result={result} selected={selected} />}
                {result && view === 'Forward map' && <CandidateForwardMap result={result} selected={selected} />}
                {result && truthVisible && view === 'Truth diagnostics' && <TruthDiagnostics result={result} />}
              </div>
            </div>}
        </div>
        <div className="canvas-readout source-readout"><div><small>후보 위치</small><strong>{count}</strong></div><div><small>봉우리 · 선택한 대역</small><strong>{band?.peaks.length ?? '—'}</strong></div><div><small>짝지은 평균 거리</small><strong>{truthVisible && result ? result.evaluation.mean_error_mm === null ? '짝 없음' : result.evaluation.mean_error_mm.toFixed(1) + ' mm' : '공개 후 비교'}</strong></div><div><small>기준전극</small><strong>평균 · rank ≤13</strong></div></div>
      </section>

      <aside className="inspector-panel source-inspector"><section className="inspector-lead"><span className="eyebrow">해석(Interpretation)</span><h2>{truthVisible ? '추정은 무엇을 놓쳤나?' : '답이 하나로 정해지지 않는 역문제'}</h2><p>{!simulation ? '먼저 알려진 전류 네 개를 심고 두피에서 섞인 모습을 보세요.' : !result ? '역해는 채널 14개만으로 많은 전류를 추정해야 합니다. 정규화가 가능한 많은 해 중 하나를 고릅니다.' : !truthVisible ? '정답을 공개하기 전에 검출된 봉우리를 모두 살펴보세요. 알파 원천 둘이 극댓값 하나가 될 수 있고, 잡음이 봉우리를 더 만들 수 있습니다. 원천 네 개를 심었다고 네 개가 검출되는 것은 아닙니다.' : '거리와 함께 놓친 원천과 짝 없는 봉우리를 비교하세요. 짝지은 봉우리의 오차가 작아도 검출은 나쁠 수 있습니다.'}</p></section>
        {truthVisible && result && <p className="result-sentence"><b>결과 한 문장</b> {summarizeSourceResult(result)}</p>}
        <section className="source-truth-summary"><h3>시뮬레이션 정답</h3>{!truthVisible ? <><p>추정을 살펴본 뒤에 위치와 평가가 나타납니다.</p><button className="reveal-button" disabled={!result || !!busy} onClick={reveal}><Eye size={16} /> 공개하고 평가하기(Reveal)</button></> : result && <>
          {lesson.revealed && <PredictionFeedback prediction={lesson.revealed.prediction} answer={lesson.revealed.answer} reason={lesson.revealed.reason} graded={lesson.revealed.graded} />}
          {lesson.revealed?.experiment && <p className="experiment-learn"><b>배우는 것</b> {lesson.revealed.experiment.learn}</p>}
          <dl><div><dt>짝지음 / 심은 수</dt><dd>{result.evaluation.matched_count} / {result.rois.length}</dd></div><div><dt>놓친 원천</dt><dd>{result.evaluation.missed_count}</dd></div><div><dt>짝 없는 봉우리</dt><dd>{result.evaluation.unmatched_peak_count}</dd></div></dl>
          <p>고정된 세타/알파/베타 대역에서 {result.evaluation.match_radius_mm} mm 안의 일대일 짝짓기입니다. 광대역은 세지 않습니다. 짝짓기 허용 거리는 채점 규칙이지 공간 정확도가 아닙니다.</p>
          {result.evaluation.outside_band_roi_ids.length > 0 && <p>분석 대역 밖이라 채점하지 않음: {result.evaluation.outside_band_roi_ids.join(', ')}.</p>}
          <ul>{result.rois.map((roi) => <li key={roi.id}><strong>{roi.label} · {roi.frequency_hz} Hz</strong><span>{coordinates(roi.position_mm)} mm</span></li>)}</ul>
        </>}</section>
        <section className="source-learning-experiments"><p>정답을 공개하기 전에 설정을 정하세요. 알려진 점수를 올리려고 설정을 고치는 것은 탐색적 조정이지 독립적 검증이 아닙니다.</p></section>
        <div className="nonclinical"><AlertTriangle size={15} /><span>구형·고정 방향의 교육용 모형입니다. 시뮬레이션과 역해가 같은 기하를 쓰므로 실제 머리 모형 불일치는 시험하지 않습니다. 격자점을 늘려도 센서 정보는 늘지 않습니다.</span></div>
        {result && <section className="source-methods"><span className="eyebrow">기록된 방법</span><p>{result.inverse_method}</p><p>Hann 창 periodogram · 대역 적분 파워(nAm²) · 국소 극댓값 · 상대 임계값 · 거리 억제</p><small>Seed {result.provenance.seed} · recipe {result.provenance.recipe_hash}</small></section>}
      </aside>
    </main>
    <footer className="run-strip source-run-strip"><div className="run-strip-title">원천 국소화</div><p className="source-footer-status">{busy ? '계산 중…' : result ? '추정 완료. 봉우리는 재구성한 파워만으로 정했습니다.' : simulation ? 'EEG 생성 완료. 원천을 추정할 수 있습니다.' : 'EEG를 생성해 시작하세요.'}</p></footer>
  </>
}

function SourceIntroduction({ count, recipe }: { count: number; recipe: SourceModelRecipe }) {
  return <div className="source-empty"><span className="eyebrow">정답을 아는 시뮬레이션 · 불확실한 재구성</span><h3>원천 네 개를 심고, 추정이 스스로 봉우리를 찾게 합니다.</h3><p className="source-empty-lede">앞쪽 두 지점은 {recipe.phase_lag_deg}° 시간 차이를 둔 10 Hz 알파를 냅니다. 마루엽(두정부) 두 지점은 비교용 7 Hz와 18 Hz 신호를 냅니다. 이 전류를 두피 EEG로 투영한 뒤, 그 EEG와 머리 모형만으로 활동을 재구성합니다.</p>
    <svg className="source-intro-head" viewBox="0 0 320 220" role="img" aria-label="앞쪽 알파 원천 쌍과 마루엽 비교 원천의 도식"><ellipse cx="160" cy="112" rx="126" ry="98" className="source-head-outline" /><path d="M148 15 L160 2 L172 15" className="source-head-nose" /><text x="160" y="42" textAnchor="middle">앞(FRONT)</text>{[[92, 80, '10 Hz'], [228, 80, '10 Hz'], [92, 155, '7 Hz'], [228, 155, '18 Hz']].map(([x, y, label], i) => <g key={i}><circle cx={x} cy={y} r="12" fill={i < 2 ? '#087f83' : '#615b91'} /><text x={x} y={Number(y) + 30} textAnchor="middle">{label}</text></g>)}</svg>
    <ol className="source-learning-flow"><li><small>1 · 생성</small><span>전류 네 개가 두피 전극 14개에서 섞입니다.</span></li><li><small>2 · 재구성</small><span>{recipe.grid_spacing_mm} mm 격자의 가능한 위치 {count}곳에서 전류를 추정합니다.</span></li><li><small>3 · 검출</small><span>원천 수를 미리 정하지 않고 공간 파워 봉우리를 찾습니다.</span></li><li><small>4 · 공개</small><span>위치 오차, 놓친 원천, 짝 없는 봉우리를 잽니다.</span></li></ol>
    <p className="source-learning-goal">후보 격자는 모형이 표현할 수 있는 위치의 집합일 뿐, 활동이 실제로 어디서 일어났는지 말하지 않습니다. Minimum norm은 활동을 여러 지점에 퍼뜨릴 수 있어서, 깨끗한 시뮬레이션에서도 심은 위치를 정확히 되찾지 못할 수 있습니다.</p>
  </div>
}

function SourceRange({ label, ariaLabel, help, value, min, max, step, unit, disabled, onChange }: { label: string; ariaLabel: string; help: string; value: number; min: number; max: number; step: number; unit: string; disabled: boolean; onChange: (value: number) => void }) {
  return <label className="range-control connectivity-range"><span><span className="control-label">{label}<ControlHint>{help}</ControlHint></span><output>{Number(value.toFixed(2))} {unit}</output></span><input type="range" aria-label={ariaLabel} value={value} min={min} max={max} step={step} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} style={{ '--range-progress': (value - min) / (max - min) * 100 + '%' } as React.CSSProperties} /><small><span>{min}</span><span>{max}</span></small></label>
}
