import { Fragment } from 'react'

import { colorFor, formatValue, formulaParts, graphLayout, type ColorRange, type NetFlow } from './model'
import type { Matrix } from './types'

// ------------------------------------------------------------------ formula

/** Catalog LaTeX shown as styled text with real sub/superscripts; the raw LaTeX stays available. */
export function Formula({ latex, label }: { latex: string | null | undefined; label?: string }) {
  if (!latex) return null
  return (
    <figure className="flw-formula" aria-label={label ?? '수식'}>
      <code>
        {formulaParts(latex).map((part, index) => part.kind === 'sub'
          ? <sub key={index}>{part.text}</sub>
          : part.kind === 'sup' ? <sup key={index}>{part.text}</sup> : <Fragment key={index}>{part.text}</Fragment>)}
      </code>
      <details><summary>LaTeX 원문</summary><pre>{latex}</pre></details>
    </figure>
  )
}

// ------------------------------------------------------------------ status

export const STATUS_LABELS: Record<string, string> = {
  ok: '계산됨',
  not_applicable: '해당 없음',
  invalid_input: '입력 부적합',
  ineligible: '적용 불가',
  failed: '실패',
  skipped: '건너뜀',
  planned: '계획됨',
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`flw-status ${status}`}>{STATUS_LABELS[status] ?? status}</span>
}

/** A method that did not produce values: show status, reason and message — never a number. */
export function StatusNote({ status, reasonCode, message }: { status: string; reasonCode: string | null | undefined; message: string | null | undefined }) {
  return (
    <div className={`flw-status-note ${status}`} role="note">
      <StatusBadge status={status} />
      {reasonCode && <code>{reasonCode}</code>}
      <p>{message ?? '이 방법은 이 데이터에서 값을 내지 않았습니다. 0으로 대체하지 않습니다.'}</p>
    </div>
  )
}

// ------------------------------------------------------------------ directed matrix

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function ColorLegend({ range, units }: { range: ColorRange; units?: string | undefined }) {
  const stops = Array.from({ length: 9 }, (_, i) => range.lo + ((range.hi - range.lo) * i) / 8)
  return (
    <div className="flw-legend" aria-label="색 척도">
      <span>{formatValue(range.lo)}</span>
      <i style={{ background: `linear-gradient(90deg, ${stops.map((value) => colorFor(value, range)).join(', ')})` }} />
      <span>{formatValue(range.hi)}</span>
      {units && <small>{units}</small>}
      <small>{range.diverging ? '발산형 척도 (0 = 흰색)' : '순차형 척도'}</small>
    </div>
  )
}

/** Heatmap of a [target][source] matrix. Truth cells (source space only) are outlined. */
export function DirectedMatrix({ values, labels, range, pValues, threshold, truth, ariaLabel, units }: {
  values: Matrix
  labels: string[]
  range: ColorRange
  pValues?: Matrix | undefined
  threshold?: number | null | undefined
  truth: Set<string>
  ariaLabel: string
  units?: string | undefined
}) {
  const n = values.length
  const cell = n <= 10 ? 28 : n <= 16 ? 18 : 12
  const left = 46
  const top = 46
  const size = cell * n
  const fontSize = n <= 10 ? 10 : n <= 16 ? 8 : 6.5
  return (
    <div className="flw-matrix">
      <svg viewBox={`0 0 ${left + size + 6} ${top + size + 6}`} role="img" aria-label={ariaLabel} style={{ maxWidth: left + size + 6 }}>
        <text x={left + size / 2} y={10} textAnchor="middle" className="flw-axis-title">source (보내는 쪽) →</text>
        <text x={10} y={top + size / 2} textAnchor="middle" className="flw-axis-title" transform={`rotate(-90 10 ${top + size / 2})`}>← target (받는 쪽)</text>
        {labels.map((label, i) => (
          <Fragment key={`label-${i}`}>
            <text x={left + i * cell + cell / 2} y={top - 4} fontSize={fontSize} textAnchor="start" transform={`rotate(-55 ${left + i * cell + cell / 2} ${top - 4})`}>{label}</text>
            <text x={left - 4} y={top + i * cell + cell / 2 + fontSize / 3} fontSize={fontSize} textAnchor="end">{label}</text>
          </Fragment>
        ))}
        {values.map((row, t) => row.map((value, s) => {
          const p = pValues?.[t]?.[s]
          const significant = finite(p) && finite(threshold) && p <= threshold
          const isTruth = truth.has(`${t}:${s}`)
          const x = left + s * cell
          const y = top + t * cell
          return (
            <g key={`${t}-${s}`}>
              <rect x={x} y={y} width={cell} height={cell} fill={t === s ? '#e4e5df' : finite(value) ? colorFor(value, range) : 'url(#flw-null)'} stroke="#fff" strokeWidth={0.6}>
                <title>{`${labels[s]} → ${labels[t]}: ${t === s ? '대각선 (자기 자신)' : finite(value) ? formatValue(value, 4) : '계산 안 됨 (null)'}${finite(p) ? ` · p=${p.toExponential(1)}` : ''}${isTruth ? ' · 정답 간선' : ''}`}</title>
              </rect>
              {significant && <circle cx={x + cell / 2} cy={y + cell / 2} r={Math.max(1.6, cell / 9)} fill="#11202c" data-significant="true" />}
              {isTruth && <rect x={x + 1} y={y + 1} width={cell - 2} height={cell - 2} fill="none" stroke="#c7653c" strokeWidth={2} data-truth="true" />}
            </g>
          )
        }))}
        <defs>
          <pattern id="flw-null" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" fill="#f1f1ec" /><line x1="0" y1="0" x2="0" y2="4" stroke="#cfd0c9" strokeWidth="1.2" />
          </pattern>
        </defs>
      </svg>
      <ColorLegend range={range} units={units} />
      <p className="flw-matrix-key">
        {pValues && finite(threshold) && <span><i className="dot" /> Bonferroni 유의</span>}
        {truth.size > 0 && <span><i className="outline" /> 정답 간선 (소스 공간, G&gt;0)</span>}
        <span><i className="hatch" /> 계산 안 됨</span>
      </p>
    </div>
  )
}

// ------------------------------------------------------------------ source graph

const NODE_R = 15

function shorten(from: [number, number], to: [number, number], offset: number): [number, number, number, number] {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const ox = -uy * offset
  const oy = ux * offset
  return [from[0] + ux * NODE_R + ox, from[1] + uy * NODE_R + oy, to[0] - ux * (NODE_R + 4) + ox, to[1] - uy * (NODE_R + 4) + oy]
}

/**
 * Node-link diagram of the known source graph. `truthStyle="solid"` shows the generation graph;
 * with `flows`, the truth is drawn dashed and estimated net flows are overlaid as teal arrows.
 */
export function SourceGraph({ nodes, edges, flows, truthStyle = 'solid', highlight = [], ariaLabel, caption }: {
  nodes: string[]
  edges: [string, string][]
  flows?: NetFlow[] | undefined
  truthStyle?: 'solid' | 'dashed'
  highlight?: string[]
  ariaLabel: string
  caption?: string | undefined
}) {
  const layout = graphLayout(nodes)
  const maxNet = Math.max(1e-12, ...(flows ?? []).map((flow) => flow.net))
  const shown = (flows ?? []).filter((flow) => flow.significant)
  return (
    <figure className="flw-graph">
      <svg viewBox="0 0 360 210" role="img" aria-label={ariaLabel}>
        <defs>
          <marker id="flw-arrow-truth" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={truthStyle === 'solid' ? '#1b344a' : '#9a9d97'} /></marker>
          <marker id="flw-arrow-flow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#087f83" /></marker>
        </defs>
        {edges.map(([source, target]) => {
          const a = layout[source]
          const b = layout[target]
          if (!a || !b) return null
          const [x1, y1, x2, y2] = shorten(a, b, flows ? -4 : 0)
          return <line key={`truth-${source}-${target}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={truthStyle === 'solid' ? '#1b344a' : '#9a9d97'} strokeWidth={truthStyle === 'solid' ? 2 : 1.4} strokeDasharray={truthStyle === 'dashed' ? '4 3' : undefined} markerEnd="url(#flw-arrow-truth)" data-edge={`${source}->${target}`} />
        })}
        {shown.map((flow) => {
          const a = layout[flow.from]
          const b = layout[flow.to]
          if (!a || !b) return null
          const [x1, y1, x2, y2] = shorten(a, b, 4)
          return (
            <line key={`flow-${flow.from}-${flow.to}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#087f83" strokeOpacity={0.85} strokeWidth={1.2 + 4 * (flow.net / maxNet)} markerEnd="url(#flw-arrow-flow)" data-flow={`${flow.from}->${flow.to}`}>
              <title>{`${flow.from} → ${flow.to}: 순 흐름 ${formatValue(flow.net, 4)} (정방향 ${formatValue(flow.forward, 4)}, 역방향 ${formatValue(flow.backward, 4)})`}</title>
            </line>
          )
        })}
        {nodes.map((node) => {
          const point = layout[node]
          if (!point) return null
          return (
            <g key={node} className={highlight.includes(node) ? 'flw-node highlight' : 'flw-node'}>
              <circle cx={point[0]} cy={point[1]} r={NODE_R} />
              <text x={point[0]} y={point[1] + 4} textAnchor="middle">{node}</text>
            </g>
          )
        })}
      </svg>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  )
}

// ------------------------------------------------------------------ bars

/** Horizontal signed bars (e.g. per-channel r). Negative values extend left of zero; nothing is clipped. */
export function SignedBars({ items, ariaLabel, digits = 2 }: { items: { label: string; value: number | null; note?: string }[]; ariaLabel: string; digits?: number }) {
  const extent = Math.max(1e-12, ...items.map((item) => (finite(item.value) ? Math.abs(item.value) : 0)))
  return (
    <ul className="flw-bars" aria-label={ariaLabel}>
      {items.map((item) => (
        <li key={item.label}>
          <span className="flw-bar-label">{item.label}</span>
          <span className="flw-bar-track">
            {finite(item.value)
              ? <i className={item.value < 0 ? 'neg' : 'pos'} style={item.value < 0
                ? { right: '50%', width: `${(Math.abs(item.value) / extent) * 50}%` }
                : { left: '50%', width: `${(item.value / extent) * 50}%` }} />
              : <em>{item.note ?? '계산 안 됨'}</em>}
          </span>
          <span className="flw-bar-value">{finite(item.value) ? item.value.toFixed(digits) : '—'}</span>
        </li>
      ))}
    </ul>
  )
}

export interface PidParts { redundancy: number | null; unique1: number | null; unique2: number | null; synergy: number | null }

const PID_SEGMENTS: { key: keyof PidParts; label: string; className: string }[] = [
  { key: 'redundancy', label: 'R 중복', className: 'r' },
  { key: 'unique1', label: 'U1 고유', className: 'u1' },
  { key: 'unique2', label: 'U2 고유', className: 'u2' },
  { key: 'synergy', label: 'S 시너지', className: 's' },
]

/** Stacked R/U1/U2/S bar on a shared scale. Negative or missing parts are listed, not drawn. */
export function PidStackedBar({ label, parts, scale, units, sourceLabels, note }: {
  label: string
  parts: PidParts
  scale: number
  units: string
  sourceLabels?: [string, string]
  note?: string
}) {
  const drawable = PID_SEGMENTS.filter(({ key }) => finite(parts[key]) && (parts[key] as number) >= 0)
  const problems = PID_SEGMENTS.filter(({ key }) => !finite(parts[key]) || (parts[key] as number) < 0)
  return (
    <div className="flw-pid-row" aria-label={`${label} PID`}>
      <div className="flw-pid-head"><strong>{label}</strong>{note && <small>{note}</small>}</div>
      <div className="flw-pid-track">
        {drawable.map(({ key, className, label: segmentLabel }) => (
          <i key={key} className={className} style={{ width: `${((parts[key] as number) / Math.max(scale, 1e-12)) * 100}%` }} title={`${segmentLabel}: ${formatValue(parts[key], 4)} ${units}`} />
        ))}
      </div>
      <dl className="flw-pid-values">
        {PID_SEGMENTS.map(({ key, label: segmentLabel }) => (
          <div key={key}>
            <dt>{segmentLabel}{sourceLabels && key === 'unique1' ? ` (${sourceLabels[0]})` : sourceLabels && key === 'unique2' ? ` (${sourceLabels[1]})` : ''}</dt>
            <dd data-testid={`pid-${label}-${key}`}>{formatValue(parts[key], 3)}</dd>
          </div>
        ))}
      </dl>
      {problems.length > 0 && <p className="flw-warn">{problems.map((item) => item.label).join(', ')}: 음수이거나 계산되지 않아 막대에서 뺐습니다. 값은 위 표를 보세요.</p>}
    </div>
  )
}

export function PidLegend() {
  return (
    <p className="flw-pid-legend">
      {PID_SEGMENTS.map(({ key, label, className }) => <span key={key}><i className={className} />{label}</span>)}
    </p>
  )
}
