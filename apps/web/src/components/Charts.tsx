import { useId, useMemo } from 'react'

const WIDTH = 900
const HEIGHT = 390
const PAD = { left: 58, right: 24, top: 26, bottom: 42 }
const COLORS = ['#087f83', '#c7653c', '#615b91']

interface Series {
  label: string
  values: number[]
  color?: string
  dashed?: boolean
}

interface LineChartProps {
  x: number[]
  series: Series[]
  xLabel: string
  yLabel: string
  ariaLabel: string
  yDomain?: [number, number]
  xDomain?: [number, number]
  logY?: boolean
  markers?: number[]
}

function finiteExtent(values: number[]): [number, number] {
  const finite = values.filter(Number.isFinite)
  if (!finite.length) return [0, 1]
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  if (min === max) return [min - 1, max + 1]
  const padding = (max - min) * 0.08
  return [min - padding, max + padding]
}

function buildPath(
  x: number[],
  y: number[],
  sx: (value: number) => number,
  sy: (value: number) => number,
  logY: boolean,
): string {
  let path = ''
  const count = Math.min(x.length, y.length)
  for (let index = 0; index < count; index += 1) {
    const xValue = x[index]
    const yValue = y[index]
    if (xValue === undefined || yValue === undefined) continue
    const value = logY ? Math.log10(Math.max(yValue, 1e-12)) : yValue
    if (!Number.isFinite(value)) continue
    path += `${path ? 'L' : 'M'}${sx(xValue).toFixed(2)},${sy(value).toFixed(2)}`
  }
  return path
}

export function LineChart({
  x,
  series,
  xLabel,
  yLabel,
  ariaLabel,
  yDomain,
  xDomain,
  logY = false,
  markers = [],
}: LineChartProps) {
  const id = useId().replace(/:/g, '')
  const domain = useMemo(() => {
    const xs = xDomain ?? finiteExtent(x)
    const allY = series.flatMap((item) => item.values).map((value) => (logY ? Math.log10(Math.max(value, 1e-12)) : value))
    const ys = yDomain ?? finiteExtent(allY)
    return { xs, ys }
  }, [x, xDomain, series, logY, yDomain])
  const innerWidth = WIDTH - PAD.left - PAD.right
  const innerHeight = HEIGHT - PAD.top - PAD.bottom
  const sx = (value: number) => PAD.left + ((value - domain.xs[0]) / (domain.xs[1] - domain.xs[0])) * innerWidth
  const sy = (value: number) => PAD.top + innerHeight - ((value - domain.ys[0]) / (domain.ys[1] - domain.ys[0])) * innerHeight
  const xTicks = Array.from({ length: 6 }, (_, i) => domain.xs[0] + ((domain.xs[1] - domain.xs[0]) * i) / 5)
  const yTicks = Array.from({ length: 5 }, (_, i) => domain.ys[0] + ((domain.ys[1] - domain.ys[0]) * i) / 4)

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={ariaLabel} className="chart">
        <defs>
          <clipPath id={`clip-${id}`}>
            <rect x={PAD.left} y={PAD.top} width={innerWidth} height={innerHeight} />
          </clipPath>
          <linearGradient id={`wash-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#087f83" stopOpacity="0.08" />
            <stop offset="1" stopColor="#087f83" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect x={PAD.left} y={PAD.top} width={innerWidth} height={innerHeight} fill={`url(#wash-${id})`} />
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={sy(tick)} y2={sy(tick)} className="grid-line" />
            <text x={PAD.left - 12} y={sy(tick) + 4} textAnchor="end" className="axis-tick">
              {logY ? `10${tick.toFixed(0)}` : Math.abs(tick) >= 100 ? tick.toFixed(0) : tick.toFixed(1)}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <g key={`x-${tick}`}>
            <line x1={sx(tick)} x2={sx(tick)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="grid-line vertical" />
            <text x={sx(tick)} y={HEIGHT - PAD.bottom + 24} textAnchor="middle" className="axis-tick">
              {tick.toFixed(tick < 10 ? 1 : 0)}
            </text>
          </g>
        ))}
        <g clipPath={`url(#clip-${id})`}>
          {markers.filter((marker) => marker >= domain.xs[0] && marker <= domain.xs[1]).map((marker) => (
            <g key={marker}>
              <line x1={sx(marker)} x2={sx(marker)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="truth-marker" />
              <text x={sx(marker) + 5} y={PAD.top + 14} className="marker-label">{Number.isInteger(marker) ? marker : marker.toFixed(1)} Hz</text>
            </g>
          ))}
          {series.map((item, index) => (
            <path
              key={item.label}
              d={buildPath(x, item.values, sx, sy, logY)}
              fill="none"
              stroke={item.color ?? COLORS[index % COLORS.length]}
              strokeWidth={index === 0 ? 1.8 : 2.25}
              strokeDasharray={item.dashed ? '7 6' : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        <text x={(PAD.left + WIDTH - PAD.right) / 2} y={HEIGHT - 5} textAnchor="middle" className="axis-label">{xLabel}</text>
        <text x={15} y={HEIGHT / 2} transform={`rotate(-90 15 ${HEIGHT / 2})`} textAnchor="middle" className="axis-label">{yLabel}</text>
      </svg>
      <div className="chart-legend" aria-hidden="true">
        {series.map((item, index) => (
          <span key={item.label}><i style={{ background: item.color ?? COLORS[index % COLORS.length] }} />{item.label}</span>
        ))}
      </div>
    </div>
  )
}
