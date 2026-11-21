import { useEffect, useRef, useState } from 'react'
import { Activity, Brain, ChartNoAxesCombined, Download, Map, Play, Users } from 'lucide-react'
import { defaultQeegRecipe, generateQeegEeg, simulateQeeg, type QeegRecipe, type QeegResult, type QeegSimulation } from '../lib/qeeg'
import { LabNavigator, type LabId } from './LabNavigator'
import { ImportedQeegWorkbench } from './ImportedQeegWorkbench'
import { LineChart } from './Charts'
import { StackedEegBrowser } from './StackedEegBrowser'
import { ConnectivityHeatmap } from './ConnectivityViews'
import { QeegTopomap } from './QeegTopomap'
import './qeeg-lab.css'

const STEPS = [
  { label: '생성(Generate)', description: '진동 + 1/f 배경 → EEG.', icon: Activity },
  { label: '기하(Geometry)', description: '머리의 물리와 전극 배치를 구분합니다.', icon: Brain },
  { label: '지도(Map)', description: '채널 스펙트럼을 주파수 지도로 바꿉니다.', icon: Map },
  { label: '정량화(Quantify)', description: '공식과 채널 값을 살펴봅니다.', icon: ChartNoAxesCombined },
  { label: '비교(Compare)', description: '합성 참조 집단에 대한 z 점수를 계산합니다.', icon: Users },
]
const VIEWS = ['EEG', 'Geometry', 'Atlas', 'Metrics', 'Norms'] as const
type View = typeof VIEWS[number]
const VIEW_LABELS: Record<View, string> = { EEG: 'EEG', Geometry: '기하(Geometry)', Atlas: '지도(Atlas)', Metrics: '지표(Metrics)', Norms: '규준(Norms)' }
const LESSONS: Record<View, { title: string; text: string; experiment: string }> = {
  EEG: { title: '모든 채널은 섞인 신호다.', text: '방사 방향 쌍극자 여섯 개가 뒤쪽 알파, 앞쪽 세타, 중심 베타와 서로 독립인 1/f 배경을 냅니다. Lead field가 이것을 전극에서 섞고, 그 위에 센서 잡음과 고른 기준전극이 적용됩니다. 미리보기는 10초, 지표는 32초 전체를 씁니다.', experiment: '뒤쪽 알파 진폭을 키워 보세요. 지도를 열기 전에 어느 채널의 알파 파워가 커질지 먼저 예측하세요.' },
  Geometry: { title: '두피 지도는 뇌 단면이 아니다.', text: '머리 모형은 쌍극자가 전극에 어떻게 투영되는지 계산합니다. 몽타주(montage)는 전극 좌표를, 기준전극은 전압 차이의 기준을 정합니다. 두피 보간은 측정값 사이를 채울 뿐 피질 원천을 재구성하지 않습니다.', experiment: '두개골 전도도를 바꾸고 다시 생성해 지도를 비교하세요. 그다음 기준전극만 바꿔 보세요. 둘 다 심은 원천을 바꾸지 않고도 파워를 바꿀 수 있습니다.' },
  Atlas: { title: '전극마다 숫자 하나.', text: 'EEG를 50%씩 겹치는 4초 Hann 창으로 나누고, FFT 파워 스펙트럼을 평균(Welch)한 뒤, 구간 안의 0.25 Hz bin을 더해 채널 값을 두피에 보간합니다. 지도별 척도는 공간 패턴을, 공통 척도는 주파수 사이의 파워를 비교하게 해 줍니다. 색만으로는 채널을 규준 자료와 비교할 수 없습니다.', experiment: '절대 파워를 상대 파워로 바꿔 보세요. 상대 파워는 채널의 1–45 Hz 전체 파워로 나눈 값입니다. 분모의 알파가 커지면 절대 세타가 그대로여도 상대 세타는 줄 수 있습니다.' },
  Metrics: { title: '정의부터 시작한다.', text: '지표마다 묻는 질문이 다릅니다. 대역 파워는 스펙트럼 에너지를, 비율은 에너지끼리의 비교를, 봉우리·가장자리 주파수는 스펙트럼의 위치를 말합니다. 연결성은 센서 신호 쌍을 비교하며 공유 원천과 기준전극의 영향을 받습니다.', experiment: 'O1, F3, C3를 차례로 골라 PSD와 수치 지표를 비교하세요. F4−F3 알파 비대칭이 양수이면 오른쪽 알파 파워가 더 크다는 뜻이지, 오른쪽 신경 활성이 더 크다는 뜻은 아닙니다.' },
  Norms: { title: 'z 점수에는 모집단이 필요하다.', text: '합성 참조 집단의 각 구성원은 자기만의 EEG, 위상, 배경, 잡음을 가집니다. 진폭은 로그정규 분포로, 알파 주파수는 10 Hz 주변에서, 좌우 이득도 달라집니다. 모두 이 피험자와 같은 몽타주, 머리 모형, 기준전극, 길이, 스펙트럼 절차를 씁니다.', experiment: '피험자의 알파 진폭을 키워 보세요. 참조 집단은 그대로입니다. 집단 seed나 크기를 바꾸면 표본 변동을 볼 수 있습니다. 이 집단에는 나이, 진단, 모집단 타당성이 없습니다.' },
}

export function QeegWorkbench(props: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const canvasRef = useRef<HTMLElement>(null)
  const [recipe, setRecipe] = useState<QeegRecipe>({ ...defaultQeegRecipe })
  const [result, setResult] = useState<QeegResult | null>(null)
  const [simulation, setSimulation] = useState<QeegSimulation | null>(null)
  const [view, setView] = useState<View>('EEG')
  const [pending, setPending] = useState<'eeg' | 'maps' | null>(null)
  const [failedStep, setFailedStep] = useState<'eeg' | 'maps'>('eeg')
  const busy = pending !== null
  const [error, setError] = useState('')
  const [imported, setImported] = useState(false)
  const [channel, setChannel] = useState('O1')
  const [power, setPower] = useState<'absolute' | 'relative'>('relative')
  const [group, setGroup] = useState('frequency')
  const [page, setPage] = useState(0)
  const [colorScale, setColorScale] = useState<'per_map' | 'shared'>('per_map')
  const [normMetric, setNormMetric] = useState<'absolute' | 'relative' | 'theta_beta'>('absolute')
  const [band, setBand] = useState(2)
  const [connection, setConnection] = useState<'coherence' | 'plv'>('coherence')
  const dirty = !!simulation && JSON.stringify(recipe) !== JSON.stringify(simulation.recipe)
  async function generate() {
    if (busy) return
    setPending('eeg'); setError(''); setResult(null); setView('EEG')
    try { setSimulation(await generateQeegEeg(recipe)); setView('EEG') }
    catch (cause) { setFailedStep('eeg'); setError(cause instanceof Error ? cause.message : 'EEG 생성에 실패했습니다.') }
    finally { setPending(null) }
  }
  async function generateMaps() {
    if (!simulation || dirty || busy) return
    setPending('maps'); setError('')
    try { setResult(await simulateQeeg(simulation.recipe)); setView('Atlas') }
    catch (cause) { setFailedStep('maps'); setError(cause instanceof Error ? cause.message : 'QEEG 분석에 실패했습니다.') }
    finally { setPending(null) }
  }
  useEffect(() => {
    // Generating from controls below the fold should bring the completed output into view.
    if (simulation) canvasRef.current?.scrollIntoView?.({ block: 'start' })
  }, [simulation, result])
  function update<K extends keyof QeegRecipe>(key: K, value: QeegRecipe[K]) { setRecipe((current) => ({ ...current, [key]: value })) }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = `qeeg-simulation-${result?.recipe.seed}.json`; a.click(); URL.revokeObjectURL(url)
  }
  if (imported) return <><div className="ql-legacy"><button onClick={() => setImported(false)}>← 시뮬레이션 실습으로 돌아가기</button><span>고급 · 가져온 기록의 파생본</span></div><ImportedQeegWorkbench {...props} /></>
  const c = result ? Math.max(0, result.channel_names.indexOf(channel)) : 0
  const lesson = LESSONS[view]
  return <>
    <main className="workspace qeeg-workspace ql-workspace">
      <LabNavigator {...props} steps={STEPS} step={VIEWS.indexOf(view)} />
      <aside className="control-panel ql-controls">
        <div className="panel-heading"><span className="eyebrow">QEEG · 시뮬레이션 스튜디오</span><h1>신호에서<br />두피 지도까지</h1><p>EEG를 만들고, 그 숫자가 그림이 되는 과정을 따라갑니다.</p></div>
        <fieldset disabled={busy}>
          <section className="control-section"><div className="section-title"><span>가상 원천</span><small>nAm</small></div>
            <Slider label="뒤쪽 알파(Posterior alpha)" value={recipe.alpha_amplitude} min={2} max={45} onChange={(v) => update('alpha_amplitude', v)} />
            <Slider label="앞쪽 세타(Frontal theta)" value={recipe.theta_amplitude} min={2} max={35} onChange={(v) => update('theta_amplitude', v)} />
            <Slider label="중심 베타(Central beta)" value={recipe.beta_amplitude} min={2} max={30} onChange={(v) => update('beta_amplitude', v)} />
            <Slider label="알파 주파수(Alpha frequency) · Hz" value={recipe.alpha_hz} min={8} max={12} step={.25} onChange={(v) => update('alpha_hz', v)} />
            <Slider label="오른쪽 알파 이득(Right alpha gain) · ×" value={recipe.right_alpha_gain} min={.25} max={2.5} step={.05} onChange={(v) => update('right_alpha_gain', v)} />
          </section>
          <section className="control-section"><div className="section-title"><span>측정 기하</span></div>
            <Select label="전극 몽타주(Montage)" value={recipe.montage} options={['19', '32']} labels={['10–20 · 19채널', '10–20 + 중간 위치 · 32채널']} onChange={(v) => update('montage', v as QeegRecipe['montage'])} />
            <Select label="전압 기준전극(Reference)" value={recipe.reference} options={['average', 'linked_mastoids']} labels={['EEG 채널 평균(Average)', '연결 유양돌기(Linked mastoids) · (A1 + A2)/2']} onChange={(v) => update('reference', v as QeegRecipe['reference'])} />
            <Select label="4층 머리 모형(Head model)" value={recipe.head_model} options={['standard', 'conductive_skull']} labels={['두개골 전도도 · 0.004 S/m', '두개골 전도도 · 0.012 S/m']} onChange={(v) => update('head_model', v as QeegRecipe['head_model'])} />
          </section>
          <section className="control-section"><div className="section-title"><span>합성 참조 집단(Cohort)</span></div>
            <Select label="집단 크기(Number of peers)" value={String(recipe.cohort_size)} options={['20', '80', '200']} onChange={(v) => update('cohort_size', Number(v))} />
            <label className="ql-number">피험자 seed<input type="number" min={0} max={4294967295} value={recipe.seed} onChange={(e) => update('seed', Math.max(0, Math.min(4294967295, Math.round(Number(e.target.value)))))} /></label>
            <label className="ql-number">집단 seed<input type="number" min={0} max={4294967295} value={recipe.cohort_seed} onChange={(e) => update('cohort_seed', Math.max(0, Math.min(4294967295, Math.round(Number(e.target.value)))))} /></label>
          </section>
        </fieldset>
        <div className="source-run-actions">
          <button className="primary-button" disabled={busy} onClick={generate}><Play size={15} />{pending === 'eeg' ? '1 · EEG 생성 중…' : '1 · EEG 생성(Generate)'}</button>
          <button className="source-estimate-button" disabled={!simulation || dirty || busy} onClick={generateMaps}><Map size={15} />{pending === 'maps' ? '2 · QEEG 지도 만드는 중…' : '2 · QEEG 지도 만들기'}</button>
        </div>
        <p className="ql-fixed" role="status">{pending === 'eeg' ? '다채널 기록을 만드는 중…' : pending === 'maps' ? '스펙트럼, 지표, 합성 집단을 계산하는 중…' : dirty ? '설정이 바뀌었습니다. 지도를 만들기 전에 EEG를 다시 생성하세요.' : result ? '지도 준비 완료. 파워, 지표, 합성 규준을 살펴보세요.' : simulation ? 'EEG 준비 완료. 파형을 본 뒤 QEEG 지도를 만드세요.' : 'EEG 생성부터 시작한 뒤 QEEG 지도를 만드세요.'}</p>
        <p className="ql-fixed">128 Hz · 32 s · 1/f 배경<br />아티팩트 없는 교육용 예시라 ICA가 필요 없습니다.</p>
        <button className="quiet-button" onClick={() => setImported(true)}>고급: 가져온 EEG</button>
      </aside>
      <section ref={canvasRef} className="canvas-panel ql-canvas">
        <header className="ql-toolbar"><div><span className="eyebrow"><span className="data-kind simulated">시뮬레이션 · 정답을 앎</span> 합성 EEG · 교육용</span><h2>{view === 'Atlas' ? '주파수 지도(Atlas)' : view === 'Norms' ? '만드는 과정을 공개한 참조 집단' : view === 'Geometry' ? '쌍극자에서 전극까지' : view === 'Metrics' ? '계산의 안쪽' : '다채널 기록'}</h2></div><button className="quiet-button" disabled={!result || busy} onClick={download}><Download size={14} /> JSON</button></header>
        <div className="view-tabs ql-tabs" role="tablist" aria-label="QEEG 실습 보기">{VIEWS.map((item) => <button role="tab" aria-selected={item === view} className={item === view ? 'active' : ''} disabled={busy || (item === 'EEG' || item === 'Geometry' ? !simulation : !result)} key={item} title={item} onClick={() => setView(item)}>{VIEW_LABELS[item]}</button>)}</div>
        {dirty && <p className="ql-status" role="status">설정이 바뀌었습니다. 그림은 이전 기록입니다. 바꾼 설정을 적용하려면 EEG를 다시 생성하세요.</p>}
        {error && <p className="ql-error" role="alert">{error} <button onClick={failedStep === 'eeg' ? generate : generateMaps} disabled={busy || (failedStep === 'maps' && dirty)}>다시 시도</button></p>}
        <div className="ql-stage" aria-busy={busy}>
          {!simulation && <div className="empty-stage">
            <div className="empty-wave" aria-hidden="true"><Activity size={42} /></div>
            <span className="eyebrow">{busy ? '기록을 만드는 중' : '실험 준비 완료'}</span>
            <h3>{busy ? '다채널 EEG를 생성하는 중…' : 'EEG를 생성해 시작하세요.'}</h3>
            <p>{busy ? '시뮬레이션 원천을 머리 모형에 투영하는 중입니다.' : '왼쪽에서 EEG 생성을 누르세요. 파형을 본 뒤 QEEG 지도를 만드세요.'}</p>
          </div>}
          {simulation && view === 'EEG' && <><p className="ql-caption">{simulation.channel_names.length}채널 시뮬레이션 EEG의 처음 10초 · µV · {simulation.recipe.reference.replace('_', ' ')}</p><StackedEegBrowser x={simulation.time_s} series={Object.fromEntries(simulation.channel_names.map((name, i) => [name, simulation.eeg_uv[i]!]))} ariaLabel="시뮬레이션 QEEG 다채널 기록" /></>}
          {simulation && view === 'Geometry' && <Geometry result={simulation} />}
          {result && view === 'Atlas' && <>
            <div className="ql-options"><Select label="지도 값" value={power} options={['relative', 'absolute']} labels={['상대 파워(Relative) · %', '절대 파워(Absolute) · µV²']} onChange={(v) => setPower(v as typeof power)} /><Select label="주파수 묶음" value={group} options={['frequency', 'bands']} labels={['1 Hz 간격 지도', '표준 대역(Bands)']} onChange={setGroup} />{group === 'frequency' && <Select label="주파수 범위" value={String(page)} options={['0', '1', '2']} labels={['1–16 Hz', '16–31 Hz', '31–45 Hz']} onChange={(v) => setPage(Number(v))} />}<Select label="색 척도" value={colorScale} options={['per_map', 'shared']} labels={['지도별 · 공간 패턴', '공통 · 파워 비교']} onChange={(v) => setColorScale(v as typeof colorScale)} /></div>
            <Atlas result={result} power={power} group={group} page={page} colorScale={colorScale} />
            <p className="ql-caption">코가 위 · 그림의 왼쪽 = 왼쪽 반구 · 점 = 전극. 투영한 템플릿 좌표에 역거리 가중으로 부드럽게 채웠고, 가장자리 색은 외삽입니다. 색 범위는 생성할 때마다 다시 계산합니다. 파랑과 빨강은 표시 범위 안의 값일 뿐, 규준 집단보다 낮거나 높다는 뜻이 아닙니다.</p>
          </>}
          {result && view === 'Metrics' && <>
            <div className="ql-options"><Select label="채널 살펴보기" value={channel} options={result.channel_names} onChange={setChannel} /></div>
            <LineChart x={result.metrics.frequency_hz} series={[{ label: `${channel} PSD`, values: result.metrics.psd[c]! }]} xLabel="주파수(Hz)" yLabel="µV²/Hz (로그 척도)" logY height={240} ariaLabel={`${channel} power spectrum`} />
            <MetricTable result={result} c={c} />
            <div className="ql-options"><Select label="알파 연결성 · 8–13 Hz" value={connection} options={['coherence', 'plv']} labels={['제곱 코히어런스(Magnitude-squared coherence)', '위상 고정값(PLV)']} onChange={(v) => setConnection(v as typeof connection)} /></div>
            <p className="ql-caption">{connection === 'coherence' ? '|mean(Sxy)|² / [mean(Sxx) mean(Syy)]를 주파수마다 구해 대역 평균합니다. 겹치는 Welch 창 15개.' : '8–13 Hz 필터와 Hilbert 변환 뒤 시간에 걸친 |mean(exp(i × 위상차))|. 양 끝 1초는 잘라 냅니다.'} 범위 0–1, 대각선 = 1. 공유 원천과 기준전극만으로도 직접 결합 없이 높은 값이 나올 수 있습니다.</p>
            <ConnectivityHeatmap matrix={{ node_names: result.channel_names, values: result[connection], space: 'sensor', metric: connection === 'coherence' ? 'coh' : 'plv', band_hz: [8, 13] }} threshold={1.1} />
          </>}
          {result && view === 'Norms' && <>
            <div className="ql-options"><Select label="지표" value={normMetric} options={['absolute', 'relative', 'theta_beta']} labels={['로그 절대 파워', '로짓 상대 파워', '로그 세타/베타 비']} onChange={(v) => setNormMetric(v as typeof normMetric)} />{normMetric !== 'theta_beta' && <Select label="대역" value={String(band)} options={result.bands.map((_, i) => String(i))} labels={result.bands.map((b) => b.name)} onChange={(v) => setBand(Number(v))} />}<Select label="채널" value={channel} options={result.channel_names} onChange={setChannel} /></div>
            <NormView result={result} metric={normMetric} band={normMetric === 'theta_beta' ? 0 : band} c={c} />
          </>}
        </div>
        <footer className="ql-provenance">{simulation ? `전극 ${simulation.channel_names.length}개 · ${simulation.recipe.reference.replace('_', ' ')} · seed ${simulation.recipe.seed} · MNE ${simulation.provenance.mne}` : '로컬 분석 엔진'}{result ? ` · 합성 집단 ${result.recipe.cohort_size}명` : simulation ? ' · EEG 생성됨, 지도 대기' : ''}{busy && ' · 계산 중…'}</footer>
      </section>
      <aside className="inspector-panel source-inspector ql-inspector"><section className="inspector-lead"><span className="eyebrow">그림 읽기</span><h2>{lesson.title}</h2><p>{lesson.text}</p></section><section className="ql-inspector-section"><span className="eyebrow">하나만 바꿔 보기(Try this)</span><p>{lesson.experiment}</p></section><section className="ql-inspector-section"><span className="eyebrow">계산 사슬</span><ol><li>알려진 원천 활동 · nAm</li><li>순방향 모형 → 전극 EEG · µV</li><li>기준전극 → Welch PSD · µV²/Hz</li><li>적분 → 파워 · µV² 또는 %</li><li>보간 → 두피 그림</li><li>변환 → 합성 집단 기준 z</li></ol></section><details><summary>가정과 출처 · 이 Lab이 말해 주지 못하는 것</summary><p>템플릿 전극 위치, 방사 방향 쌍극자 여섯 개, 반지름 90 mm 동심구 머리를 씁니다. 개인 MRI나 피질 국소화는 없습니다. 모든 스펙트럼은 [1, 45) Hz를 쓰며 대역의 상한은 포함하지 않습니다.</p><p>규준은 생성한 예시이지 임상 규준이 아닙니다. ±2 SD는 기술적 표시일 뿐 보정된 유의 임계값이나 진단이 아닙니다. 전극과 대역을 여러 개 검사하면 다중 비교 문제가 생깁니다.</p><a href="https://mne.tools/stable/generated/mne.make_forward_solution.html" target="_blank" rel="noreferrer">MNE 순방향 모형</a><a href="https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.welch.html" target="_blank" rel="noreferrer">Welch 파워 스펙트럼</a><a href="https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.coherence.html" target="_blank" rel="noreferrer">제곱 코히어런스</a></details><p className="ql-norm-label">시뮬레이션 자료<br />교육용 참조일 뿐입니다.</p></aside>
    </main>
  </>
}

function Slider({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return <label className="ql-slider"><span>{label}<b>{Number(value.toFixed(2))}</b></span><input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} /></label>
}
function Select({ label, value, options, labels, onChange }: { label: string; value: string; options: string[]; labels?: string[]; onChange: (value: string) => void }) {
  return <label className="select-field"><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((item, i) => <option key={item} value={item}>{labels?.[i] ?? item}</option>)}</select></label>
}
function Scale({ low = 0, high, unit, divergent = false }: { low?: number; high: number; unit: string; divergent?: boolean }) {
  return <div className="ql-scale"><span>{low.toFixed(1)}</span><i className={divergent ? 'divergent' : ''} /><span>{high.toFixed(1)} {unit}</span></div>
}
function Atlas({ result, power, group, page, colorScale }: {
  result: QeegResult; power: 'absolute' | 'relative'; group: string; page: number
  colorScale: 'per_map' | 'shared'
}) {
  const multiplier = power === 'relative' ? 100 : 1
  const all = (group === 'bands' ? result.metrics[power] : result[`atlas_${power}`])
    .map((row) => row.map((v) => v * multiplier))
  const sharedHigh = Math.max(...all.flat(), .001)
  const start = group === 'bands' ? 0 : page * 15
  const values = group === 'bands' ? all : all.slice(start, start + 15)
  const unit = power === 'relative' ? '%' : 'µV²'
  const local = colorScale === 'per_map'
  return <>
    <p className="ql-scale-note" role="note">{local
      ? '지도별 척도 · 지도마다 자기 전극의 최솟값–최댓값을 씁니다. 공간 패턴을 비교하세요. 지도 사이에 색이 같아도 파워가 같은 것은 아니며, 작은 차이도 커 보입니다.'
      : '공통 척도 · 모든 주파수 페이지에서 색이 같으면 파워도 같습니다. 강한 알파 봉우리 때문에 약한 주파수는 대부분 파랗게 보일 수 있습니다.'}</p>
    {!local && <Scale high={sharedHigh} unit={unit} />}
    <div className={`ql-atlas ${group === 'bands' ? 'bands' : ''}`}>
      {values.map((row, i) => {
        const title = group === 'bands'
          ? `${result.bands[i]!.name} · ${result.bands[i]!.low}–${result.bands[i]!.high} Hz`
          : `${start + i + 1}–${start + i + 2} Hz`
        const low = local ? Math.min(...row) : 0
        const high = local ? Math.max(...row) : sharedHigh
        return <figure key={title}>
          <figcaption>{title}</figcaption>
          <QeegTopomap positions={result.positions_2d} names={result.channel_names}
            values={row} low={low} high={high} label={`${title} ${power} power, range ${low.toPrecision(3)} to ${high.toPrecision(3)} ${unit}`} />
          {local && <div className="ql-local-scale" aria-label={`${title} color range`}>
            <i /><span>{low.toPrecision(3)} – {high.toPrecision(3)} {unit}</span>
          </div>}
          <small>평균 {(row.reduce((a, b) => a + b, 0) / row.length).toFixed(2)} {unit}</small>
        </figure>
      })}
    </div>
  </>
}

function Geometry({ result }: { result: QeegSimulation }) {
  return <div className="ql-geometry"><div className="ql-geometry-pair"><figure><svg viewBox="0 0 250 250" role="img" aria-label="동심구 머리 모형과 쌍극자 여섯 개, 위에서 본 모습">{[100, 97, 92, 90].map((r, i) => <circle key={r} cx="125" cy="125" r={r} fill={['#e8d8c2', '#bfa992', '#d8e8e6', '#eef3ef'][i]} stroke="#7b918c" />)}<path d="M117 25 L125 12 L133 25" fill="none" stroke="#526e69" />{result.source_positions_m.map(([x = 0, y = 0], i) => <g key={i}><circle cx={125 + x / .09 * 100} cy={125 - y / .09 * 100} r="7" fill={i < 2 ? '#087f83' : i < 4 ? '#b96139' : '#685e93'} /><text x={125 + x / .09 * 100} y={110 - y / .09 * 100} fontSize="10" textAnchor="middle">{['α L', 'α R', 'θ L', 'θ R', 'β L', 'β R'][i]}</text></g>)}</svg><figcaption>순방향 모형 · 위에서 본 모습<br />뇌 / 뇌척수액 / 두개골 / 두피</figcaption></figure><figure><QeegTopomap positions={result.positions_2d} names={result.channel_names} values={result.channel_names.map(() => 0)} low={-1} high={1} divergent labels label="두피 위 템플릿 전극 위치" /><figcaption>전극 {result.channel_names.length}개 · standard_1020 템플릿<br />방위 등거리 투영</figcaption></figure></div><h3>EEG(t) = reference[G × sources(t) + noise(t)]</h3><p>G는 MNE의 구형 순방향 계산기로 구하며, 각 쌍극자의 방사 방향과 머리 좌표계의 전극 좌표를 씁니다. 원천 진폭 여섯 개는 nAm, 센서 출력은 µV로 바꿉니다.</p><dl className="ql-facts"><div><dt>층 반지름</dt><dd>81 / 82.8 / 87.3 / 90 mm</dd></div><div><dt>전도도 · S/m</dt><dd>{result.conductivities_s_m.join(' / ')}</dd></div><div><dt>기준전극 식</dt><dd>{result.recipe.reference === 'average' ? 'V′c = Vc − mean(all EEG channels)' : 'V′c = Vc − (VA1 + VA2) / 2'}</dd></div></dl><p>템플릿 전극 좌표는 받은 그대로 쓰며, 머리 그림은 도식입니다. A1/A2는 시뮬레이션 기준전극이라 지도 채널이 아닙니다. 머리 모형은 EEG를 만들 때 쓰고, 지도는 전극 위치와 채널 지표만 있으면 됩니다.</p></div>
}
function MetricTable({ result: r, c }: { result: QeegResult; c: number }) {
  const m = r.metrics
  const rows = [
    ...r.bands.map((b, i) => [b.name + ' 파워', `Σ PSD(f) × 0.25 Hz; ${b.low} ≤ f < ${b.high}`, `${m.absolute[i]![c]!.toFixed(2)} µV²`, `1–45 Hz의 ${(m.relative[i]![c]! * 100).toFixed(2)}%`]),
    ['세타 / 베타', 'P[4,8) / P[13,30)', m.theta_beta[c]!.toFixed(3), '무차원 · 진단 기준값 없음'],
    ['알파 봉우리', '[8,13) Hz에서 PSD 최대인 주파수', `${m.alpha_peak_hz[c]!.toFixed(2)} Hz`, '최대 bin · 봉우리 돌출도 검사 없음'],
    ['중앙 주파수', '1–45 Hz 파워의 50%에 처음 닿는 bin', `${m.median_hz[c]!.toFixed(2)} Hz`, '스펙트럼 중앙값'],
    ['SEF95', '1–45 Hz 파워의 95%에 처음 닿는 bin', `${m.sef95_hz[c]!.toFixed(2)} Hz`, '스펙트럼 가장자리 주파수'],
    ['스펙트럼 엔트로피', '−Σ p(f) ln p(f) / ln(bin 수)', m.entropy[c]!.toFixed(3), '0 한곳에 몰림 → 1 고른 스펙트럼'],
    ['앞쪽 알파 비대칭', 'ln Pα(F4) − ln Pα(F3)', r.frontal_alpha_asymmetry.toFixed(3), 'F4/F3 고정 쌍 · 양수 = 오른쪽 파워가 큼'],
  ]
  return <table className="ql-table"><caption>채널 {r.channel_names[c]} · 정의와 값</caption><thead><tr><th>지표</th><th>계산</th><th>값</th><th>뜻 / 상대값</th></tr></thead><tbody>{rows.map(([name, formula, value, note]) => <tr key={name}><th>{name}</th><td>{formula}</td><td>{value}</td><td>{note}</td></tr>)}</tbody></table>
}
function NormView({ result: r, metric, band, c }: { result: QeegResult; metric: 'absolute' | 'relative' | 'theta_beta'; band: number; c: number }) {
  const n = r.norms[metric]; const subject = n.subject[band]![c]!; const mean = n.mean[band]![c]!; const sd = n.sd[band]![c]!
  const values = n.cohort_values.map((v) => v[band]![c]!); const low = Math.min(...values, subject) - .1; const high = Math.max(...values, subject) + .1
  const sx = (v: number) => 30 + (v - low) / (high - low) * 540
  const transform = metric === 'absolute' ? 'ln(µV² 단위 파워)' : metric === 'relative' ? 'ln(p / (1 − p)), p = 상대 비율' : 'ln(세타/베타)'
  return <div className="ql-norms"><p className="ql-synthetic">합성 규준 예시 · N = {r.recipe.cohort_size} · 임상 모집단 아님</p><div className="ql-norm-pair"><figure><QeegTopomap positions={r.positions_2d} names={r.channel_names} values={n.z[band]!} low={-3} high={3} divergent labels label="합성 규준 z 점수 두피 지도" /><Scale low={-3} high={3} unit="z" divergent /><figcaption>±3 고정 척도 · 이 범위 밖에서는 색이 포화됩니다.</figcaption></figure><div><span className="eyebrow">{r.channel_names[c]} · {metric === 'theta_beta' ? '세타 / 베타' : r.bands[band]!.name}</span><h3>z = (subject − mean) / SD</h3><p className="ql-equation">({subject.toFixed(3)} − {mean.toFixed(3)}) / {sd.toFixed(3)}<br /><strong>= {n.z[band]![c]!.toFixed(2)}</strong></p><p>경험적 백분위: <b>{n.percentile[band]![c]!.toFixed(1)}%</b><br />변환: {transform}<br />SD의 분모는 N − 1입니다.</p></div></div><figure className="ql-distribution"><figcaption>{r.channel_names[c]} · 변환된 척도 위의 집단 구성원</figcaption><svg viewBox="0 0 600 140" role="img" aria-label="피험자와 집단 평균을 함께 표시한 합성 집단 분포"><line x1="30" x2="570" y1="100" y2="100" stroke="#bdc9c5" />{values.map((v, i) => <circle key={i} cx={sx(v)} cy={55 + (i % 5) * 8} r="3" fill="#527f7a" opacity=".6"><title>구성원 {i + 1}: {v.toFixed(3)}</title></circle>)}<line x1={sx(mean)} x2={sx(mean)} y1="40" y2="103" stroke="#253f3e" strokeDasharray="3 3" /><line x1={sx(subject)} x2={sx(subject)} y1="24" y2="103" stroke="#c05d38" strokeWidth="2" /><text x={Math.max(60, Math.min(540, sx(subject)))} y="17" textAnchor="middle" fill="#a44220" fontSize="12">피험자</text><text x="30" y="124" fontSize="11">{low.toFixed(2)}</text><text x="570" y="124" textAnchor="end" fontSize="11">{high.toFixed(2)}</text></svg><p className="ql-caption">점: 서로 독립인 시뮬레이션 구성원 · 점선: 집단 평균 · 주황 선: 피험자. 백분위 = 아래쪽 비율 + 동률의 절반이며 정규분포 꼬리 확률을 가정하지 않습니다.</p></figure><details><summary>참조 집단은 어떻게 만드는가</summary><p>구성원마다: 원천 알파/세타/베타 진폭 = (18, 9, 7) nAm × lognormal(0, 0.22), 알파 봉우리 = 8–12 Hz로 자른 Normal(10, 0.45) Hz, 오른쪽 알파 이득 = lognormal(0, 0.12). 기록마다 새 위상, 독립 1/f 배경, 0.7 µV 센서 잡음을 뽑습니다.</p><p>모든 구성원은 같은 순방향 모형, 기준전극, Welch 절차를 거칩니다. 이 분포들은 교육용으로 고른 가정입니다. 변환은 치우침을 줄이지만 정규성을 보장하지 않습니다. 실제 규준 연구는 모집단, 나이·상태 짝짓기, 기록·기준전극 호환성, 품질 기준, 외부 검증, 다중 검정 결정을 모두 정당화해야 합니다.</p></details></div>
}
