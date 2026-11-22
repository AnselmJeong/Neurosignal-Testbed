// P2-1 "Lab 00 · 신호 여행": a 5–8 minute tour that follows one signal along our own axis,
// source → electrode → estimate. Seven scenes, each with one control, two sentences, and a
// button to the lab that does the real thing. Everything is computed in the browser.
import { ArrowRight, Brain, Eye, GitBranch, HardDrive, Link2, Radio, Undo2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import {
  BLINK_TOPO, ELECTRODE_X, GRID, SENSORS, SOURCE_X, TIMES, blinkRemoval, connectionReading, coupledSources, crossCorrelation,
  drivenPair, inverseProfile, mix, mixingWeights, sine, sourceShare,
} from '../lessons/journey'
import { LABS, LabNavigator, type LabId, type LabKey } from './LabNavigator'
import { PrimerRange } from './PhasePrimer'

const TEAL = '#087f83'
const RUST = '#c7653c'
const GREY = '#9a9d97'
const INK = '#202321'
const SOURCE_COLORS = ['#087f83', '#615b91', '#b08a2e', '#5b7f3a']

type Stage = 'source' | 'electrode' | 'estimate'

const STEPS = [
  { label: '원천 하나', description: '한 원천이 진동합니다.', icon: Radio },
  { label: '섞여서 전극으로', description: '원천 여럿이 섞여 전극에 닿습니다.', icon: GitBranch },
  { label: '깜박임 분리', description: '아티팩트를 빼면 무엇이 함께 빠지는가.', icon: Eye },
  { label: '이어 보기', description: '잇지 않은 전극도 이어져 보입니다.', icon: Link2 },
  { label: '거꾸로 가기', description: '전극에서 원천으로 가면 흐려집니다.', icon: Undo2 },
  { label: '정답 없는 기록', description: '실제 기록에는 정답 레이어가 없습니다.', icon: HardDrive },
  { label: '방향 묻기', description: '누가 먼저 움직이는가.', icon: Brain },
] as const

const STAGES: Stage[] = ['source', 'electrode', 'electrode', 'electrode', 'estimate', 'electrode', 'estimate']

export function SignalJourney({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [scene, setScene] = useState(0)
  const [frequency, setFrequency] = useState(10)
  const [spread, setSpread] = useState(0.5)
  const [overlap, setOverlap] = useState(0.2)
  const [coupling, setCoupling] = useState(0.7)
  const [lambda, setLambda] = useState(0.2)
  const [real, setReal] = useState(false)
  const [lag, setLag] = useState(40)

  return (
    <main className="workspace phase-workspace">
      <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={STEPS} step={scene} />
      <section className="phase-primer journey" onScroll={(event) => {
        const sections = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('.phase-scene'))
        const top = event.currentTarget.scrollTop + 200
        const current = sections.reduce((found, section, index) => section.offsetTop <= top ? index : found, 0)
        if (current !== scene) setScene(current)
      }}>
        <header className="phase-intro">
          <span className="eyebrow"><span className="data-kind simulated">시뮬레이션 · 정답을 앎</span> Lab 00 · 처음이라면 여기서 5–8분</span>
          <h1>신호 여행: 원천에서 전극, 그리고 추정까지</h1>
          <p>이 앱의 모든 Lab은 같은 길 위에 있습니다. 뇌 안의 원천이 진동하고, 섞여서 전극에 닿고, 우리는 전극에서 원천을 거꾸로 짐작합니다. 일곱 장면에서 조작을 하나씩 움직여 보고, 더 알고 싶은 장면에서 해당 Lab으로 넘어가세요.</p>
        </header>
        <StageBar stage={STAGES[scene]!} />

        <Scene onLabChange={onLabChange} index={1} title="원천 하나가 진동한다" lines={[
          '뇌 안의 한 영역에서 수많은 신경세포가 박자를 맞추면 전류가 규칙적으로 오르내립니다. 이것이 이 앱에서 "원천(source)"이라 부르는 것입니다.',
          '진동은 1초에 몇 번 오르내리는지(주파수, Hz)로 이름을 붙입니다. 8–12 Hz는 알파, 13–30 Hz는 베타입니다.',
        ]} control={<PrimerRange label="주파수(Frequency)" ariaLabel="Source frequency" value={frequency} min={1} max={40} step={1} unit=" Hz" onChange={setFrequency} />}
        readout={`1초에 ${frequency}번 · 한 번에 ${(1000 / frequency).toFixed(0)} ms · ${bandName(frequency)}`}>
          <Traces rows={[{ label: '원천 A', values: sine(frequency), color: TEAL }]} height={110} />
        </Scene>

        <Scene onLabChange={onLabChange} index={2} title="원천이 여럿이 되고, 섞여서 전극에 닿는다" lines={[
          '전류는 머리뼈와 두피를 지나며 넓게 퍼집니다. 그래서 전극 하나는 바로 아래 원천만이 아니라 주변 원천 여럿을 함께 듣습니다.',
          '선의 굵기가 각 원천이 전극에 주는 몫입니다. 퍼짐을 키우면 전극들의 파형이 서로 닮아 갑니다.',
        ]} control={<PrimerRange label="퍼짐(Field spread)" ariaLabel="Field spread" value={Math.round(spread * 100)} min={0} max={100} step={5} unit="%" onChange={(value) => setSpread(value / 100)} />}
        readout={`전극 E2가 듣는 소리 가운데 바로 아래 원천 B의 몫: ${Math.round(sourceShare(mixingWeights(spread), 1, 1) * 100)}%`}
        lab="filter" labNote="표본화와 필터가 전극 신호를 어떻게 바꾸는지">
          <MixingFigure spread={spread} />
        </Scene>

        <Scene onLabChange={onLabChange} index={3} title="눈 깜박임이 올라탄다. 분리한다." lines={[
          '눈을 깜박이면 앞쪽 전극에 뇌파보다 훨씬 큰 파형이 실립니다. 깜박임의 지형(어느 전극에 얼마나 실리는가)을 알면 그 방향을 통째로 빼낼 수 있습니다.',
          '그런데 뇌 원천의 지형이 깜박임과 닮았다면, 빼낼 때 뇌 신호도 함께 빠집니다. 겹침을 올려 보세요.',
        ]} control={<PrimerRange label="지형 겹침(Topography overlap)" ariaLabel="Topography overlap" value={Math.round(overlap * 100)} min={0} max={90} step={5} unit="%" onChange={(value) => setOverlap(value / 100)} />}
        readout={`깜박임을 빼면 함께 사라지는 뇌 신호: ${Math.round(blinkRemoval(overlap).neuralLoss * 100)}%`}
        lab="ica" labNote="실제 ICA로 성분을 하나씩 판정해 지우기">
          <BlinkFigure overlap={overlap} />
        </Scene>

        <Scene onLabChange={onLabChange} index={4} title="두 원천을 잇는다. 잇지 않은 전극도 이어져 보인다." lines={[
          '원천 A와 B만 서로 이어 두었습니다. C와 D는 처음부터 끝까지 남남입니다. 원천에서는 이 차이가 뚜렷합니다.',
          '같은 원천을 전극에서 재면, 퍼짐 때문에 C와 D 위의 전극도 함께 움직입니다. 전극 연결선 하나만 보고는 진짜와 번짐을 가를 수 없습니다.',
        ]} control={<PrimerRange label="A–B 결합(Coupling)" ariaLabel="A to B coupling" value={Math.round(coupling * 100)} min={0} max={95} step={5} unit="%" onChange={(value) => setCoupling(value / 100)} />}
        readout={`퍼짐 ${Math.round(spread * 100)}% (장면 2에서 바꾼 값)`}
        lab="connectivity" labNote="연결성 지표가 번짐에 속는 정도를 지표별로 비교하기">
          <ConnectionFigure coupling={coupling} spread={spread} />
        </Scene>

        <Scene onLabChange={onLabChange} index={5} title="전극에서 원천으로 거꾸로 간다. 흐려진다." lines={[
          '전극 8개로 원천 자리 41곳을 풀어야 하므로 답이 하나로 정해지지 않습니다. 그중 전류가 가장 작은 답을 고르는 것이 minimum-norm 추정입니다.',
          'λ는 잡음을 얼마나 믿지 않을지 정하는 저울입니다. 키우면 잡음에는 강해지지만 한 점이던 원천이 넓은 언덕으로 번집니다.',
        ]} control={<PrimerRange label="정규화 λ(Regularization)" ariaLabel="Regularization lambda" value={Math.round(lambda * 100)} min={2} max={100} step={2} unit="%" onChange={(value) => setLambda(value / 100)} />}
        readout={(() => { const r = inverseProfile(0.3, lambda); return `봉우리 위치 오차 ${r.errorPct.toFixed(0)}% · 반높이 너비 ${r.widthPct.toFixed(0)}% (머리 폭 대비)` })()}
        lab="source" labNote="정답 위치를 아는 원천으로 역해의 오차 재기">
          <InverseFigure lambda={lambda} />
        </Scene>

        <Scene onLabChange={onLabChange} index={6} title="이제 정답이 없는 실제 기록을 연다" lines={[
          '지금까지는 원천을 우리가 만들었기 때문에 어떤 추정이 맞았는지 채점할 수 있었습니다. 실제 기록에는 그 정답 레이어가 없습니다.',
          '그래서 실제 자료에서는 "맞았다"가 아니라 기록 품질(QC), 재현성, 시뮬레이션에서 배운 함정을 근거로 판단합니다.',
        ]} control={<div className="journey-toggle" role="group" aria-label="자료 종류">
          <button type="button" aria-pressed={!real} className={!real ? 'active' : ''} onClick={() => setReal(false)}>시뮬레이션</button>
          <button type="button" aria-pressed={real} className={real ? 'active' : ''} onClick={() => setReal(true)}>실제 기록</button>
        </div>}
        readout={real ? '정답 레이어 없음 · 채점 불가 · QC와 일관성으로 판단' : '정답 레이어 있음 · 원천별 몫을 알고 채점 가능'}
        lab="real" labNote="내 기록을 안전하게 열고 QC부터 QEEG 지도까지" secondLab="qeeg">
          <TruthFigure real={real} />
        </Scene>

        <Scene onLabChange={onLabChange} index={7} title="화살표의 방향을 묻는다" lines={[
          'A의 과거가 B의 지금을 예측하는가? 두 신호를 조금씩 밀어 가며 닮은 정도를 재면, 봉우리가 생기는 시간차가 누가 먼저 움직였는지를 알려 줍니다.',
          '다만 "먼저 움직였다"는 "원인이다"와 다릅니다. 보이지 않는 제3의 원천이나 전극의 번짐도 같은 모양을 만들 수 있습니다.',
        ]} control={<PrimerRange label="A가 앞서는 시간(Lead)" ariaLabel="Lead of A over B" value={lag} min={-80} max={80} step={5} unit=" ms" onChange={setLag} />}
        readout={(() => { const r = crossCorrelation(drivenPair(lag).a, drivenPair(lag).b); return r.peakLagMs === 0 ? '봉우리 0 ms · 동시에 움직임, 방향을 말할 수 없음' : `봉우리 ${r.peakLagMs > 0 ? '+' : ''}${r.peakLagMs} ms · ${r.peakLagMs > 0 ? 'A가' : 'B가'} ${Math.abs(r.peakLagMs)} ms 먼저 움직임` })()}
        lab="flow" labNote="정답 방향을 아는 모델에서 GC·TE가 맞히는 것과 놓치는 것" secondLab="benchmark">
          <DirectionFigure lag={lag} />
        </Scene>

        <footer className="phase-outro">
          <p>여행은 여기까지입니다. 각 Lab은 이 장면들을 실제 엔진으로 다시 하며, 먼저 예측하고, 실행하고, 정답과 대조하는 순서로 진행합니다. 처음이라면 Lab 01부터 차례로 권합니다.</p>
          <button className="primary-button" onClick={() => onLabChange('filter')}>Lab 01 표본화로 시작하기 <ArrowRight size={15} /></button>
        </footer>
      </section>
    </main>
  )
}

function Scene({ index, title, lines, control, readout, children, lab, labNote, secondLab, onLabChange }: {
  onLabChange: (lab: LabId) => void
  index: number; title: string; lines: [string, string]; control: ReactNode; readout: string; children: ReactNode
  lab?: LabKey; labNote?: string; secondLab?: LabKey
}) {
  return (
    <section className="phase-scene" aria-labelledby={`journey-scene-${index}`}>
      <div className="phase-scene-copy">
        <span className="phase-scene-number">0{index}</span>
        <h2 id={`journey-scene-${index}`}>{title}</h2>
        <p>{lines[0]}</p>
        <p>{lines[1]}</p>
        <div className="phase-scene-control">{control}</div>
        <p className="phase-readout" aria-live="polite">{readout}</p>
        {lab && (
          <div className="journey-links">
            <button className="quiet-button" onClick={() => onLabChange(lab)}>Lab {LABS[lab].number} {LABS[lab].label}로 가기 <ArrowRight size={13} /></button>
            {secondLab && <button className="quiet-button" onClick={() => onLabChange(secondLab)}>Lab {LABS[secondLab].number} {LABS[secondLab].label} <ArrowRight size={13} /></button>}
            {labNote && <small>{labNote}</small>}
          </div>
        )}
      </div>
      <div className="phase-scene-figure">{children}</div>
    </section>
  )
}

function bandName(hz: number) {
  return hz < 4 ? '델타(delta)' : hz < 8 ? '세타(theta)' : hz < 13 ? '알파(alpha)' : hz < 31 ? '베타(beta)' : '감마(gamma)'
}

function StageBar({ stage }: { stage: Stage }) {
  const items: { id: Stage; label: string }[] = [
    { id: 'source', label: '원천(Source)' },
    { id: 'electrode', label: '전극(Electrode)' },
    { id: 'estimate', label: '추정(Estimate)' },
  ]
  return (
    <ol className="journey-stages" aria-label="신호가 지나는 길">
      {items.map((item, index) => (
        <li key={item.id} className={item.id === stage ? 'active' : ''} aria-current={item.id === stage ? 'step' : undefined}>
          {item.label}{index < items.length - 1 && <ArrowRight size={13} aria-hidden="true" />}
        </li>
      ))}
    </ol>
  )
}

function path(values: number[], x0: number, width: number, y0: number, scale: number) {
  return values.map((value, i) => `${i === 0 ? 'M' : 'L'}${(x0 + (i / (values.length - 1)) * width).toFixed(1)},${(y0 - value * scale).toFixed(1)}`).join(' ')
}

function Traces({ rows, height = 60, scale }: { rows: { label: string; values: number[]; color: string; dashed?: boolean }[]; height?: number; scale?: number }) {
  const peak = scale ?? Math.max(...rows.flatMap((row) => row.values.map(Math.abs)), 1e-9)
  return (
    <svg viewBox={`0 0 520 ${rows.length * height + 20}`} className="phase-svg" role="img" aria-label={rows.map((row) => row.label).join(', ')}>
      {rows.map((row, index) => (
        <g key={row.label + index}>
          <text x="0" y={index * height + height / 2 + 14} className="phase-label">{row.label}</text>
          <path d={path(row.values, 110, 400, index * height + height / 2 + 10, (height * 0.42) / peak)} fill="none" stroke={row.color} strokeWidth="1.6" strokeDasharray={row.dashed ? '4 3' : undefined} />
        </g>
      ))}
      <text x="510" y={rows.length * height + 18} textAnchor="end" className="phase-label">{TIMES[TIMES.length - 1]!.toFixed(0)} s</text>
    </svg>
  )
}

function MixingFigure({ spread }: { spread: number }) {
  const weights = useMemo(() => mixingWeights(spread), [spread])
  const sources = useMemo(() => coupledSources(0), [])
  const electrodes = useMemo(() => mix(weights, sources), [weights, sources])
  const sx = (i: number) => 60 + i * 90
  return (
    <div className="journey-mix">
      <svg viewBox="0 0 400 170" className="phase-svg" role="img" aria-label={`원천 4개가 전극 4개로 섞이는 선, 퍼짐 ${Math.round(spread * 100)}%`}>
        <text x="0" y="22" className="phase-label">전극</text>
        <text x="0" y="158" className="phase-label">원천</text>
        {weights.map((row, e) => row.map((w, s) => w > 0.02 && (
          <line key={`${e}-${s}`} x1={sx(SOURCE_X[s]!)} y1={140} x2={sx(ELECTRODE_X[e]!)} y2={34} stroke={SOURCE_COLORS[s]} strokeWidth={0.5 + w * 9} opacity={0.75} />
        )))}
        {ELECTRODE_X.map((_, e) => <g key={e}><rect x={sx(e) - 13} y={16} width={26} height={18} rx={3} fill="#fff" stroke={INK} /><text x={sx(e)} y={29} textAnchor="middle" className="phase-label">E{e + 1}</text></g>)}
        {SOURCE_X.map((_, s) => <g key={s}><circle cx={sx(s)} cy={148} r={10} fill={SOURCE_COLORS[s]} /><text x={sx(s)} y={152} textAnchor="middle" className="phase-label" fill="#fff">{'ABCD'[s]}</text></g>)}
      </svg>
      <Traces rows={electrodes.map((values, e) => ({ label: `E${e + 1}`, values, color: INK }))} height={38} />
    </div>
  )
}

function BlinkFigure({ overlap }: { overlap: number }) {
  const result = useMemo(() => blinkRemoval(overlap), [overlap])
  const scale = Math.max(...result.recorded[0]!.map(Math.abs))
  return (
    <div className="journey-blink">
      <Traces scale={scale} height={64} rows={[
        { label: 'Fp 기록', values: result.recorded[0]!, color: GREY, dashed: true },
        { label: 'Fp 정리 후', values: result.cleaned[0]!, color: TEAL },
        { label: 'Fp 뇌 신호(정답)', values: result.neural[0]!, color: SOURCE_COLORS[1]! },
        { label: 'Fp 제거된 것', values: result.recorded[0]!.map((v, i) => v - result.cleaned[0]![i]!), color: RUST },
      ]} />
      <p className="journey-caption">깜박임 지형 {BLINK_TOPO.map((v) => v.toFixed(2)).join(' · ')} (앞 → 뒤). 같은 축척으로 그렸습니다.</p>
    </div>
  )
}

function ConnectionFigure({ coupling, spread }: { coupling: number; spread: number }) {
  const reading = useMemo(() => connectionReading(coupling, spread), [coupling, spread])
  const bars = [
    { label: '원천 A–B (이음)', value: reading.sourceAB, color: TEAL },
    { label: '전극 E1–E2', value: reading.electrodeAB, color: TEAL, dashed: true },
    { label: '원천 C–D (남남)', value: reading.sourceCD, color: GREY },
    { label: '전극 E3–E4', value: reading.electrodeCD, color: RUST, dashed: true },
  ]
  return (
    <div className="phase-bars journey-bars" role="img" aria-label="원천과 전극에서 잰 상관">
      {bars.map((bar) => (
        <div key={bar.label} className="phase-bar">
          <span>{bar.label}</span>
          <i><b style={{ width: `${Math.max(0, Math.min(1, Math.abs(bar.value))) * 100}%`, background: bar.color, opacity: bar.dashed ? 0.75 : 1 }} /></i>
          <output>{bar.value.toFixed(2)}</output>
        </div>
      ))}
      <p className="journey-caption">상관계수 r의 크기입니다. 전극 E3–E4의 막대는 원천 C–D가 남남인데도 생긴 번짐입니다. 퍼짐은 장면 2의 조절기로 바꿉니다.</p>
    </div>
  )
}

function InverseFigure({ lambda }: { lambda: number }) {
  const result = useMemo(() => inverseProfile(0.3, lambda), [lambda])
  const peak = Math.max(...result.estimate)
  const x = (g: number) => 30 + g * 460
  const y = (v: number) => 140 - (v / peak) * 100
  return (
    <svg viewBox="0 0 520 190" className="phase-svg" role="img" aria-label={`참 원천과 추정 분포, 너비 ${result.widthPct.toFixed(0)}%`}>
      <line x1="30" x2="490" y1="140" y2="140" className="phase-axis" />
       <line x1={x(GRID[result.truthIndex]!)} x2={x(GRID[result.truthIndex]!)} y1="140" y2="24" stroke={INK} strokeWidth="3" />
      <text x={x(GRID[result.truthIndex]!) - 6} y="30" className="phase-label" textAnchor="end">참 원천(점 하나)</text>
      <text x={x(GRID[result.peakIndex]!) + 40} y="60" className="phase-label" fill={TEAL}>추정(minimum-norm)</text>
      <path d={`M${x(0)},140 ` + result.estimate.map((v, i) => `L${x(GRID[i]!).toFixed(1)},${y(Math.max(v, 0)).toFixed(1)}`).join(' ') + ` L${x(1)},140 Z`} fill="rgba(8,127,131,.15)" stroke={TEAL} strokeWidth="2" />
      {SENSORS.map((s, i) => <g key={i}><rect x={x(s) - 6} y={160} width={12} height={10} rx={2} fill="#fff" stroke={INK} /></g>)}
      <text x="30" y="186" className="phase-label">전극 8개</text>
      <text x="490" y="186" className="phase-label" textAnchor="end">머리 앞 ← → 뒤</text>
    </svg>
  )
}

function TruthFigure({ real }: { real: boolean }) {
  const sources = useMemo(() => coupledSources(0), [])
  const weights = useMemo(() => mixingWeights(0.5), [])
  const electrode = useMemo(() => mix(weights, sources)[1]!, [weights, sources])
  const parts = sources.map((values, s) => values.map((v) => v * weights[1]![s]!))
  return (
    <div className="journey-truth">
      <Traces rows={[{ label: 'E2 기록', values: electrode, color: INK }]} height={60} />
      {real ? (
        <div className="journey-locked" role="note">
          <strong>정답 레이어 없음</strong>
          <span>이 기록이 어느 원천에서 얼마씩 왔는지는 아무도 모릅니다. 위상 고정값이 높아도 맞았는지 채점할 방법이 없습니다.</span>
        </div>
      ) : (
        <Traces scale={Math.max(...electrode.map(Math.abs))} height={34} rows={parts.map((values, s) => ({ label: `원천 ${'ABCD'[s]} 몫`, values, color: SOURCE_COLORS[s]! }))} />
      )}
      <p className="journey-caption">설명용 그림입니다. 두 모드 모두 같은 시뮬레이션 파형을 쓰며, 차이는 정답 레이어가 있느냐뿐입니다.</p>
    </div>
  )
}

function DirectionFigure({ lag }: { lag: number }) {
  const pair = useMemo(() => drivenPair(lag), [lag])
  const xc = useMemo(() => crossCorrelation(pair.a, pair.b), [pair])
  const x = (ms: number) => 40 + ((ms + 100) / 200) * 440
  const y = (r: number) => 100 - r * 66
  return (
    <div className="journey-direction">
      <Traces height={40} rows={[{ label: 'A', values: pair.a.slice(0, 200), color: TEAL }, { label: 'B', values: pair.b.slice(0, 200), color: RUST }]} />
      <svg viewBox="0 0 520 192" className="phase-svg" role="img" aria-label={`교차상관, 봉우리 ${xc.peakLagMs} ms`}>
        <line x1="40" x2="480" y1={y(0)} y2={y(0)} className="phase-axis" />
        <line x1={x(0)} x2={x(0)} y1="30" y2="170" className="phase-axis" />
        <path d={xc.lags.map((lagMs, i) => `${i === 0 ? 'M' : 'L'}${x(lagMs).toFixed(1)},${y(xc.values[i]!).toFixed(1)}`).join(' ')} fill="none" stroke={INK} strokeWidth="2" />
        <circle cx={x(xc.peakLagMs)} cy={y(xc.peakValue)} r="4.5" fill={TEAL} />
        <text x={x(xc.peakLagMs) + 7} y={y(xc.peakValue) - 4} className="phase-label">봉우리 {xc.peakLagMs} ms</text>
        {[-100, -50, 0, 50, 100].map((tick) => <text key={tick} x={x(tick)} y="186" textAnchor="middle" className="phase-label">{tick}</text>)}
        <text x="44" y="24" className="phase-label">← B가 먼저</text>
        <text x="476" y="24" className="phase-label" textAnchor="end">A가 먼저 →</text>
      </svg>
      <p className="journey-caption">가로축은 B를 A에 견줘 민 시간(ms), 세로축은 그때의 상관계수입니다.</p>
    </div>
  )
}
