import { useId } from 'react'

import type { ConnectivityEdge, ConnectivityMatrix, ConnectivityRecipe } from '../types'
import { SourceFieldHalos } from './SourceSettingViews'

interface MatrixProps {
  matrix: ConnectivityMatrix
  threshold: number
}

// Shared absolute 0–1 mapping: never rescale colors or widths to the visible edges.
const CONNECTIVITY_COLORS = [
  [44, 83, 179],
  [66, 164, 208],
  [242, 211, 117],
  [231, 126, 57],
  [182, 32, 49],
] as const

function connectivityRgb(value: number): number[] {
  const scaled = Math.max(0, Math.min(1, value)) * (CONNECTIVITY_COLORS.length - 1)
  const index = Math.min(Math.floor(scaled), CONNECTIVITY_COLORS.length - 2)
  const fraction = scaled - index
  const from = CONNECTIVITY_COLORS[index]!
  const to = CONNECTIVITY_COLORS[index + 1]!
  return from.map((channel, i) => Math.round(channel + (to[i]! - channel) * fraction))
}

export function connectivityColor(value: number): string {
  return `rgb(${connectivityRgb(value).join(', ')})`
}

export function connectivityTextColor(value: number): string {
  const linear = connectivityRgb(value).map(channel => {
    const srgb = channel / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  })
  const luminance = linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
  return luminance > 0.18 ? '#17221f' : '#ffffff'
}

export const CONNECTIVITY_GRADIENT = `linear-gradient(90deg, ${CONNECTIVITY_COLORS.map((_, i) => `${connectivityColor(i / 4)} ${i * 25}%`).join(', ')})`

export function connectivityLineWidth(value: number): number {
  return 0.7 + 7.3 * Math.max(0, Math.min(1, value)) ** 2.5
}

export function ConnectivityHeatmap({ matrix, threshold }: MatrixProps) {
  const columns = `70px repeat(${matrix.node_names.length}, minmax(20px, 1fr))`
  return (
    <div className="connectivity-heatmap" style={{ gridTemplateColumns: columns }} role="img" aria-label={`${matrix.space} ${matrix.metric} connectivity matrix`}>
      <span />
      {matrix.node_names.map((name) => <span className="heatmap-column" key={name}>{name}</span>)}
      {matrix.values.map((row, rowIndex) => (
        <div className="heatmap-row" key={matrix.node_names[rowIndex]}>
          <span className="heatmap-label">{matrix.node_names[rowIndex]}</span>
          {row.map((value, columnIndex) => (
            <span
              className={`heatmap-cell ${rowIndex !== columnIndex && value >= threshold ? 'detected' : ''}`}
              key={`${rowIndex}-${columnIndex}`}
              style={{ background: rowIndex === columnIndex ? '#e7e9e3' : connectivityColor(value), color: rowIndex === columnIndex ? '#26302d' : connectivityTextColor(value) }}
              title={`${matrix.node_names[rowIndex]} – ${matrix.node_names[columnIndex]}: ${value.toFixed(3)}`}
            >
              {rowIndex === columnIndex ? '—' : value.toFixed(2)}
            </span>
          ))}
        </div>
      ))}
      <div className="heatmap-scale" aria-label="Fixed connectivity color scale from blue at 0 to red at 1"><i style={{ background: CONNECTIVITY_GRADIENT }} /><span>0 · low</span><span>0.5</span><span>1 · high</span></div>
    </div>
  )
}

interface NetworkProps {
  matrix: ConnectivityMatrix
  edges: ConnectivityEdge[]
  threshold: number
  positions?: [number, number][]
  truthVisible: boolean
}

type Point = { x: number; y: number }

function circularPositions(count: number): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / count
    return { x: 150 + 105 * Math.cos(angle), y: 150 + 105 * Math.sin(angle) }
  })
}

// Named positions preserve anatomical directions without reordering matrix rows or edges.
const SOURCE_GRAPH_POSITIONS: Record<string, Point> = {
  'Frontal L': { x: 76, y: 76 },
  'Frontal R': { x: 224, y: 76 },
  'Posterior L': { x: 76, y: 224 },
  'Posterior R': { x: 224, y: 224 },
}

function toScalpPositions(positions: [number, number][]): Point[] {
  return positions.map(([x, y]) => ({ x: 150 + x * 108, y: 150 - y * 108 }))
}

function networkEdgeClass(edge: ConnectivityEdge, truthVisible: boolean): string {
  if (!truthVisible || edge.is_true === null) return 'estimated'
  return edge.is_true ? 'true-edge' : 'false-edge'
}

export function ScalpNetwork({ matrix, edges, positions, threshold, truthVisible }: NetworkProps) {
  const points = positions ? toScalpPositions(positions) : circularPositions(matrix.node_names.length)
  const visibleEdges = edges.filter((edge) => edge.detected)
  return (
    <svg className="network-view" viewBox="0 0 300 310" role="img" aria-label={`Scalp network with ${visibleEdges.length} edges above ${threshold.toFixed(2)}`}>
      <path className="head-outline" d="M150 25 C78 25 42 80 42 158 C42 239 88 279 150 279 C212 279 258 239 258 158 C258 80 222 25 150 25Z" />
      <path className="head-detail" d="M132 28 L150 8 L168 28 M42 125 C20 128 20 182 43 188 M258 125 C280 128 280 182 257 188" />
      <NetworkEdges edges={visibleEdges} names={matrix.node_names} points={points} truthVisible={truthVisible} />
      <NetworkNodes names={matrix.node_names} points={points} compact={false} />
      <text x="150" y="0" textAnchor="middle" className="scalp-orientation">Front</text>
      <text x="8" y="215" className="scalp-orientation">L</text>
      <text x="285" y="215" className="scalp-orientation">R</text>
    </svg>
  )
}

export function CircleNetwork({ matrix, edges, threshold, truthVisible, recipe }: NetworkProps & { recipe?: ConnectivityRecipe }) {
  const sourceLayout = matrix.space !== 'sensor' && matrix.node_names.every(name => Object.hasOwn(SOURCE_GRAPH_POSITIONS, name))
  const points = sourceLayout ? matrix.node_names.map(name => SOURCE_GRAPH_POSITIONS[name]!) : circularPositions(matrix.node_names.length)
  const visibleEdges = edges.filter((edge) => edge.detected)
  return (
    <svg className="network-view circle-network" viewBox="0 0 300 310" role="img" aria-label={`Circular network with ${visibleEdges.length} edges above ${threshold.toFixed(2)}`}>
      {sourceLayout && recipe && <SourceFieldHalos points={points} spread={recipe.volume_conduction} />}
      <circle className="circle-guide" cx="150" cy="150" r="105" />
      {sourceLayout && <g>
        <path className="head-detail" d="M140 45 L150 29 L160 45" />
        <text x="150" y="18" textAnchor="middle" className="scalp-orientation">Front</text>
        <text x="150" y="282" textAnchor="middle" className="scalp-orientation">Back</text>
        <text x="22" y="153" textAnchor="middle" className="scalp-orientation">L</text>
        <text x="278" y="153" textAnchor="middle" className="scalp-orientation">R</text>
        <text x="150" y="303" textAnchor="middle" className="scalp-orientation">Schematic top view</text>
      </g>}
      <NetworkEdges edges={visibleEdges} names={matrix.node_names} points={points} truthVisible={truthVisible} />
      <NetworkNodes names={matrix.node_names} points={points} compact />
      {sourceLayout && recipe && <g>
        <text x="150" y="99" textAnchor="middle" className="source-link-detail">{recipe.coupling_strength > 0 ? `Configured offset ${recipe.phase_lag_deg}°` : 'Offset inactive'}</text>
        <text x="150" y="183" textAnchor="middle" className="source-link-detail">Configured spread {recipe.volume_conduction.toFixed(2)}</text>
      </g>}
      <text className="circle-center-label" x="150" y="148" textAnchor="middle">{matrix.metric.toUpperCase()}</text>
      <text className="circle-center-sub" x="150" y="164" textAnchor="middle">{matrix.band_hz[0]}–{matrix.band_hz[1]} Hz</text>
    </svg>
  )
}

function NetworkEdges({ edges, names, points, truthVisible }: { edges: ConnectivityEdge[]; names: string[]; points: Point[]; truthVisible: boolean }) {
  const id = useId().replace(/:/g, '')
  return (
    <g>
      {[...edges].sort((a, b) => a.weight - b.weight).map((edge) => {
        const sourceIndex = names.indexOf(edge.source)
        const targetIndex = names.indexOf(edge.target)
        const source = points[sourceIndex]
        const target = points[targetIndex]
        if (!source || !target) return null
        return (
          <line
            key={`${edge.source}-${edge.target}`}
            className={`network-edge ${networkEdgeClass(edge, truthVisible)}`}
            x1={source.x}
            y1={source.y}
            x2={target.x}
            y2={target.y}
            strokeWidth={connectivityLineWidth(edge.weight)}
            style={!truthVisible || edge.is_true === null ? { stroke: connectivityColor(edge.weight), opacity: 1 } : undefined}
            aria-labelledby={`${id}-${sourceIndex}-${targetIndex}`}
          >
            <title id={`${id}-${sourceIndex}-${targetIndex}`}>{edge.source} to {edge.target}: {edge.weight.toFixed(3)}</title>
          </line>
        )
      })}
    </g>
  )
}

function NetworkNodes({ names, points, compact }: { names: string[]; points: Point[]; compact: boolean }) {
  return (
    <g>
      {names.map((name, index) => {
        const point = points[index]
        if (!point) return null
        return (
          <g key={name} transform={`translate(${point.x} ${point.y})`}>
            <circle className="network-node" r="12" />
            <text className="network-node-label" y="3" textAnchor="middle">{compact ? name.replace('Frontal L', 'FL').replace('Frontal R', 'FR').replace('Posterior L', 'PL').replace('Posterior R', 'PR') : name}</text>
          </g>
        )
      })}
    </g>
  )
}

export function SurrogateDistribution({ values, threshold, estimate }: { values: number[]; threshold: number; estimate: number }) {
  const bins = 18
  const maximum = Math.max(threshold, estimate, ...values, 0.01) * 1.08
  const counts = Array.from({ length: bins }, () => 0)
  values.forEach((value) => {
    const index = Math.min(bins - 1, Math.floor((value / maximum) * bins))
    counts[index] = (counts[index] ?? 0) + 1
  })
  const peak = Math.max(...counts, 1)
  return (
    <div className="surrogate-chart" role="img" aria-label={`Null surrogate distribution with 95th percentile ${threshold.toFixed(3)} and strongest edge estimate ${estimate.toFixed(3)}`}>
      <div className="surrogate-bars">
        {counts.map((count, index) => <i key={index} style={{ height: `${(count / peak) * 100}%` }} />)}
        <span className="surrogate-threshold" style={{ left: `${(threshold / maximum) * 100}%` }}><b>95%</b></span>
        <span className="surrogate-estimate" style={{ left: `${(estimate / maximum) * 100}%` }}><b>edge</b></span>
      </div>
      <div className="surrogate-axis"><span>0</span><span>{maximum.toFixed(2)}</span></div>
    </div>
  )
}


export function ConnectivityDifference({ a, b }: { a: ConnectivityMatrix; b: ConnectivityMatrix }) {
  return <div className="conn-difference-matrix" role="img" aria-label={`${a.space} connectivity change B minus A, fixed scale minus 1 to plus 1`} style={{ gridTemplateColumns: `80px repeat(${a.node_names.length}, minmax(24px, 1fr))` }}>
    <span />{a.node_names.map(name => <span className="heatmap-column" key={name}>{name}</span>)}
    {a.values.map((row, i) => <div className="heatmap-row" key={a.node_names[i]}>
      <span className="heatmap-label">{a.node_names[i]}</span>
      {row.map((value, j) => {
        const delta = b.values[i]![j]! - value
        const t = Math.min(1, Math.abs(delta))
        const color = delta >= 0
          ? `rgb(${Math.round(245 - 55 * t)}, ${Math.round(245 - 165 * t)}, ${Math.round(240 - 204 * t)})`
          : `rgb(${Math.round(245 - 230 * t)}, ${Math.round(245 - 135 * t)}, ${Math.round(240 - 72 * t)})`
        return <span key={j} className="heatmap-cell" title={`${a.node_names[i]} – ${a.node_names[j]}: B − A = ${delta.toFixed(3)}`} style={{ background: i === j ? '#e7e9e3' : color, color: t > 0.6 ? '#f7f7f3' : '#26302d' }}>{i === j ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`}</span>
      })}
    </div>)}
    <div className="conn-difference-scale"><span>−1 · decreased</span><span>0 · unchanged</span><span>+1 · increased</span></div>
  </div>
}
