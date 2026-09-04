import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'

const FALLBACK_WIDTH = 760
const FALLBACK_HEIGHT = 500
const PAD = { left: 66, right: 26, top: 24, bottom: 42 }

interface StackedEegBrowserProps {
  x: number[]
  series: Record<string, number[]>
  ariaLabel: string
}

interface StackedEegComparisonProps extends StackedEegBrowserProps {
  channelNames: string[]
}

function niceAmplitude(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const normalized = value / power
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * power
}

function buildTrace(
  x: number[],
  values: number[],
  sx: (value: number) => number,
  centerY: number,
  pixelsPerUv: number,
): string {
  let path = ''
  const count = Math.min(x.length, values.length)
  for (let index = 0; index < count; index += 1) {
    const xValue = x[index]
    const value = values[index]
    if (xValue === undefined || value === undefined || !Number.isFinite(xValue) || !Number.isFinite(value)) continue
    path += `${path ? 'L' : 'M'}${sx(xValue).toFixed(2)},${(centerY - value * pixelsPerUv).toFixed(2)}`
  }
  return path
}

function usePlotSize() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT })

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const update = ({ width, height }: DOMRectReadOnly) => {
      if (width > 0 && height > 0) setSize({ width, height })
    }
    update(container.getBoundingClientRect())
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  return { containerRef, ...size }
}

export function StackedEegBrowser({ x, series, ariaLabel }: StackedEegBrowserProps) {
  const id = useId().replace(/:/g, '')
  const { containerRef, width, height } = usePlotSize()
  const channels = useMemo(() => Object.entries(series), [series])
  const xMin = x.length ? Math.min(...x) : 0
  const xMax = x.length ? Math.max(...x) : 1
  const maxAbs = Math.max(1, ...channels.flatMap(([, values]) => values.map((value) => Math.abs(value))))
  const amplitude = niceAmplitude(maxAbs)
  const innerWidth = width - PAD.left - PAD.right
  const innerHeight = height - PAD.top - PAD.bottom
  const rowHeight = innerHeight / Math.max(channels.length, 1)
  const pixelsPerUv = (rowHeight * 0.42) / amplitude
  const sx = (value: number) => PAD.left + ((value - xMin) / Math.max(xMax - xMin, Number.EPSILON)) * innerWidth
  const xTicks = Array.from({ length: 7 }, (_, index) => xMin + ((xMax - xMin) * index) / 6)

  return (
    <div className="eeg-browser-wrap" ref={containerRef}>
      <div className="eeg-browser-scale"><span>COMMON DISPLAY RANGE</span>±{amplitude.toFixed(amplitude < 10 ? 1 : 0)} µV</div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} className="eeg-browser">
        <defs>
          <clipPath id={`eeg-clip-${id}`}>
            <rect x={PAD.left} y={PAD.top} width={innerWidth} height={innerHeight} />
          </clipPath>
        </defs>
        <rect x={PAD.left} y={PAD.top} width={innerWidth} height={innerHeight} className="eeg-browser-field" />
        {xTicks.map((tick) => (
          <g key={tick}>
            <line x1={sx(tick)} x2={sx(tick)} y1={PAD.top} y2={height - PAD.bottom} className="eeg-time-grid" />
            <text x={sx(tick)} y={height - 17} textAnchor="middle" className="eeg-time-label">
              {tick.toFixed(tick < 10 ? 1 : 0)}
            </text>
          </g>
        ))}
        {channels.map(([label, values], index) => {
          const centerY = PAD.top + rowHeight * (index + 0.5)
          return (
            <g key={label}>
              {index > 0 && <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + rowHeight * index} y2={PAD.top + rowHeight * index} className="eeg-row-divider" />}
              <line x1={PAD.left} x2={width - PAD.right} y1={centerY} y2={centerY} className="eeg-baseline" />
              <text x={PAD.left - 13} y={centerY + 4} textAnchor="end" className="eeg-channel-label">{label}</text>
              <path
                d={buildTrace(x, values, sx, centerY, pixelsPerUv)}
                clipPath={`url(#eeg-clip-${id})`}
                className="eeg-trace"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )
        })}
        <text x={(PAD.left + width - PAD.right) / 2} y={height - 2} textAnchor="middle" className="eeg-axis-label">Time (s)</text>
      </svg>
    </div>
  )
}

export function StackedEegComparison({ x, series, channelNames, ariaLabel }: StackedEegComparisonProps) {
  const id = useId().replace(/:/g, '')
  const { containerRef, width, height } = usePlotSize()
  const channels = useMemo(() => channelNames.map((label) => ({
    label,
    before: series[`Before · ${label}`] ?? [],
    after: series[`After · ${label}`] ?? [],
  })), [channelNames, series])
  const xMin = x.length ? Math.min(...x) : 0
  const xMax = x.length ? Math.max(...x) : 1
  const maxAbs = Math.max(1, ...channels.flatMap(({ before, after }) => [...before, ...after].map((value) => Math.abs(value))))
  const amplitude = niceAmplitude(maxAbs)
  const innerWidth = width - PAD.left - PAD.right
  const innerHeight = height - PAD.top - PAD.bottom
  const rowHeight = innerHeight / Math.max(channels.length, 1)
  const pixelsPerUv = (rowHeight * 0.42) / amplitude
  const sx = (value: number) => PAD.left + ((value - xMin) / Math.max(xMax - xMin, Number.EPSILON)) * innerWidth
  const xTicks = Array.from({ length: 7 }, (_, index) => xMin + ((xMax - xMin) * index) / 6)

  return (
    <div className="eeg-browser-wrap comparison-browser" ref={containerRef}>
      <div className="eeg-browser-key" aria-label="Trace color key">
        <span><i className="before" />Before · generated EEG</span>
        <span><i className="after" />After · cleaned EEG</span>
        <b>shared range ±{amplitude.toFixed(amplitude < 10 ? 1 : 0)} µV</b>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} className="eeg-browser">
        <defs>
          <clipPath id={`eeg-compare-clip-${id}`}>
            <rect x={PAD.left} y={PAD.top} width={innerWidth} height={innerHeight} />
          </clipPath>
        </defs>
        <rect x={PAD.left} y={PAD.top} width={innerWidth} height={innerHeight} className="eeg-browser-field" />
        {xTicks.map((tick) => (
          <g key={tick}>
            <line x1={sx(tick)} x2={sx(tick)} y1={PAD.top} y2={height - PAD.bottom} className="eeg-time-grid" />
            <text x={sx(tick)} y={height - 17} textAnchor="middle" className="eeg-time-label">
              {tick.toFixed(tick < 10 ? 1 : 0)}
            </text>
          </g>
        ))}
        {channels.map(({ label, before, after }, index) => {
          const centerY = PAD.top + rowHeight * (index + 0.5)
          return (
            <g key={label}>
              {index > 0 && <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + rowHeight * index} y2={PAD.top + rowHeight * index} className="eeg-row-divider" />}
              <line x1={PAD.left} x2={width - PAD.right} y1={centerY} y2={centerY} className="eeg-baseline" />
              <text x={PAD.left - 13} y={centerY + 4} textAnchor="end" className="eeg-channel-label">{label}</text>
              <path d={buildTrace(x, before, sx, centerY, pixelsPerUv)} clipPath={`url(#eeg-compare-clip-${id})`} className="eeg-trace before" vectorEffect="non-scaling-stroke" />
              <path d={buildTrace(x, after, sx, centerY, pixelsPerUv)} clipPath={`url(#eeg-compare-clip-${id})`} className="eeg-trace after" vectorEffect="non-scaling-stroke" />
            </g>
          )
        })}
        <text x={(PAD.left + width - PAD.right) / 2} y={height - 2} textAnchor="middle" className="eeg-axis-label">Time (s)</text>
      </svg>
    </div>
  )
}
