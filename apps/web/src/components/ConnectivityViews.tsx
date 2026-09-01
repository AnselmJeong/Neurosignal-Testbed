import { useId } from 'react'

import type { ConnectivityEdge, ConnectivityMatrix } from '../types'

interface MatrixProps {
  matrix: ConnectivityMatrix
  threshold: number
}

function heatColor(value: number): string {
  const clamped = Math.max(0, Math.min(1, value))
  if (clamped < 0.5) {
    const t = clamped * 2
    return `rgb(${Math.round(34 - 18 * t)}, ${Math.round(49 + 71 * t)}, ${Math.round(74 + 42 * t)})`
  }
  const t = (clamped - 0.5) * 2
  return `rgb(${Math.round(16 + 196 * t)}, ${Math.round(120 + 70 * t)}, ${Math.round(116 - 64 * t)})`
}

export function ConnectivityHeatmap({ matrix, threshold }: MatrixProps) {
  const columns = `70px repeat(${matrix.node_names.length}, minmax(38px, 1fr))`
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
              style={{ background: rowIndex === columnIndex ? '#dedfd9' : heatColor(value) }}
              title={`${matrix.node_names[rowIndex]} – ${matrix.node_names[columnIndex]}: ${value.toFixed(3)}`}
            >
              {rowIndex === columnIndex ? '—' : value.toFixed(2)}
            </span>
          ))}
        </div>
      ))}
      <div className="heatmap-scale" aria-hidden="true"><i /><span>0</span><span>1</span></div>
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
    </svg>
  )
}

export function CircleNetwork({ matrix, edges, threshold, truthVisible }: NetworkProps) {
  const points = circularPositions(matrix.node_names.length)
  const visibleEdges = edges.filter((edge) => edge.detected)
  return (
    <svg className="network-view circle-network" viewBox="0 0 300 310" role="img" aria-label={`Circular network with ${visibleEdges.length} edges above ${threshold.toFixed(2)}`}>
      <circle className="circle-guide" cx="150" cy="150" r="105" />
      <NetworkEdges edges={visibleEdges} names={matrix.node_names} points={points} truthVisible={truthVisible} />
      <NetworkNodes names={matrix.node_names} points={points} compact />
      <text className="circle-center-label" x="150" y="148" textAnchor="middle">{matrix.metric.toUpperCase()}</text>
      <text className="circle-center-sub" x="150" y="164" textAnchor="middle">{matrix.band_hz[0]}–{matrix.band_hz[1]} Hz</text>
    </svg>
  )
}

function NetworkEdges({ edges, names, points, truthVisible }: { edges: ConnectivityEdge[]; names: string[]; points: Point[]; truthVisible: boolean }) {
  const id = useId().replace(/:/g, '')
  return (
    <g>
      {edges.map((edge) => {
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
            strokeWidth={1.5 + edge.weight * 7}
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
    <div className="surrogate-chart" role="img" aria-label={`Null surrogate distribution with 95th percentile ${threshold.toFixed(3)} and planted edge estimate ${estimate.toFixed(3)}`}>
      <div className="surrogate-bars">
        {counts.map((count, index) => <i key={index} style={{ height: `${(count / peak) * 100}%` }} />)}
        <span className="surrogate-threshold" style={{ left: `${(threshold / maximum) * 100}%` }}><b>95%</b></span>
        <span className="surrogate-estimate" style={{ left: `${(estimate / maximum) * 100}%` }}><b>edge</b></span>
      </div>
      <div className="surrogate-axis"><span>0</span><span>{maximum.toFixed(2)}</span></div>
    </div>
  )
}
