// P2-2: practice games. Seeded questions with known answers: spot the artifact with staged clues,
// decide whether a peak is real, restore a noisy signal in a sandbox, and one shared question a day.
import { ArrowRight, CalendarDays, Eye, FlaskConical, Mountain, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import {
  ARTIFACTS, ARTIFACT_KINDS, CLIP_TIMES, CLUE_POINTS, GAME_FS, SANDBOX_TIMES, amplitudeSpectrum, applyFilters, artifactClip,
  connectionQuestion, dailyGame, dailySeed, restorationScore, sandboxClean, sandboxNoise, sourceQuestion,
  type ArtifactKind, type FilterSettings, type NoiseSettings,
} from '../lessons/games'
import { GRID } from '../lessons/journey'
import { niceStep } from '../lessons/measure'
import { LabNavigator, type LabId } from './LabNavigator'
import { PrimerRange } from './PhasePrimer'
import { ScalpTopography } from './ScalpTopography'

const TEAL = '#087f83'
const RUST = '#c7653c'
const GREY = '#9a9d97'
const INK = '#202321'

type Tab = 'daily' | 'artifact' | 'peak' | 'sandbox'

const TABS: { id: Tab; label: string; icon: typeof Eye; description: string }[] = [
  { id: 'daily', label: '오늘의 문제', icon: CalendarDays, description: '날짜로 정한 한 문제. 같은 날에는 모두 같은 문제를 받습니다.' },
  { id: 'artifact', label: '아티팩트 맞히기', icon: Eye, description: '단서를 하나씩 열며 3초 파형의 정체를 맞힙니다.' },
  { id: 'peak', label: '이 봉우리는 진짜인가', icon: Mountain, description: '연결선이나 원천 지도의 한 점이 심어 둔 것인지 번진 것인지 가립니다.' },
  { id: 'sandbox', label: '샌드박스', icon: SlidersHorizontal, description: '잡음을 직접 더하고 필터로 복원해 점수를 받습니다.' },
]

export function PracticeGames({ activeLab, onLabChange, today = new Date() }: { activeLab: LabId; onLabChange: (lab: LabId) => void; today?: Date }) {
  const [tab, setTab] = useState<Tab>('daily')
  const steps = TABS.map(({ label, description, icon }) => ({ label, description, icon }))
  return (
    <main className="workspace phase-workspace">
      <LabNavigator activeLab={activeLab} onLabChange={onLabChange} steps={steps} step={TABS.findIndex((item) => item.id === tab)} />
      <section className="phase-primer practice">
        <header className="phase-intro">
          <span className="eyebrow"><span className="data-kind simulated">시뮬레이션 · 정답을 앎</span> 연습장 · 문제는 무한히 만들어집니다</span>
          <h1>연습장(Practice)</h1>
          <p>Lab에서 배운 판독을 짧은 문제로 반복합니다. 모든 문제는 seed로 만든 시뮬레이션이라 정답이 정해져 있고, 답한 뒤에는 왜 그런지 단서를 함께 보여 줍니다.</p>
        </header>
        <div className="practice-tabs" role="tablist" aria-label="연습 종류">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={14} /> {label}</button>
          ))}
        </div>
        <div role="tabpanel" aria-label={TABS.find((item) => item.id === tab)!.label}>
          {tab === 'daily' && <DailyQuestion today={today} onLabChange={onLabChange} />}
          {tab === 'artifact' && <ArtifactGame />}
          {tab === 'peak' && <PeakGame />}
          {tab === 'sandbox' && <Sandbox />}
        </div>
      </section>
    </main>
  )
}

// ── shared bits ────────────────────────────────────────────────────────────────────────────────

interface Line { values: number[]; color: string; dashed?: boolean; width?: number; label?: string }

function TracePlot({ times, lines, height = 150, unit = 'µV', ariaLabel, marker }: { times: number[]; lines: Line[]; height?: number; unit?: string; ariaLabel: string; marker?: number }) {
  const W = 560
  const pad = { l: 8, r: 8, t: 10, b: 22 }
  const all = lines.flatMap((line) => line.values).filter(Number.isFinite)
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const range = hi - lo || 1
  const x = (t: number) => pad.l + ((t - times[0]!) / (times[times.length - 1]! - times[0]!)) * (W - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - lo) / range) * (height - pad.t - pad.b)
  const bar = niceStep(range / 3)
  const duration = times[times.length - 1]! - times[0]!
  const timeBar = niceStep(duration / 4)
  const bx = W - pad.r - 4
  const by = height - pad.b
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="practice-plot" role="img" aria-label={ariaLabel}>
      {lines.map((line, index) => (
        <path key={index} d={line.values.map((v, i) => `${i ? 'L' : 'M'}${x(times[i]!).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} fill="none" stroke={line.color} strokeWidth={line.width ?? 1.4} strokeDasharray={line.dashed ? '4 3' : undefined} />
      ))}
      {marker !== undefined && <line x1={x(marker)} x2={x(marker)} y1={pad.t} y2={by} stroke={INK} strokeDasharray="2 3" />}
      <g className="practice-scale">
        <line x1={bx} x2={bx} y1={by} y2={by - (bar / range) * (height - pad.t - pad.b)} />
        <line x1={bx} x2={bx - (timeBar / duration) * (W - pad.l - pad.r)} y1={by} y2={by} />
        <text x={bx - 4} y={by - 4} textAnchor="end">{bar} {unit}</text>
        <text x={bx} y={by + 14} textAnchor="end">{timeBar < 1 ? `${Math.round(timeBar * 1000)} ms` : `${timeBar} s`}</text>
      </g>
    </svg>
  )
}

function Verdict({ correct, children }: { correct: boolean; children: ReactNode }) {
  return <div className={`practice-verdict ${correct ? 'correct' : 'wrong'}`} role="status"><strong>{correct ? '맞았습니다.' : '아쉽습니다.'}</strong> {children}</div>
}

// ── Artifact quiz ──────────────────────────────────────────────────────────────────────────────

const CLUES = ['파형 일부(0.5초)', '파형 전체(3초)', '스펙트럼', '지형도']

export function ArtifactGame({ seed: fixedSeed, onScore }: { seed?: number; onScore?: (points: number) => void }) {
  const [seed, setSeed] = useState(fixedSeed ?? 1 + Math.floor(Math.random() * 9999))
  const [stage, setStage] = useState(0)
  const [answer, setAnswer] = useState<ArtifactKind | null>(null)
  const [total, setTotal] = useState({ points: 0, played: 0 })
  const clip = useMemo(() => artifactClip(seed), [seed])
  const focus = clip.data[clip.focus]!
  const spectrum = useMemo(() => amplitudeSpectrum(focus), [focus])
  const shown = answer ? 3 : stage
  const sliceStart = Math.max(0, Math.round((clip.centerS - 0.25) * GAME_FS))
  const slice = { times: CLIP_TIMES.slice(sliceStart, sliceStart + GAME_FS / 2), values: focus.slice(sliceStart, sliceStart + GAME_FS / 2) }
  const correct = answer === clip.kind

  const choose = (kind: ArtifactKind) => {
    if (answer) return
    setAnswer(kind)
    const points = kind === clip.kind ? CLUE_POINTS[stage]! : 0
    setTotal((current) => ({ points: current.points + points, played: current.played + 1 }))
    onScore?.(points)
  }
  const next = () => { setSeed((value) => value + 1); setStage(0); setAnswer(null) }

  return (
    <section className="practice-card" aria-label="아티팩트 맞히기">
      <header className="practice-head">
        <div><strong>문제 #{seed}</strong><span>{clip.channels[clip.focus]} 채널 · 3초 · {GAME_FS} Hz</span></div>
        {fixedSeed === undefined && <span className="practice-score">점수 {total.points} · {total.played}문제</span>}
      </header>
      <ol className="practice-clues" aria-label="단서">
        {CLUES.map((label, index) => <li key={label} className={index <= shown ? 'open' : ''}>{index + 1}. {label}<small>{CLUE_POINTS[index]}점</small></li>)}
      </ol>
      <div className="practice-clue-grid">
        <figure><figcaption>1 · 파형 일부</figcaption><TracePlot times={slice.times} lines={[{ values: slice.values, color: INK }]} height={120} ariaLabel="0.5초 파형" /></figure>
        {shown >= 1 && <figure><figcaption>2 · 파형 전체</figcaption><TracePlot times={CLIP_TIMES} lines={[{ values: focus, color: INK }]} height={120} ariaLabel="3초 파형" /></figure>}
        {shown >= 2 && <figure><figcaption>3 · 스펙트럼(로그 진폭, 0–100 Hz)</figcaption><SpectrumPlot hz={spectrum.hz} amp={spectrum.amp} /></figure>}
        {shown >= 3 && <figure className="practice-topo"><figcaption>4 · 아티팩트 크기 지형도</figcaption><ScalpTopography values={clip.topography} label="아티팩트" channelNames={clip.channels} /></figure>}
      </div>
      {!answer && stage < 3 && <button className="quiet-button practice-next-clue" onClick={() => setStage((value) => value + 1)}>다음 단서 열기 ({CLUE_POINTS[stage + 1]}점으로 내려감)</button>}
      <div className="practice-choices" role="group" aria-label="정답 고르기">
        {ARTIFACT_KINDS.map((kind) => (
          <button key={kind} disabled={!!answer} className={answer ? (kind === clip.kind ? 'is-answer' : kind === answer ? 'is-wrong' : '') : ''} onClick={() => choose(kind)}>
            {ARTIFACTS[kind].label}<small>{ARTIFACTS[kind].english}</small>
          </button>
        ))}
      </div>
      {answer && (
        <>
          <Verdict correct={correct}>{correct ? `단서 ${stage + 1}개로 맞혀 ${CLUE_POINTS[stage]}점입니다.` : `정답은 ${ARTIFACTS[clip.kind].label}입니다.`}</Verdict>
          <ul className="practice-tells">
            {ARTIFACTS[clip.kind].tell.map((line, index) => <li key={line}><b>{['모양', '주파수', '위치'][index]}</b> {line}</li>)}
          </ul>
          {fixedSeed === undefined && <button className="primary-button practice-next" onClick={next}>다음 문제 <ArrowRight size={14} /></button>}
        </>
      )}
      <p className="practice-note">판독 순서 자체가 연습입니다. 파형의 모양, 그다음 주파수, 마지막으로 위치를 봅니다. 앞 단서만으로 맞힐수록 점수가 높습니다.</p>
    </section>
  )
}

function SpectrumPlot({ hz, amp }: { hz: number[]; amp: number[] }) {
  const W = 560
  const H = 130
  const logs = amp.map((value) => Math.log10(Math.max(value, 1e-3)))
  const lo = Math.min(...logs)
  const hi = Math.max(...logs)
  const x = (f: number) => 30 + (f / 100) * (W - 40)
  const y = (v: number) => 10 + (1 - (v - lo) / (hi - lo || 1)) * (H - 34)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="practice-plot" role="img" aria-label="진폭 스펙트럼">
      <path d={logs.map((v, i) => `${i ? 'L' : 'M'}${x(hz[i]!).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} fill="none" stroke={TEAL} strokeWidth="1.5" />
      {[0, 10, 20, 30, 40, 50, 60, 80, 100].map((f) => <text key={f} x={x(f)} y={H - 6} textAnchor="middle" className="practice-tick">{f}</text>)}
      <text x={W - 4} y={14} textAnchor="end" className="practice-tick">Hz →</text>
    </svg>
  )
}

// ── Is this peak real? ─────────────────────────────────────────────────────────────────────────

export function PeakGame({ seed: fixedSeed, mode, onScore }: { seed?: number; mode?: 'connection' | 'source'; onScore?: (points: number) => void }) {
  const [seed, setSeed] = useState(fixedSeed ?? 1 + Math.floor(Math.random() * 9999))
  const [answer, setAnswer] = useState<boolean | null>(null)
  const [total, setTotal] = useState({ right: 0, played: 0 })
  const kind = mode ?? (seed % 2 === 0 ? 'connection' : 'source')
  const connection = useMemo(() => (kind === 'connection' ? connectionQuestion(seed) : null), [kind, seed])
  const source = useMemo(() => (kind === 'source' ? sourceQuestion(seed) : null), [kind, seed])
  const truth = connection ? connection.real : source!.real
  const choose = (value: boolean) => {
    if (answer !== null) return
    setAnswer(value)
    setTotal((current) => ({ right: current.right + Number(value === truth), played: current.played + 1 }))
    onScore?.(value === truth ? 1 : 0)
  }
  const next = () => { setSeed((value) => value + 1); setAnswer(null) }

  return (
    <section className="practice-card" aria-label="이 봉우리는 진짜인가">
      <header className="practice-head">
        <div><strong>문제 #{seed}</strong><span>{connection ? 'Lab 03 · 센서 연결선' : 'Lab 04 · 원천 지도'}</span></div>
        {fixedSeed === undefined && <span className="practice-score">{total.right} / {total.played} 맞힘</span>}
      </header>
      {connection && <ConnectionView question={connection} revealed={answer !== null} />}
      {source && <SourceView question={source} revealed={answer !== null} />}
      <div className="practice-choices two" role="group" aria-label="정답 고르기">
        <button disabled={answer !== null} className={answer !== null ? (truth ? 'is-answer' : answer ? 'is-wrong' : '') : ''} onClick={() => choose(true)}>
          {connection ? '심어 둔 결합' : '진짜 원천 자리'}<small>{connection ? 'Planted coupling' : 'True source'}</small>
        </button>
        <button disabled={answer !== null} className={answer !== null ? (!truth ? 'is-answer' : !answer ? 'is-wrong' : '') : ''} onClick={() => choose(false)}>
          {connection ? '볼륨 전도(번짐)' : '이웃 원천의 번짐(누설)'}<small>{connection ? 'Volume conduction' : 'Leakage'}</small>
        </button>
      </div>
      {answer !== null && (
        <>
          <Verdict correct={answer === truth}>
            {connection
              ? connection.real
                ? `원천 ${'ABCD'[connection.pair[0]]}–${'ABCD'[connection.pair[1]]}는 ${Math.abs(connection.lagMs)} ms 지연으로 이어져 있었습니다. 지연이 있는 결합은 0 ms에서 비켜난 봉우리나 어깨를 만듭니다.`
                : `원천 ${'ABCD'[connection.pair[0]]}–${'ABCD'[connection.pair[1]]}는 남남이었습니다. 0 ms에 선 대칭 봉우리는 한 원천이 두 전극에 동시에 번진 흔적입니다.`
              : source!.real
                ? '표시한 점이 바로 심어 둔 원천 자리였습니다. 그 점이 지도의 국소 최댓값입니다.'
                : `원천은 ${Math.abs(source!.truthIndex - source!.probe)}칸 떨어진 곳에 있었습니다. 봉우리의 비탈에 있는 값은 커도 원천이 아니라 번진 것입니다.`}
          </Verdict>
          {fixedSeed === undefined && <button className="primary-button practice-next" onClick={next}>다음 문제 <ArrowRight size={14} /></button>}
        </>
      )}
    </section>
  )
}

function ConnectionView({ question, revealed }: { question: ReturnType<typeof connectionQuestion>; revealed: boolean }) {
  const W = 560
  const H = 200
  const x = (lag: number) => 40 + ((lag + 80) / 160) * (W - 60)
  const y = (r: number) => 100 - r * 80
  const curve = (values: number[]) => question.electrode.lags.map((lag, i) => `${i ? 'L' : 'M'}${x(lag).toFixed(1)},${y(values[i]!).toFixed(1)}`).join(' ')
  const [a, b] = question.pair
  return (
    <div className="practice-question">
      <p>전극 <b>E{a + 1}</b>와 <b>E{b + 1}</b>가 함께 움직입니다(최대 상관 {question.electrode.peakValue.toFixed(2)}). 아래는 E{b + 1} 신호를 E{a + 1} 신호에 견줘 앞뒤로 밀며 잰 상관입니다. 이 연결선은 원천 사이의 결합에서 왔을까요, 번짐에서 왔을까요?</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="practice-plot" role="img" aria-label={`전극 E${a + 1}–E${b + 1} 교차상관`}>
        <line x1="40" x2={W - 20} y1={y(0)} y2={y(0)} stroke="#d4d6cf" />
        <line x1={x(0)} x2={x(0)} y1="14" y2={H - 22} stroke="#d4d6cf" />
        <path d={curve(question.electrode.values)} fill="none" stroke={INK} strokeWidth="2" />
        {revealed && <path d={curve(question.source.values)} fill="none" stroke={TEAL} strokeWidth="1.6" strokeDasharray="5 3" />}
        {[-80, -40, 0, 40, 80].map((tick) => <text key={tick} x={x(tick)} y={H - 6} textAnchor="middle" className="practice-tick">{tick} ms</text>)}
        <text x={x(question.electrode.peakLagMs) + 6} y={y(question.electrode.peakValue) - 6} className="practice-tick">봉우리 {question.electrode.peakLagMs} ms</text>
      </svg>
      <small className="practice-legend"><i style={{ background: INK }} /> 전극에서 잰 값{revealed && <><i style={{ background: TEAL }} /> 원천에서 잰 값(정답)</>}</small>
    </div>
  )
}

function SourceView({ question, revealed }: { question: ReturnType<typeof sourceQuestion>; revealed: boolean }) {
  const W = 560
  const H = 180
  const peak = Math.max(...question.estimate)
  const x = (g: number) => 30 + g * (W - 60)
  const y = (v: number) => 140 - (Math.max(v, 0) / peak) * 110
  const probeX = x(GRID[question.probe]!)
  return (
    <div className="practice-question">
      <p>원천 지도(minimum-norm 추정)에서 화살표가 가리킨 점의 값은 봉우리의 <b>{Math.round((question.estimate[question.probe]! / peak) * 100)}%</b>입니다. 이 점에 원천이 있을까요?</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="practice-plot" role="img" aria-label="1차원 원천 지도">
        <line x1="30" x2={W - 30} y1="140" y2="140" stroke="#d4d6cf" />
        <path d={`M${x(0)},140 ` + question.estimate.map((v, i) => `L${x(GRID[i]!).toFixed(1)},${y(v).toFixed(1)}`).join(' ') + ` L${x(1)},140 Z`} fill="rgba(8,127,131,.14)" stroke={TEAL} strokeWidth="2" />
        <path d={`M${probeX},${y(question.estimate[question.probe]!) - 26} l-6,-10 h12 z`} fill={RUST} />
        <line x1={probeX} x2={probeX} y1={y(question.estimate[question.probe]!) - 24} y2={y(question.estimate[question.probe]!)} stroke={RUST} strokeWidth="2" />
        {revealed && <><line x1={x(GRID[question.truthIndex]!)} x2={x(GRID[question.truthIndex]!)} y1="140" y2="22" stroke={INK} strokeWidth="3" /><text x={x(GRID[question.truthIndex]!) + 6} y="22" className="practice-tick">심어 둔 원천</text></>}
        <text x="30" y="166" className="practice-tick">머리 앞</text>
        <text x={W - 30} y="166" textAnchor="end" className="practice-tick">뒤</text>
      </svg>
    </div>
  )
}

// ── Sandbox ────────────────────────────────────────────────────────────────────────────────────

const HIGH_PASS = [0, 0.5, 1, 2, 4, 8]
const LOW_PASS = [0, 45, 30, 20, 15, 12]

export function Sandbox() {
  const [noise, setNoise] = useState<NoiseSettings>({ line: 15, drift: 30, muscle: 8 })
  const [filters, setFilters] = useState<FilterSettings>({ highPass: 0, lowPass: 0, notch: false })
  const clean = useMemo(() => sandboxClean(), [])
  const noisy = useMemo(() => sandboxNoise(noise).map((v, i) => v + clean[i]!), [noise, clean])
  const restored = useMemo(() => applyFilters(noisy, filters), [noisy, filters])
  const score = restorationScore(clean, noisy, restored)
  const view = SANDBOX_TIMES.length / 2
  const times = SANDBOX_TIMES.slice(0, view)
  return (
    <section className="practice-card" aria-label="샌드박스">
      <header className="practice-head">
        <div><strong>복원 샌드박스</strong><span>정답 신호: 10 Hz 알파 + 6 Hz 세타 · Lab 01·02의 필터 감각 익히기</span></div>
        <span className="practice-score big">{score.score}점</span>
      </header>
      <div className="practice-sandbox">
        <div className="practice-controls">
          <h3><FlaskConical size={14} /> 잡음 더하기</h3>
          <PrimerRange label="전원 잡음 60 Hz(Line noise)" ariaLabel="Line noise amplitude" value={noise.line} min={0} max={40} step={1} unit=" µV" onChange={(line) => setNoise((n) => ({ ...n, line }))} />
          <PrimerRange label="느린 표류(Drift)" ariaLabel="Drift amplitude" value={noise.drift} min={0} max={80} step={2} unit=" µV" onChange={(drift) => setNoise((n) => ({ ...n, drift }))} />
          <PrimerRange label="근전도(Muscle)" ariaLabel="Muscle amplitude" value={noise.muscle} min={0} max={30} step={1} unit=" µV" onChange={(muscle) => setNoise((n) => ({ ...n, muscle }))} />
          <h3><SlidersHorizontal size={14} /> 복원하기</h3>
          <label className="practice-select">고역 통과(High-pass)
            <select aria-label="High-pass cutoff" value={filters.highPass} onChange={(event) => setFilters((f) => ({ ...f, highPass: Number(event.target.value) }))}>
              {HIGH_PASS.map((hz) => <option key={hz} value={hz}>{hz ? `${hz} Hz` : '끔'}</option>)}
            </select>
          </label>
          <label className="practice-select">저역 통과(Low-pass)
            <select aria-label="Low-pass cutoff" value={filters.lowPass} onChange={(event) => setFilters((f) => ({ ...f, lowPass: Number(event.target.value) }))}>
              {LOW_PASS.map((hz) => <option key={hz} value={hz}>{hz ? `${hz} Hz` : '끔'}</option>)}
            </select>
          </label>
          <label className="practice-check"><input type="checkbox" aria-label="60 Hz notch" checked={filters.notch} onChange={(event) => setFilters((f) => ({ ...f, notch: event.target.checked }))} /> 60 Hz 노치(Notch)</label>
          <button className="quiet-button" onClick={() => setFilters({ highPass: 0, lowPass: 0, notch: false })}><RotateCcw size={13} /> 필터 지우기</button>
        </div>
        <div className="practice-sandbox-plots">
          <TracePlot times={times} height={170} ariaLabel="처리 전과 처리 후, 정답 신호" lines={[
            { values: noisy.slice(0, view), color: GREY, dashed: true },
            { values: clean.slice(0, view), color: INK, width: 1 },
            { values: restored.slice(0, view), color: TEAL, width: 1.8 },
          ]} />
          <small className="practice-legend"><i style={{ background: GREY }} /> 처리 전 <i style={{ background: INK }} /> 정답 <i style={{ background: TEAL }} /> 처리 후</small>
          <TracePlot times={times} height={90} ariaLabel="남은 오차" lines={[{ values: restored.slice(0, view).map((v, i) => v - clean[i]!), color: RUST }]} />
          <small className="practice-legend"><i style={{ background: RUST }} /> 남은 오차 = 처리 후 − 정답</small>
          <dl className="practice-metrics">
            <div><dt>더한 오차 중 없앤 비율</dt><dd>{Math.round(score.errorRemoved * 100)}%</dd></div>
            <div><dt>남은 오차(RMS)</dt><dd>{score.errorUv.toFixed(1)} µV</dd></div>
            <div><dt>정답과의 상관</dt><dd>{score.kept.toFixed(2)}</dd></div>
          </dl>
          <p className="practice-note">점수는 남은 오차를 정답 신호의 크기와 견준 값입니다(100 = 정답과 똑같음). 필터를 세게 걸면 잡음과 함께 알파·세타도 깎여 점수가 다시 내려갑니다. 8 Hz 고역 통과로 세타가 어떻게 되는지 확인해 보세요. 남은 오차의 맨 앞이 크게 휘는 것은 필터의 가장자리 효과(edge effect)입니다.</p>
        </div>
      </div>
    </section>
  )
}

// ── Today's question ───────────────────────────────────────────────────────────────────────────

function DailyQuestion({ today, onLabChange }: { today: Date; onLabChange: (lab: LabId) => void }) {
  const seed = dailySeed(today)
  const game = dailyGame(seed)
  const date = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일`
  return (
    <div className="practice-daily">
      <p className="practice-daily-head"><CalendarDays size={14} /> {date}의 문제 · 같은 날에는 모두 같은 문제를 받습니다. 강의에서 함께 풀어 보세요.</p>
      {game === 'artifact' ? <ArtifactGame seed={seed} /> : <PeakGame seed={seed} mode={game} />}
      <p className="practice-note">더 풀고 싶으면 위의 다른 탭에서 문제를 계속 만들 수 있습니다. 관련 Lab: <button className="link-button" onClick={() => onLabChange(game === 'artifact' ? 'ica' : game === 'connection' ? 'connectivity' : 'source')}>{game === 'artifact' ? 'Lab 02 ICA' : game === 'connection' ? 'Lab 03 연결성' : 'Lab 04 원천'}</button></p>
    </div>
  )
}
