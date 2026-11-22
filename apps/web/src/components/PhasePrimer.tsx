// P1-3: the manual's "phase and arrows" primer as five short interactive scenes before Lab 03.
// Each scene is two sentences and one control; everything is computed in the browser.
import { ArrowRight, Clock3, Compass, Layers, Pause, Play, Shuffle, Sigma } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { epochPhases, lagMs, meanArrow, nullPlv, percentile, phaseMetrics, toArrow } from '../lessons/phaseArrows'
import { LabNavigator, type LabId } from './LabNavigator'

const STEPS = [
  { label: '시계바늘(Phase)', description: '진동은 주파수·진폭·위상으로 적습니다.', icon: Clock3 },
  { label: '화살표 하나', description: '위상차를 길이와 방향으로 그립니다.', icon: Compass },
  { label: '평균 화살표', description: '여러 epoch를 평균하면 일관성이 나옵니다.', icon: Sigma },
  { label: '0°의 함정', description: '번짐은 가로로 누운 화살표를 만듭니다.', icon: Layers },
  { label: '비교 대상', description: '관계가 없을 때의 값과 견줍니다.', icon: Shuffle },
] as const

const FREQUENCY = 10
const TEAL = '#087f83'
const PURPLE = '#615b91'
const RUST = '#c7653c'
const GREY = '#9a9d97'

export function PhasePrimer({ activeLab, onLabChange }: { activeLab: LabId; onLabChange: (lab: LabId) => void }) {
  const [lag, setLag] = useState(60)
  const [scatter, setScatter] = useState(0.3)
  const [meanLag, setMeanLag] = useState(60)
  const [epochs, setEpochs] = useState(8)
  const [scene, setScene] = useState(0)
  const [playing, setPlaying] = useState(() => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  const [time, setTime] = useState(0)

  useEffect(() => {
    if (!playing) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      // Slowed down 20× so a 10 Hz rhythm is followable by eye.
      setTime((current) => (current + (now - last) / 1000 / 20) % 0.2)
      last = now
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  const scatterPhases = useMemo(() => epochPhases(24, 60, scatter, 7), [scatter])
  const scatterMetrics = phaseMetrics(scatterPhases)
  const lagPhases = useMemo(() => epochPhases(24, meanLag, 0.3, 11), [meanLag])
  const lagMetrics = phaseMetrics(lagPhases)
  const nullValues = useMemo(() => nullPlv(epochs, 400, 23), [epochs])
  const threshold = percentile(nullValues, 95)
  const unrelated = useMemo(() => phaseMetrics(epochPhases(epochs, 0, 1, 31)), [epochs])

  return (
    <main className="workspace phase-workspace">
      <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={STEPS} step={scene} />
      <section className="phase-primer" onScroll={(event) => {
        const sections = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('.phase-scene'))
        const top = event.currentTarget.scrollTop + 160
        const current = sections.reduce((found, section, index) => section.offsetTop <= top ? index : found, 0)
        if (current !== scene) setScene(current)
      }}>
        <header className="phase-intro">
          <span className="eyebrow"><span className="data-kind simulated">시뮬레이션 · 정답을 앎</span> 준비 · Lab 03 전에 5분</span>
          <h1>화살표 하나로 읽는 위상</h1>
          <p>연결성, 원천 추정, 정보 흐름의 지표 대부분은 네 가지 생각의 조합입니다. 진동을 시계바늘로 보고, 바늘을 화살표로 적고, 화살표를 평균하고, 그 값을 비교 대상과 견줍니다.</p>
        </header>

        <Scene index={1} title="진동은 시계바늘로 그린다" lines={[
          '10 Hz 리듬은 1초에 10바퀴 도는 바늘입니다. 바늘의 길이가 진폭, 가리키는 방향이 위상입니다.',
          '주파수가 같은 두 바늘은 같은 속도로 돌기 때문에 사이 각도(위상차)가 변하지 않습니다.',
        ]} control={<>
          <PrimerRange label="위상차(Phase difference)" ariaLabel="Phase difference" value={lag} min={0} max={180} step={5} unit="°" onChange={setLag} />
          <button className="quiet-button phase-play" onClick={() => setPlaying((value) => !value)}>{playing ? <><Pause size={13} /> 멈춤</> : <><Play size={13} /> 돌리기</>}</button>
        </>} readout={`${lag}° = ${FREQUENCY} Hz에서 ${lagMs(lag, FREQUENCY).toFixed(1)} ms 늦음`}>
          <ClockAndWaves time={time} lag={lag} />
        </Scene>

        <Scene index={2} title="위상차는 화살표 하나다" lines={[
          '복소수는 길이와 방향을 가진 화살표를 숫자 하나로 적는 방법일 뿐입니다. 가로 성분이 실수부, 세로 성분이 허수부입니다.',
          '위상차가 0°나 180°면 화살표가 가로로 눕고 세로 성분(허수부)이 0이 됩니다. 세로 성분이 있다는 것은 시간 지연이 있다는 뜻입니다.',
        ]} control={<PrimerRange label="위상차(Phase difference)" ariaLabel="Phase difference arrow" value={lag} min={0} max={180} step={5} unit="°" onChange={setLag} />}
        readout={`실수부 ${Math.cos((lag * Math.PI) / 180).toFixed(2)} · 허수부 ${Math.sin((lag * Math.PI) / 180).toFixed(2)}`}>
          <ArrowPlane arrows={[]} mean={toArrow(lag)} showComponents />
        </Scene>

        <Scene index={3} title="화살표를 평균하면 일관성이 나온다" lines={[
          'epoch마다 위상차 화살표를 하나씩 얻어 평균합니다. 매번 비슷한 방향이면 평균 화살표가 길고, 제각각이면 서로 지워져 0에 가까워집니다.',
          '평균 화살표의 길이가 위상 고정값(PLV)입니다. 노를 같은 박자로 저으면 배가 나아가는 것과 같습니다.',
        ]} control={<PrimerRange label="위상 흩어짐(Phase scatter)" ariaLabel="Phase scatter" value={Math.round(scatter * 100)} min={0} max={100} step={5} unit="%" onChange={(value) => setScatter(value / 100)} />}
        readout={`epoch 24개 · PLV ${scatterMetrics.plv.toFixed(2)}`}>
          <ArrowPlane arrows={scatterPhases} mean={meanArrow(scatterPhases)} />
          <MetricBars metrics={[{ label: 'PLV', value: scatterMetrics.plv, color: TEAL }]} />
        </Scene>

        <Scene index={4} title="0° 근처의 화살표는 번짐일 수 있다" lines={[
          '한 원천이 두 전극에 동시에 번지면 위상차가 매번 0°입니다. 한결같으니 PLV와 코히어런스는 높게 나오지만, 두 영역의 대화는 아닙니다.',
          '허수 코히어런스와 wPLI는 세로 성분만 써서 0° 관계를 버립니다. 그래서 번짐에 강하지만 진짜 0° 관계도 놓칩니다.',
        ]} control={<PrimerRange label="평균 위상차(Mean phase difference)" ariaLabel="Mean phase difference" value={meanLag} min={0} max={180} step={5} unit="°" onChange={setMeanLag} />}
        readout={meanLag <= 10 || meanLag >= 170 ? '거의 가로로 누움 · 번짐과 구별할 수 없음' : `세로 성분이 남음 · ${lagMs(meanLag, FREQUENCY).toFixed(1)} ms 지연`}>
          <ArrowPlane arrows={lagPhases} mean={meanArrow(lagPhases)} showComponents />
          <MetricBars metrics={[
            { label: 'PLV', value: lagMetrics.plv, color: TEAL, note: '0°도 센다' },
            { label: '|허수|', value: lagMetrics.imaginary, color: PURPLE, note: '세로 성분' },
            { label: 'wPLI', value: lagMetrics.wpli, color: PURPLE, note: '세로의 부호' },
          ]} />
        </Scene>

        <Scene index={5} title="숫자 하나는 비교 대상이 있어야 읽힌다" lines={[
          '관계가 전혀 없는 두 신호라도 epoch가 적으면 화살표가 우연히 한쪽으로 쏠려 PLV가 0보다 크게 나옵니다. 그래서 자료를 섞어 "관계가 없을 때의 분포"를 만들어 견줍니다.',
          'PPC는 이 표본 수 편향을 수식으로 뺀 값이라, 관계가 없으면 평균 0이 됩니다.',
        ]} control={<PrimerRange label="Epoch 수(Epochs)" ariaLabel="Epoch count" value={epochs} min={4} max={64} step={4} unit="개" onChange={setEpochs} />}
        readout={`관계 없는 신호의 PLV ${unrelated.plv.toFixed(2)} · PPC ${unrelated.ppc.toFixed(2)} · 우연의 95% 경계 ${threshold.toFixed(2)}`}>
          <NullHistogram values={nullValues} threshold={threshold} observed={unrelated.plv} />
        </Scene>

        <footer className="phase-outro">
          <p>Lab 03에서는 같은 화살표를 실제 원천과 센서 EEG에서 계산합니다. 장 퍼짐, 기준전극, 지표를 바꿔 가며 어느 연결선이 혼합에서 왔는지 직접 가려 보세요.</p>
          <button className="primary-button" onClick={() => onLabChange('connectivity')}>Lab 03 연결성으로 가기 <ArrowRight size={15} /></button>
        </footer>
      </section>
    </main>
  )
}

function Scene({ index, title, lines, control, readout, children }: { index: number; title: string; lines: [string, string]; control: React.ReactNode; readout: string; children: React.ReactNode }) {
  return (
    <section className="phase-scene" aria-labelledby={`phase-scene-${index}`}>
      <div className="phase-scene-copy">
        <span className="phase-scene-number">0{index}</span>
        <h2 id={`phase-scene-${index}`}>{title}</h2>
        <p>{lines[0]}</p>
        <p>{lines[1]}</p>
        <div className="phase-scene-control">{control}</div>
        <p className="phase-readout" aria-live="polite">{readout}</p>
      </div>
      <div className="phase-scene-figure">{children}</div>
    </section>
  )
}

export function PrimerRange({ label, ariaLabel, value, min, max, step, unit, onChange }: { label: string; ariaLabel: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void }) {
  return (
    <label className="range-control">
      <span><span className="control-label">{label}</span><output>{value}{unit}</output></span>
      <input type="range" aria-label={ariaLabel} min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} style={{ '--range-progress': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties} />
    </label>
  )
}

function ClockAndWaves({ time, lag }: { time: number; lag: number }) {
  const omega = 2 * Math.PI * FREQUENCY
  const phaseX = omega * time
  const phaseY = phaseX - (lag * Math.PI) / 180
  // The hand's height is the sine wave's value, so hand and trace move together.
  const hand = (phase: number, r: number) => ({ x: 80 + r * Math.cos(phase), y: 90 - r * Math.sin(phase) })
  const tipX = hand(phaseX, 58)
  const tipY = hand(phaseY, 46)
  const wave = (offset: number, phaseShift: number) => Array.from({ length: 121 }, (_, i) => {
    const t = (i / 120) * 0.2
    return `${i === 0 ? 'M' : 'L'}${190 + i * 2.6},${offset - 26 * Math.sin(omega * t - phaseShift)}`
  }).join(' ')
  const cursor = 190 + ((time % 0.2) / 0.2) * 312
  return (
    <svg viewBox="0 0 520 180" role="img" aria-label={`두 시계바늘과 사인파, 위상차 ${lag}도`} className="phase-svg">
      <circle cx="80" cy="90" r="64" className="phase-circle" />
      <line x1="80" y1="90" x2={tipX.x} y2={tipX.y} stroke={TEAL} strokeWidth="3" strokeLinecap="round" />
      <line x1="80" y1="90" x2={tipY.x} y2={tipY.y} stroke={RUST} strokeWidth="3" strokeLinecap="round" />
      <circle cx="80" cy="90" r="3" fill="#202321" />
      <path d={wave(58, 0)} fill="none" stroke={TEAL} strokeWidth="2" />
      <path d={wave(124, (lag * Math.PI) / 180)} fill="none" stroke={RUST} strokeWidth="2" />
      <line x1={cursor} x2={cursor} y1="20" y2="160" stroke={GREY} strokeDasharray="3 4" />
      <text x="194" y="22" className="phase-label">x · 10 Hz</text>
      <text x="194" y="94" className="phase-label">y · {lag}° 늦음</text>
    </svg>
  )
}

function ArrowPlane({ arrows, mean, showComponents = false }: { arrows: number[]; mean: { x: number; y: number }; showComponents?: boolean }) {
  const c = 110
  const r = 88
  const at = (x: number, y: number) => ({ x: c + r * x, y: c - r * y })
  const tip = at(mean.x, mean.y)
  return (
    <svg viewBox="0 0 220 220" role="img" aria-label={`평균 화살표 길이 ${Math.hypot(mean.x, mean.y).toFixed(2)}`} className="phase-svg phase-plane">
      <circle cx={c} cy={c} r={r} className="phase-circle" />
      <line x1={c - r - 8} x2={c + r + 8} y1={c} y2={c} className="phase-axis" />
      <line y1={c - r - 8} y2={c + r + 8} x1={c} x2={c} className="phase-axis" />
      <text x={c + r + 4} y={c + 16} className="phase-label" textAnchor="end">실수 · 0°</text>
      <text x={c + 6} y={c - r - 2} className="phase-label">허수 · 90°</text>
      {arrows.map((deg, index) => {
        const a = toArrow(deg)
        const p = at(a.x, a.y)
        return <line key={index} x1={c} y1={c} x2={p.x} y2={p.y} stroke={GREY} strokeWidth="1.2" opacity=".65" />
      })}
      {showComponents && <>
        <line x1={c} y1={c} x2={tip.x} y2={c} stroke={TEAL} strokeDasharray="4 3" strokeWidth="1.5" />
        <line x1={tip.x} y1={c} x2={tip.x} y2={tip.y} stroke={PURPLE} strokeDasharray="4 3" strokeWidth="1.5" />
      </>}
      <line x1={c} y1={c} x2={tip.x} y2={tip.y} stroke="#202321" strokeWidth="3.2" strokeLinecap="round" markerEnd="url(#phase-head)" />
      <defs><marker id="phase-head" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#202321" /></marker></defs>
    </svg>
  )
}

function MetricBars({ metrics }: { metrics: { label: string; value: number; color: string; note?: string }[] }) {
  return (
    <div className="phase-bars">
      {metrics.map((metric) => (
        <div key={metric.label} className="phase-bar">
          <span>{metric.label}{metric.note && <small>{metric.note}</small>}</span>
          <i><b style={{ width: `${Math.max(0, Math.min(1, metric.value)) * 100}%`, background: metric.color }} /></i>
          <output>{metric.value.toFixed(2)}</output>
        </div>
      ))}
    </div>
  )
}

function NullHistogram({ values, threshold, observed }: { values: number[]; threshold: number; observed: number }) {
  const bins = 20
  const counts = Array.from({ length: bins }, () => 0)
  values.forEach((value) => { counts[Math.min(bins - 1, Math.floor(value * bins))]! += 1 })
  const peak = Math.max(...counts, 1)
  const width = 300
  const x = (value: number) => 20 + value * width
  return (
    <svg viewBox="0 0 340 170" role="img" aria-label={`관계 없는 신호의 PLV 분포, 95% 경계 ${threshold.toFixed(2)}`} className="phase-svg">
      {counts.map((count, index) => (
        <rect key={index} x={x(index / bins) + 1} width={width / bins - 2} y={140 - (count / peak) * 110} height={(count / peak) * 110} fill="#c9d9d6" />
      ))}
      <line x1={x(threshold)} x2={x(threshold)} y1="20" y2="142" stroke={RUST} strokeWidth="2" strokeDasharray="5 4" />
      <text x={x(threshold) + 4} y="34" className="phase-label" fill={RUST}>95% 경계</text>
      <line x1={x(observed)} x2={x(observed)} y1="18" y2="142" stroke={TEAL} strokeWidth="2.5" />
      <text x={x(observed) + 4} y="14" className="phase-label">관계 없는 쌍 하나</text>
      <line x1="20" x2={20 + width} y1="142" y2="142" className="phase-axis" />
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => <text key={tick} x={x(tick)} y="158" className="phase-label" textAnchor="middle">{tick}</text>)}
      <text x="170" y="168" className="phase-label" textAnchor="middle">PLV</text>
    </svg>
  )
}
