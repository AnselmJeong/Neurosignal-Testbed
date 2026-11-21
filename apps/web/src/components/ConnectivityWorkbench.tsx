import { Activity, ArrowDown, GitCompareArrows, Network, Play, SlidersHorizontal, Waves } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { runConnectivity, simulateConnectivity } from '../lib/api'
import { defaultConnectivityRecipe, type ConnectivityMetric, type ConnectivityRecipe, type ConnectivityResult, type ConnectivitySimulation, type ConnectivitySpace } from '../types'
import { LabNavigator, type LabId } from './LabNavigator'
import { StackedEegBrowser } from './StackedEegBrowser'
import { ComparisonReadout, ConnectivityDiagnostics, EstimatePanel, GeneratingNetwork, METRIC_GUIDE, RecipeSummary } from './ConnectivityLessonViews'
import './connectivity-lesson.css'

const STEPS = [
  { label: '만들기(Build)', description: '숨은 원천 사이의 관계를 정합니다.', icon: Network },
  { label: '관찰(Observe)', description: '원천 리듬이 섞인 센서 EEG로 가는 길을 따라갑니다.', icon: Waves },
  { label: '추정(Estimate)', description: '여러 epoch에 걸쳐 관계를 잽니다.', icon: Activity },
  { label: '비교(Compare)', description: 'A를 고정하고 B에서 한 가지를 바꿔 봅니다.', icon: GitCompareArrows },
]
const METRICS: ConnectivityMetric[] = ['coh', 'pearson', 'plv', 'imcoh', 'pli', 'wpli', 'ppc']
const SIGNAL_SETTINGS = ['seed', 'sampling_rate_hz', 'epoch_count', 'epoch_duration_s', 'alpha_frequency_hz', 'phase_lag_deg', 'coupling_strength', 'noise_sd', 'volume_conduction', 'reference'] as const
const sameSignal = (a: ConnectivityRecipe, b: ConnectivityRecipe) => SIGNAL_SETTINGS.every(key => a[key] === b[key])
const sameRecipe = (a: ConnectivityRecipe, b: ConnectivityRecipe) => JSON.stringify(a) === JSON.stringify(b)

export function ConnectivityWorkbench({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [recipe, setRecipe] = useState<ConnectivityRecipe>(() => structuredClone(defaultConnectivityRecipe))
  const [simulation, setSimulation] = useState<ConnectivitySimulation | null>(null)
  const [baseline, setBaseline] = useState<ConnectivityResult | null>(null)
  const [latest, setLatest] = useState<ConnectivityResult | null>(null)
  const [busy, setBusy] = useState<'generate' | 'estimate' | 'remeasure' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [space, setSpace] = useState<ConnectivitySpace>('sensor')
  const [view, setView] = useState<'Matrix' | 'Network'>('Matrix')
  const [traceSnapshot, setTraceSnapshot] = useState<'current' | 'a'>('current')
  const requestId = useRef(0)
  const pending = useRef(false)
  useEffect(() => () => { requestId.current += 1 }, [])

  const ready = simulation !== null && sameSignal(simulation.recipe, recipe)
  const comparison = baseline && latest && baseline.run_id !== latest.run_id ? latest : null
  const hasDistinctEeg = baseline !== null && simulation !== null && !sameSignal(baseline.recipe, simulation.recipe)
  const trace = traceSnapshot === 'a' && baseline ? baseline.simulation : simulation
  const dirty = latest !== null && !sameRecipe(latest.recipe, recipe)
  const step = baseline ? 3 : ready ? 2 : busy === 'generate' ? 1 : 0

  function update<K extends keyof ConnectivityRecipe>(key: K, value: ConnectivityRecipe[K]) {
    setRecipe(current => ({ ...current, [key]: value }))
    setError(null)
    setTraceSnapshot('current')
  }

  async function updateMeasurement<K extends 'metric' | 'spectral_mode'>(key: K, value: ConnectivityRecipe[K]) {
    if (pending.current || recipe[key] === value) return
    const previousRecipe = recipe
    setRecipe(current => ({ ...current, [key]: value }))
    setError(null)
    if (!baseline) return

    pending.current = true
    const id = ++requestId.current
    setBusy('remeasure')
    try {
      // Reconstruct identical seeded EEG for each saved condition. Wait for every
      // response before replacing either side, including when one request fails.
      const saved = comparison ? [baseline, comparison] : [baseline]
      const results = await Promise.allSettled(saved.map(run => runConnectivity({ ...run.recipe, [key]: value })))
      if (requestId.current !== id) return
      const updated = results.map(result => {
        if (result.status === 'rejected') throw result.reason
        return result.value
      })
      setBaseline(updated[0]!)
      setLatest(updated[updated.length - 1]!)
      // Keep any generated, unestimated B preview and all draft signal settings.
    } catch (caught) {
      if (requestId.current === id) {
        setRecipe(previousRecipe)
        setError(`공통 측정을 바꾸지 못했습니다. A/B와 선택 상자를 되돌렸습니다. ${caught instanceof Error ? caught.message : '다시 시도하세요.'}`)
      }
    } finally {
      if (requestId.current === id) { setBusy(null); pending.current = false }
    }
  }

  async function execute(kind: 'generate' | 'estimate') {
    if (pending.current || (kind === 'estimate' && !ready)) return
    pending.current = true
    const id = ++requestId.current
    const snapshot = structuredClone(recipe)
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'generate') {
        const data = await simulateConnectivity(snapshot)
        if (requestId.current !== id) return
        setSimulation(data)
        setTraceSnapshot('current')
      } else {
        const data = await runConnectivity(snapshot)
        if (requestId.current !== id) return
        setLatest(data)
        setBaseline(current => current ?? data)
        setSimulation(data.simulation)
      }
    } catch (caught) {
      if (requestId.current === id) setError(caught instanceof Error ? caught.message : '로컬 분석에 실패했습니다. 같은 설정으로 다시 시도하세요.')
    } finally {
      if (requestId.current === id) { setBusy(null); pending.current = false }
    }
  }

  function setExperiment(change: Partial<ConnectivityRecipe>) {
    if (!baseline) return
    setRecipe({ ...baseline.recipe, ...change })
    setError(null)
    setTraceSnapshot('current')
  }

  return <>
    <main className="workspace conn-lesson-workspace">
      <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={STEPS} step={step} />
      <aside className="control-panel conn-lesson-controls">
        <div className="panel-heading"><span className="eyebrow">연결성 실험</span><h1>원천의 관계에서<br />센서의 연결선까지</h1><p>관계를 만들고 그 EEG를 본 뒤, 연결성 지표가 무엇을 되찾는지 묻습니다.</p></div>
        <fieldset disabled={busy !== null}>
          <legend className="sr-only">시뮬레이션과 추정 설정</legend>
          <section className="control-section">
            <div className="section-title"><span>1 · 원천 사이의 관계</span></div>
            <p className="conn-control-help">시뮬레이션 원천 네 개가 알파 리듬을 냅니다. 앞쪽 두 원천만 성분을 공유할 수 있습니다.</p>
            <Range label="공유 알파 가중치(Shared alpha weight)" ariaLabel="Shared alpha weight" value={recipe.coupling_strength} min={0} max={1} step={0.01} onChange={v => update('coupling_strength', v)} />
            <p className="conn-control-help">0 = 위상이 서로 독립, 1 = Frontal R의 진동 전체가 공유 위상을 따릅니다. 생성기의 가중치이지 목표 코히어런스 값이 아닙니다.</p>
            <Range label="위상차(Phase offset)" ariaLabel="Phase offset" value={recipe.phase_lag_deg} min={0} max={180} step={15} unit="°" onChange={v => update('phase_lag_deg', v)} />
            <p className="conn-control-help">{recipe.coupling_strength === 0 ? '공유 성분이 없어 위상차는 효과가 없습니다.' : `${recipe.alpha_frequency_hz} Hz에서 ${recipe.phase_lag_deg}° = ${(recipe.phase_lag_deg / 360 / recipe.alpha_frequency_hz * 1000).toFixed(1)} ms의 위상 이동입니다. R의 공유 성분이 L보다 앞서지만, 인과적 지연 모형은 아닙니다.`}</p>
          </section>
          <section className="control-section">
            <div className="section-title"><span>2 · 센서 혼합</span></div>
            <Range label="장 퍼짐(Field spread)" ariaLabel="Field spread" value={recipe.volume_conduction} min={0} max={1} step={0.01} onChange={v => update('volume_conduction', v)} />
            <p className="conn-control-help">장이 넓게 퍼질수록 한 원천이 더 많은 센서에 닿습니다(볼륨 전도). 0이어도 약간은 섞이며, 원천 사이의 관계는 바뀌지 않습니다.</p>
            <label className="conn-select">센서 기준전극(Reference)<select aria-label="Sensor reference" value={recipe.reference} onChange={e => update('reference', e.target.value as ConnectivityRecipe['reference'])}><option value="average">평균 기준(Average)</option><option value="none">재기준화 없음(None)</option></select></label>
            <p className="conn-control-help">평균 기준은 매 표본에서 여덟 채널의 평균을 뺍니다. ‘재기준화 없음’은 모형의 원래 센서 혼합을 그대로 둡니다.</p>
          </section>
          <section className="control-section">
            <div className="section-title"><span>3 · 측정</span></div>
            <label className="conn-select">연결성 지표(Metric)<select aria-label="Connectivity metric" value={recipe.metric} onChange={e => void updateMeasurement('metric', e.target.value as ConnectivityMetric)}>{METRICS.map(metric => <option key={metric} value={metric}>{METRIC_GUIDE[metric].label}</option>)}</select></label>
            <p className="conn-control-help">{METRIC_GUIDE[recipe.metric].explanation}</p><p className="conn-control-help">A와 B가 함께 씁니다. 지표를 바꾸면 저장된 두 조건을 같은 EEG에서 다시 추정하므로 EEG를 새로 만들 필요가 없습니다.</p>
          </section>
          <details className="conn-advanced"><summary><SlidersHorizontal size={14} /> 신호와 추정의 세부 설정</summary>
            <Range label="알파 주파수(Alpha frequency)" ariaLabel="Alpha frequency" value={recipe.alpha_frequency_hz} min={8} max={12} step={0.5} unit=" Hz" onChange={v => update('alpha_frequency_hz', v)} />
            <Range label="배경 잡음(Background noise)" ariaLabel="Background noise" value={recipe.noise_sd} min={0.05} max={1.5} step={0.05} onChange={v => update('noise_sd', v)} />
            <Range label="Epoch 수(Epochs)" ariaLabel="Epochs" value={recipe.epoch_count} min={8} max={64} step={4} onChange={v => update('epoch_count', v)} />
            <p className="conn-control-help">서로 독립인 {recipe.epoch_duration_s}초 구간입니다. 연결성은 모든 epoch를 쓰고, 브라우저에는 하나만 예로 보입니다.</p>
            <label className="conn-select">스펙트럼 방식(Spectral mode)<select aria-label="Spectral mode" value={recipe.spectral_mode} disabled={recipe.metric === 'pearson'} onChange={e => void updateMeasurement('spectral_mode', e.target.value as ConnectivityRecipe['spectral_mode'])}><option value="multitaper">Multitaper</option><option value="fourier">Fourier</option></select></label>
            <p className="conn-control-help">Seed {recipe.seed} · 표본화율 {recipe.sampling_rate_hz} Hz · 섞은 귀무 {recipe.surrogate_count}개. 스펙트럼 지표는 {recipe.band_low_hz}–{recipe.band_high_hz} Hz를 평균합니다.</p>
          </details>
        </fieldset>
        <div className="conn-actions">
          {busy === 'remeasure' && <p role="status">{METRIC_GUIDE[recipe.metric].label}로 {comparison ? 'A와 B' : 'A'}를 다시 추정하는 중… 계산이 모두 끝날 때까지 이전 결과가 보입니다.</p>}
          <button className="primary-button" disabled={busy !== null} onClick={() => void execute('generate')}><Waves size={15} />{busy === 'generate' ? '생성 중…' : <span className="conn-generate-label"><span>1 · {baseline ? '비교용' : '기준'}</span>{' '}<span>EEG 생성(Generate)</span></span>}</button>
          <button className="quiet-button" disabled={!ready || busy !== null} onClick={() => void execute('estimate')}><Play size={14} />{busy === 'estimate' ? '추정 중…' : baseline ? '2 · B 추정(Estimate)' : '2 · 연결성 추정(Estimate)'}</button>
          {!ready && <p>추정하기 전에 현재 설정으로 EEG를 생성하세요.</p>}
        </div>
      </aside>
      <section className="conn-lesson-canvas" aria-label="연결성 학습 순서">
        <header className="conn-lesson-header"><span className="eyebrow"><span className="data-kind simulated">시뮬레이션 · 정답을 앎</span> 통제된 시뮬레이션 · 해부학적 뇌 모형이 아님</span><h2>두피까지 오는 동안 무엇이 남는가?</h2><p>원천 사이의 관계, 비슷해 보이는 파형, 센서 사이의 연결선은 서로 다른 것입니다. 같은 자료를 단계마다 따라가 보세요.</p>
          <nav aria-label="실습 구역"><a href="#conn-source">01 원천 모형</a><a href="#conn-eeg">02 생성한 EEG</a><a href="#conn-estimates">03 연결성과 비교</a></nav>
        </header>
        {busy && <div className="conn-status" role="status">{busy === 'generate' ? '원천과 센서 epoch를 생성하는 중…' : busy === 'remeasure' ? `저장된 모든 조건에 ${METRIC_GUIDE[recipe.metric].label} / ${recipe.spectral_mode}를 적용하는 중입니다. 결과는 함께 갱신되고, 원래 EEG 설정은 그대로입니다.` : `두 공간(센서·원천)을 추정하고 공간마다 섞은 귀무 ${recipe.surrogate_count}개를 계산하는 중입니다. 몇 초 걸릴 수 있습니다…`}</div>}
        {error && <div className="conn-error" role="alert"><strong>이 단계를 마치지 못했습니다.</strong> {error} 이미 끝난 결과는 그대로 있습니다.</div>}
        <section id="conn-source" className="conn-chapter">
          <div className="conn-chapter-heading"><span>01</span><div><h2>숨은 원천 정하기</h2><p>현재 설정 · 이 도식은 바로 바뀌고, EEG는 생성할 때 바뀝니다.</p></div></div>
          <div className="conn-source-layout"><GeneratingNetwork recipe={recipe} /><div className="conn-source-explanation"><h3>‘알파를 심는다’는 무슨 뜻인가?</h3><p>원천 네 개는 Frontal L(앞 왼쪽), Frontal R(앞 오른쪽), Posterior L(뒤 왼쪽), Posterior R(뒤 오른쪽)입니다. 각자 {recipe.alpha_frequency_hz} Hz 리듬과 잡음을 냅니다. 정확한 뇌 영역이 아니라 도식적 위치입니다.</p><p>Frontal L과 R은 네 원천 중 둘이며 별도의 노드가 아닙니다. 이 쌍만 성분을 공유합니다. Frontal R은 L의 진동을 위상 이동한 것과 독립적인 진동을 섞어 만듭니다. 뒤쪽 원천들의 위상은 서로 독립입니다. 도식의 선은 시냅스가 아니라 이 공유 성분을 나타냅니다.</p></div></div>
          <details className="conn-model-math"><summary>공유 성분은 어떻게 만드는가?</summary><p>L = sin(ωt + φL) + noise<br />R = c sin(ωt + φL + δ) + √(1 − c²) sin(ωt + φR) + noise</p><p>c = 공유 알파 가중치, δ = 위상차, ω = 2π × {recipe.alpha_frequency_hz} Hz. epoch마다 서로 독립인 시작 위상을 새로 뽑습니다. 공유 부분은 epoch가 바뀌어도 위상차를 유지하고, 관련 없는 원천은 그렇지 않습니다. 알파 주파수가 같다는 것만으로는 설정한 관계가 생기지 않습니다.</p></details>
          <div className="conn-flow-caption"><ArrowDown size={18} /><span>숨은 원천 4개 → 센서 8개(Fp1, Fp2, F7, F8, C3, C4, O1, O2). 센서마다 섞인 신호를 받고, 그 위에 센서 잡음과 기준전극이 적용됩니다.</span></div>
        </section>
        <section id="conn-eeg" className="conn-chapter">
          <div className="conn-chapter-heading"><span>02</span><div><h2>생성한 신호 관찰하기</h2><p>아래 원천 신호와 센서 EEG는 실제 시뮬레이션 입력입니다.</p></div></div>
          {hasDistinctEeg && <div className="conn-switch" role="group" aria-label="EEG 스냅숏"><button aria-pressed={traceSnapshot === 'a'} onClick={() => setTraceSnapshot('a')}>A - 기준 EEG</button><button aria-pressed={traceSnapshot === 'current'} onClick={() => setTraceSnapshot('current')}>B - 비교 EEG</button></div>}
          {hasDistinctEeg && <p className="conn-reading-note">어느 조건의 원천·센서 파형을 볼지 고르세요. B는 추정 전에도 볼 수 있습니다. 이 스위치는 연결성 비교 위의 파형만 바꿉니다.</p>}
          {trace ? <>
            <p className="conn-snapshot-label">{traceSnapshot === 'a' ? '저장된 A' : sameSignal(trace.recipe, recipe) ? '현재 생성한 설정' : '이전에 생성한 설정 · 바꾼 설정을 적용하려면 다시 생성하세요'}</p>
            <RecipeSummary recipe={trace.recipe} includeMeasurement={false} />
            <div className="conn-trace-grid">
              <div><h3>섞이기 전 · 원천 4개</h3><div className="conn-trace-frame"><StackedEegBrowser x={trace.latent_trace.x} series={trace.latent_trace.series} unit="a.u." ariaLabel="생성한 잠재 원천 신호" /></div></div>
              <div><h3>섞인 뒤 · 센서 8개</h3><div className="conn-trace-frame"><StackedEegBrowser x={trace.sensor_trace.x} series={trace.sensor_trace.series} unit="a.u." channelType="eeg" ariaLabel="생성한 센서 EEG" /></div></div>
            </div>
            <p className="conn-reading-note">Epoch {trace.recipe.epoch_count}개 중 {trace.epoch_index + 1}번째 · {trace.recipe.epoch_duration_s} s · 임의 진폭 단위(보정된 µV 아님). 뷰어마다 표시 이득이 따로입니다. 한 epoch에서 파형이 비슷하다고 안정적인 연결성이 있는 것은 아니며, 추정은 모든 epoch를 모아서 합니다.</p>
          </> : <div className="conn-empty"><Waves size={22} /><h3>관계를 재기 전에 신호부터 만드세요</h3><p>‘1 · 기준 EEG 생성’을 누르면 숨은 원천과 그것이 두피에서 섞인 모습을 볼 수 있습니다.</p></div>}
        </section>
        <section id="conn-estimates" className="conn-chapter">
          <div className="conn-chapter-heading"><span>03</span><div><h2>추정한 뒤 가정 하나를 바꾸기</h2><p>첫 추정이 A가 됩니다. 설정 하나를 바꾸고 그 EEG를 생성한 뒤 B를 추정하세요.</p></div></div>
          {baseline && <div className="conn-experiments"><h3>A에서 하나만 바꿔 보기(Try this)</h3><div>
            <button disabled={busy !== null} onClick={() => setExperiment({ coupling_strength: baseline.recipe.coupling_strength === 0 ? 0.78 : 0 })}>{baseline.recipe.coupling_strength === 0 ? '공유 알파 넣기' : '공유 알파 빼기'}</button>
            <button disabled={busy !== null} onClick={() => setExperiment({ volume_conduction: baseline.recipe.volume_conduction > 0.5 ? 0.1 : 0.9 })}>장 퍼짐 바꾸기</button>
            <button disabled={busy !== null} onClick={() => setExperiment({ phase_lag_deg: baseline.recipe.phase_lag_deg === 0 ? 60 : 0 })}>위상차 바꾸기</button>
            <button disabled={busy !== null} onClick={() => setExperiment({ reference: baseline.recipe.reference === 'average' ? 'none' : 'average' })}>기준전극 바꾸기</button>
            <button disabled={busy !== null} onClick={() => setExperiment({})}>A 설정으로 되돌리기</button>
          </div><p>각 버튼은 A에서 출발해 이름 붙은 설정 하나만 바꿉니다. 그다음 B를 생성하고 추정하세요.</p></div>}
          {baseline && latest ? <>
            <div className="conn-result-toolbar"><div className="conn-switch" role="group" aria-label="추정 공간"><button aria-pressed={space === 'sensor'} onClick={() => setSpace('sensor')}>센서 추정</button><button aria-pressed={space === 'latent'} onClick={() => setSpace('latent')}>원천 추정</button></div><div className="conn-switch" role="group" aria-label="추정 시각화"><button aria-pressed={view === 'Matrix'} onClick={() => setView('Matrix')}>행렬(Matrix)</button><button aria-pressed={view === 'Network'} onClick={() => setView('Network')}>{space === 'sensor' ? '두피 지도' : '원천 그래프'}</button></div></div>
            <p className="conn-reading-note">{space === 'sensor' ? '칸이나 선 하나는 센서 한 쌍을 잰 값입니다. 원천 사이의 연결과 일대일로 대응하지 않습니다.' : '이 추정은 EEG에서 재구성한 원천이 아니라 원래 시뮬레이션 원천을 씁니다. 네트워크 보기에서 초록 = 설정한 공유 쌍, 주황 점선 = 그 밖에 검출된 쌍입니다.'} {view === 'Matrix' ? '모든 쌍의 값을 보여 주며, 테두리가 있는 칸은 귀무 임계값을 넘은 것입니다. 대각선은 채널 자신과의 비교라서 뺐습니다.' : '귀무 임계값을 넘은 연결만 그립니다. 선이 없어도 값이 0은 아닐 수 있습니다. 선 굵기는 강한 값을 강조하도록 비선형으로 커지며, 굵기 범례에 대응이 있습니다. 센서 색은 파랑(0)에서 노랑(0.5)을 거쳐 빨강(1)까지로 행렬과 같습니다.'}</p>
            {dirty && <p className="conn-snapshot-label" role="status">설정이 바뀌었습니다. 새 추정이 끝날 때까지 그림은 마친 실행의 설정을 유지합니다.</p>}
            <div className="conn-comparison-grid"><EstimatePanel result={baseline} label="A · 저장한 기준" space={space} view={view} />{comparison ? <EstimatePanel result={comparison} label="B · 최근 추정" space={space} view={view} /> : <div className="conn-comparison-placeholder"><GitCompareArrows size={24} /><h3>B · 다음 실험</h3><p>가정 하나를 바꾸는 동안 A는 여기 남습니다. 위의 ‘공유 알파 빼기’나 ‘장 퍼짐 바꾸기’부터 해 보세요.</p></div>}</div>
            {comparison && <><ComparisonReadout a={baseline} b={comparison} space={space} /><button className="quiet-button" disabled={busy !== null} onClick={() => { setBaseline(comparison); setRecipe(structuredClone(comparison.recipe)); setSimulation(comparison.simulation); setTraceSnapshot('current'); setError(null) }}>B를 새 A로 쓰기</button></>}
            <div className="conn-takeaway"><h3>연결선은 ‘측정된 관계’로 읽으세요</h3><p>공유된 장(field)과 기준전극은 원천 네트워크를 바꾸지 않고도 센서 연결성을 바꿀 수 있습니다. 위상 지연에 민감한 지표는 다른 질문을 던지며, 실제 0° 의존성을 놓칠 수 있습니다. 방향 없는 이 지표들 중 어느 것도 신경 경로나 인과를 증명하지 않습니다.</p></div>
            <ConnectivityDiagnostics result={latest} space={space} />
          </> : <div className="conn-empty"><Network size={22} /><h3>센서 자료는 어떤 관계를 시사할까?</h3><p>EEG를 생성한 뒤 ‘2 · 연결성 추정’을 누르세요. A가 설정과 섞은 귀무 임계값과 함께 여기에 나타납니다.</p></div>}
        </section>
      </section>
    </main>
    <footer className="conn-lesson-footer"><span>원천 모형 → 생성한 EEG → 추정한 관계 → A/B 비교</span><span>Seed {recipe.seed} · {recipe.sampling_rate_hz} Hz · 시뮬레이션 자료</span></footer>
  </>
}

function Range({ label, ariaLabel, value, min, max, step, unit = '', onChange }: { label: string; ariaLabel: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (value: number) => void }) {
  return <label className="conn-range"><span>{label}<output>{Number.isInteger(value) ? value : value.toFixed(2)}{unit}</output></span><input type="range" aria-label={ariaLabel} min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} /></label>
}
