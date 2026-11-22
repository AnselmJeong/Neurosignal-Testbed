import { Ruler, X } from 'lucide-react'
import { useMemo, useRef, useState, type PointerEvent } from 'react'

import { formatTime, formatValue, lensWindow, nearestIndex, niceCeil, peakToPeak, roughFrequency, scaleBars } from '../lessons/measure'

export interface LensTrace {
  id: string
  label: string
  values: number[]
  color: string
  dashed?: boolean
}

export interface LensView {
  startTimeS: number
  durationS: number
  /** Largest absolute value on screen, before gain: the viewer's locked scale is built from it. */
  visibleMax: number
  gain: number
}

const HALF_WINDOW_S = 0.5
const W = 268
const H = 120
const PAD = { left: 8, right: 8, top: 10, bottom: 24 }

/**
 * Give it key={channel + time} so a new click in the viewer resets any drag inside the lens.
 * P1-6: click a trace and read it like a ruler. The lens zooms ±0.5 s around the clicked point,
 * prints the value at the point, the peak-to-peak size and a rough rhythm, and draws a scale bar
 * so that "how big" and "how fast" become numbers instead of impressions.
 */
export function MeasurementLens({ x, channel, timeS, traces, unit, view, removed, onClose }: {
  x: number[]
  channel: string | null
  timeS: number | null
  traces: LensTrace[]
  unit: string
  view: LensView | null
  /** For before/after comparisons: show before − after as the removed part. */
  removed?: boolean
  onClose: () => void
}) {
  const [dragTime, setDragTime] = useState<number | null>(null)
  const dragging = useRef(false)
  const t = dragTime ?? timeS
  const scaleText = view ? `화면: 가로 ${formatTime(view.durationS)} · 세로 줄마다 ±${formatScale(niceCeil(view.visibleMax) / view.gain)} ${unit}` : null

  const data = useMemo(() => {
    if (t === null || !channel || !traces.length) return null
    const windows = traces.map((trace) => ({ trace, lens: lensWindow(x, trace.values, t, HALF_WINDOW_S) }))
    const main = windows[windows.length - 1]!
    if (!main.lens.times.length) return null
    const all = windows.flatMap((item) => item.lens.values).filter(Number.isFinite)
    const lo = Math.min(...all)
    const hi = Math.max(...all)
    const pad = (hi - lo) * 0.08 || 1
    const index = nearestIndex(x, t)
    return { windows, main, lo: lo - pad, hi: hi + pad, index, at: x[index]! }
  }, [t, channel, traces, x])

  if (t === null || !channel || !data) {
    return (
      <div className="measure-lens collapsed" role="note">
        <Ruler size={13} />
        <span><b>측정 돋보기(Measurement lens)</b> 파형 위를 클릭하면 그 지점의 값과 크기, 빠르기를 잽니다.</span>
        {scaleText && <small>{scaleText}</small>}
      </div>
    )
  }

  const { windows, main, lo, hi, index, at } = data
  const t0 = main.lens.times[0]!
  const t1 = main.lens.times[main.lens.times.length - 1]!
  const px = (time: number) => PAD.left + ((time - t0) / Math.max(t1 - t0, 1e-9)) * (W - PAD.left - PAD.right)
  const py = (value: number) => PAD.top + (1 - (value - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom)
  const bars = scaleBars(hi - lo, t1 - t0)
  const ptp = peakToPeak(main.lens.values)
  const freq = roughFrequency(main.lens.times, main.lens.values)
  const valueAt = (trace: LensTrace) => trace.values[index] ?? Number.NaN
  const before = removed && traces.length === 2 ? valueAt(traces[0]!) : null
  const after = removed && traces.length === 2 ? valueAt(traces[1]!) : null

  const moveTo = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const fraction = (event.clientX - box.left) / Math.max(box.width, 1)
    const viewX = fraction * W
    const time = t0 + ((viewX - PAD.left) / (W - PAD.left - PAD.right)) * (t1 - t0)
    setDragTime(Math.min(t1, Math.max(t0, time)))
  }
  const barX = W - PAD.right - 4
  const barY = H - PAD.bottom - 2

  return (
    <section className="measure-lens" aria-label="측정 돋보기">
      <header>
        <Ruler size={13} />
        <b>{channel}</b>
        <span>{at.toFixed(3)} s</span>
        {scaleText && <small>{scaleText}</small>}
        <button type="button" aria-label="측정 돋보기 닫기" onClick={onClose}><X size={12} /></button>
      </header>
      <svg
        className="measure-plot"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${channel} 주변 ±${HALF_WINDOW_S}초 확대`}
        onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture?.(event.pointerId); moveTo(event) }}
        onPointerMove={(event) => { if (dragging.current) moveTo(event) }}
        onPointerUp={() => { dragging.current = false }}
      >
        <rect x={0} y={0} width={W} height={H} fill="#fbfbf8" />
        {lo < 0 && hi > 0 && <line x1={PAD.left} x2={W - PAD.right} y1={py(0)} y2={py(0)} stroke="#e1e3dc" />}
        {windows.map(({ trace, lens }) => (
          <polyline
            key={trace.id}
            fill="none"
            stroke={trace.color}
            strokeWidth={trace.dashed ? 1.2 : 1.6}
            strokeDasharray={trace.dashed ? '4 3' : undefined}
            points={lens.times.map((time, i) => `${px(time).toFixed(1)},${py(lens.values[i]!).toFixed(1)}`).join(' ')}
          />
        ))}
        <line x1={px(at)} x2={px(at)} y1={PAD.top - 4} y2={H - PAD.bottom} stroke="#1f2a2a" strokeDasharray="2 2" />
        {windows.map(({ trace }) => Number.isFinite(valueAt(trace)) && <circle key={trace.id} cx={px(at)} cy={py(valueAt(trace))} r={3} fill={trace.color} stroke="#fff" />)}
        <g className="measure-scale" aria-label={`눈금 막대 ${formatScale(bars.amplitude)} ${unit}, ${formatTime(bars.timeS)}`}>
          <line x1={barX} x2={barX} y1={barY} y2={barY - (bars.amplitude / (hi - lo)) * (H - PAD.top - PAD.bottom)} />
          <line x1={barX} x2={barX - (bars.timeS / (t1 - t0)) * (W - PAD.left - PAD.right)} y1={barY} y2={barY} />
          <text x={barX - 4} y={barY - 4} textAnchor="end">{formatScale(bars.amplitude)} {unit}</text>
          <text x={barX - 2} y={barY + 12} textAnchor="end">{formatTime(bars.timeS)}</text>
        </g>
        <text x={PAD.left} y={H - 6} className="measure-axis">{(t0).toFixed(2)} s</text>
      </svg>
      <div className="measure-data">
      <dl>
        {removed && before !== null && after !== null ? (
          <>
            <div><dt>처리 전</dt><dd className="before">{formatValue(before, unit)}</dd></div>
            <div><dt>처리 후</dt><dd className="after">{formatValue(after, unit)}</dd></div>
            <div><dt>제거된 양</dt><dd className="removed">{formatValue(before - after, unit)}</dd></div>
          </>
        ) : (
          <div><dt>이 점의 값</dt><dd className="after">{formatValue(valueAt(traces[traces.length - 1]!), unit)}</dd></div>
        )}
        <div><dt>±0.5 s 안 최대–최소</dt><dd>{formatValue(ptp, unit)}</dd></div>
        <div><dt>어림 리듬</dt><dd>{freq === null ? '—' : `≈ ${freq.toFixed(1)} Hz`}</dd></div>
      </dl>
      <p>왼쪽 확대창(±0.5 s)을 끌면 측정점이 움직입니다. 오른쪽 아래 눈금 막대로 크기와 길이를 어림해 보세요. 어림 리듬은 파형이 평균선을 크게 가로지르는 횟수로 센 값입니다. 여러 리듬이 섞이면 큰 쪽을 따르므로, 정확한 값은 스펙트럼으로 확인하세요.</p>
      </div>
    </section>
  )
}

function formatScale(value: number): string {
  return value >= 1 ? String(Number(value.toPrecision(3))) : String(Number(value.toPrecision(2)))
}
