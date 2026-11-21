import { Scale } from 'lucide-react'
import { useMemo, useState } from 'react'

import { presetWinners, rankRows, type ScoreCriterion, type ScoreRow, type WeightPreset } from '../lessons/scoreboard'

export interface ScatterSpec {
  x: string
  y: string
  xLabel: string
  yLabel: string
  /** Where the good corner is, in words: e.g. "왼쪽 위가 좋음". */
  goodCorner: string
  /** Axis maxima; values are fractions unless given. */
  xMax?: number
  yMax?: number
}

/**
 * P1-5: one row per method, one column per concern, and weight sliders that re-rank the rows.
 * The point is that there is no best method, only a best method for what you care about.
 */
export function MethodScoreboard({ title, rows, criteria, presets, scatter, howScored, caption }: {
  title: string
  rows: ScoreRow[]
  criteria: ScoreCriterion[]
  presets: WeightPreset[]
  scatter?: ScatterSpec
  howScored: string[]
  caption?: string
}) {
  const [weights, setWeights] = useState<Record<string, number>>(() => ({ ...presets[0]!.weights }))
  const ranked = useMemo(() => rankRows(rows, weights), [rows, weights])
  const winners = useMemo(() => presetWinners(rows, presets), [rows, presets])
  const distinctWinners = new Set(Object.values(winners).filter(Boolean)).size
  const activePreset = presets.find((preset) => criteria.every((criterion) => (preset.weights[criterion.id] ?? 0) === (weights[criterion.id] ?? 0)))
  const labelOf = (id: string | null) => rows.find((row) => row.id === id)?.label ?? '—'

  return (
    <section className="scoreboard" aria-label={title}>
      <header className="scoreboard-head">
        <div><Scale size={16} /><h3>{title}</h3></div>
        {caption && <p>{caption}</p>}
      </header>

      <div className="scoreboard-weights" role="group" aria-label="무엇을 중시하는가">
        <div className="scoreboard-presets">
          {presets.map((preset) => (
            <button key={preset.id} type="button" aria-pressed={activePreset?.id === preset.id} className={activePreset?.id === preset.id ? 'active' : ''} onClick={() => setWeights({ ...preset.weights })}>
              {preset.label}<small>1위 {labelOf(winners[preset.id] ?? null)}</small>
            </button>
          ))}
        </div>
        <div className="scoreboard-sliders">
          {criteria.map((criterion) => (
            <label key={criterion.id}>
              <span>{criterion.label}</span>
              <input type="range" min={0} max={3} step={1} value={weights[criterion.id] ?? 0} aria-label={`${criterion.label} 중요도`} onChange={(event) => setWeights((current) => ({ ...current, [criterion.id]: Number(event.target.value) }))} />
              <output>{['무시', '조금', '중요', '가장 중요'][weights[criterion.id] ?? 0]}</output>
            </label>
          ))}
        </div>
      </div>

      <div className="scoreboard-table-wrap">
        <table className="scoreboard-table">
          <thead>
            <tr>
              <th scope="col">순위</th>
              <th scope="col">방법</th>
              {criteria.map((criterion) => <th scope="col" key={criterion.id} title={criterion.hint} className={(weights[criterion.id] ?? 0) === 0 ? 'ignored' : ''}>{criterion.label}</th>)}
              <th scope="col">가중 점수</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map(({ row, score, missing }, index) => (
              <tr key={row.id} className={`${index === 0 && !missing.length ? 'leader' : ''} ${missing.length ? 'incomplete' : ''}`}>
                <td>{missing.length ? '–' : index + 1}</td>
                <th scope="row">{row.label}</th>
                {criteria.map((criterion) => {
                  const cell = row.cells[criterion.id]
                  const goodness = cell?.goodness
                  return (
                    <td key={criterion.id} className={(weights[criterion.id] ?? 0) === 0 ? 'ignored' : ''}>
                      <span className="cell-value">{cell?.display ?? '—'}</span>
                      {goodness !== null && goodness !== undefined && <i className="cell-bar"><b style={{ width: `${Math.round(goodness * 100)}%` }} /></i>}
                    </td>
                  )
                })}
                <td className="total">{score === null ? '—' : score.toFixed(2)}{missing.length > 0 && <small>{missing.length}개 기준 미평가</small>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="scoreboard-verdict">
        {distinctWinners > 1
          ? `기준 묶음 ${presets.length}개 가운데 1위가 ${distinctWinners}번 바뀝니다. 가장 좋은 방법은 없고, 무엇을 중시하느냐에 따라 달라집니다.`
          : `이 결과에서는 어떤 기준 묶음에서도 ${labelOf(Object.values(winners)[0] ?? null)}가 1위입니다. 설정(결합 세기, 길이, 관측)을 바꾸면 달라지는지 확인하세요.`}
      </p>

      {scatter && <Scatter rows={rows} spec={scatter} />}

      <details className="scoreboard-how">
        <summary>점수 계산 방법(How scoring works)</summary>
        <ul>
          {howScored.map((line) => <li key={line}>{line}</li>)}
          <li>중요하다고 고른 기준 중 계산하지 못한 것(—)이 있는 방법은 점수를 보여 주되 순위에서는 뒤로 보냅니다. 재지 못한 것으로 이길 수는 없습니다.</li>
          {criteria.map((criterion) => <li key={criterion.id}><b>{criterion.label}</b> {criterion.hint}</li>)}
        </ul>
      </details>
    </section>
  )
}

function Scatter({ rows, spec }: { rows: ScoreRow[]; spec: ScatterSpec }) {
  const points = rows
    .map((row) => ({ row, x: row.cells[spec.x]?.raw, y: row.cells[spec.y]?.raw }))
    .filter((point): point is { row: ScoreRow; x: number; y: number } => typeof point.x === 'number' && typeof point.y === 'number')
  const xMax = spec.xMax ?? Math.max(1, ...points.map((point) => point.x))
  const yMax = spec.yMax ?? Math.max(1, ...points.map((point) => point.y))
  const left = 46
  const top = 14
  const width = 300
  const height = 170
  const px = (value: number) => left + (value / xMax) * width
  const py = (value: number) => top + height - (value / yMax) * height
  return (
    <figure className="scoreboard-scatter">
      <svg viewBox="0 0 380 230" role="img" aria-label={`${spec.yLabel} 대 ${spec.xLabel} 산점도`}>
        <rect x={left} y={top} width={width} height={height} fill="#fafaf7" stroke="#d4d6cf" />
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <text x={px(tick * xMax)} y={top + height + 14} textAnchor="middle" className="scatter-tick">{(tick * xMax).toFixed(xMax > 1 ? 0 : 1)}</text>
            <text x={left - 6} y={py(tick * yMax) + 3} textAnchor="end" className="scatter-tick">{(tick * yMax).toFixed(yMax > 1 ? 0 : 1)}</text>
          </g>
        ))}
        <text x={left + width / 2} y={top + height + 32} textAnchor="middle" className="scatter-axis">{spec.xLabel}</text>
        <text x={12} y={top + height / 2} textAnchor="middle" className="scatter-axis" transform={`rotate(-90 12 ${top + height / 2})`}>{spec.yLabel}</text>
        {points.map(({ row, x, y }) => (
          <g key={row.id}>
            <circle cx={px(x)} cy={py(y)} r={5} fill="#087f83" stroke="#fff" strokeWidth={1.5} />
            <text x={px(x) + 8} y={py(y) - 6} className="scatter-label">{row.label}</text>
          </g>
        ))}
      </svg>
      <figcaption>{spec.goodCorner}. 한 축만 좋은 방법은 다른 축을 대가로 치릅니다.</figcaption>
    </figure>
  )
}
