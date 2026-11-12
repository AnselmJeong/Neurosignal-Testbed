import { colorFor, featureLabel, formatValue, type ColorRange, type ConditionFeatureValue, type NodeMatrix } from './model'
import type { MetricCapability, PlannedCondition } from './types'

export interface CellStatus {
  ok: number
  total: number
  reasons: string[]
}

export function ColorLegend({ range, label }: { range: ColorRange; label: string }) {
  const stops = Array.from({ length: 9 }, (_, i) => range.lo + ((range.hi - range.lo) * i) / 8)
  return (
    <div className="jrb-legend" aria-label={`${label} 색 범위 ${formatValue(range.lo)} ~ ${formatValue(range.hi)}`}>
      <span className="jrb-legend-bar" style={{ background: `linear-gradient(90deg, ${stops.map((v) => colorFor(v, range)).join(', ')})` }} />
      <small><span>{formatValue(range.lo)}</span>{range.diverging && <span>0</span>}<span>{formatValue(range.hi)}</span></small>
      <em>{range.diverging ? '발산형 · 0 중심' : '순차형'} · {label}</em>
    </div>
  )
}

/** A/B/C/D at a glance: rows = observation operator, columns = coupling level (plan §2.3). */
export function ConditionGrid({ metricId, metric, conditions, values, features, selectedFeature, onSelectFeature, range, statuses, sensorCounts }: {
  metricId: string
  metric: MetricCapability | undefined
  conditions: PlannedCondition[]
  values: Map<string, Map<string, ConditionFeatureValue>>
  features: string[]
  selectedFeature: string
  onSelectFeature: (feature: string) => void
  range: ColorRange
  statuses: Map<string, CellStatus>
  sensorCounts: Record<string, number | undefined>
}) {
  const byLabel = new Map(conditions.map((condition) => [condition.label, condition]))
  const levels = [...new Set(conditions.filter((c) => c.analysis_space === 'sensor').map((c) => c.G))].sort((a, b) => a - b)
  const rows: { observation: string; title: string; labels: string[] }[] = [
    { observation: 'identity_probe', title: 'identity probe', labels: ['A', 'B'] },
    { observation: 'eeg_forward', title: 'EEG forward', labels: ['C', 'D'] },
  ]
  const name = metric ? `${metricId} · ${metric.name}` : metricId

  return (
    <section className="jrb-condition-grid" aria-label={`${name} 조건 격자 A·B·C·D`}>
      <div className="jrb-grid-head">
        <span />
        {levels.map((g) => <strong key={g}>G = {g} <small>{g === 0 ? '결합 끔' : '결합 켬'}</small></strong>)}
      </div>
      {rows.map((row) => (
        <div className="jrb-grid-row" key={row.observation}>
          <div className="jrb-grid-rowhead">
            <strong>{row.title}</strong>
            <small>센서 {sensorCounts[row.observation] ?? '—'}개 · {row.observation === 'identity_probe' ? '노드별 probe, 혼합 없음' : 'sphere forward 혼합'}</small>
          </div>
          {row.labels.map((label) => {
            const condition = byLabel.get(label)
            const featureValues = values.get(label)
            const selected = featureValues?.get(selectedFeature)
            const status = statuses.get(label)
            return (
              <article className="jrb-cell" key={label} aria-label={`조건 ${label}`}>
                <header>
                  <b>{label}</b>
                  <span>G {condition?.G ?? '—'} · {condition?.observation ?? row.observation}</span>
                </header>
                <div className="jrb-cell-value">
                  <i style={{ background: colorFor(selected?.mean, range) }} />
                  <strong data-testid={`cell-${label}-value`}>{formatValue(selected?.mean)}</strong>
                  <small>{featureLabel(selectedFeature)} · seed 평균 off-diagonal</small>
                </div>
                <div className="jrb-band-strip" role="group" aria-label={`조건 ${label} 대역별 값`}>
                  {features.map((feature) => {
                    const value = featureValues?.get(feature)?.mean
                    return (
                      <button type="button" key={feature} aria-pressed={feature === selectedFeature} className={feature === selectedFeature ? 'selected' : ''}
                        style={{ background: colorFor(value, range) }} title={`${featureLabel(feature)}: ${formatValue(value)}`}
                        onClick={() => onSelectFeature(feature)}>
                        <span>{featureLabel(feature)}</span>
                      </button>
                    )
                  })}
                </div>
                <footer className={status && status.ok < status.total ? 'partial' : ''}>
                  {status ? `계산 성공 ${status.ok}/${status.total} seed` : '지표 결과 없음'}
                  {status && status.reasons.length > 0 && <span> · {status.reasons.join(', ')}</span>}
                </footer>
              </article>
            )
          })}
        </div>
      ))}
      <ColorLegend range={range} label={`${name} · 네 조건·모든 대역 공통`} />
      <p className="jrb-note">
        센서 행렬(채널 × 채널)은 현재 API가 값을 보내지 않습니다. 저장된 metric artifact는 대역 × 채널 × 채널 3차원이고 artifact window 경로는 2차원 시계열만 지원하므로,
        각 조건은 seed별 off-diagonal 평균으로 표시합니다. identity probe와 EEG forward는 서로 다른 센서 집합입니다.
      </p>
    </section>
  )
}

export function MatrixHeatmap({ title, nodeKind, matrix, range, caption }: {
  title: string
  nodeKind: string
  matrix: NodeMatrix
  range: ColorRange
  caption?: string
}) {
  const n = matrix.nodes.length
  return (
    <figure className="jrb-matrix" aria-label={`${title} · ${nodeKind} ${n}개`}>
      <figcaption><strong>{title}</strong><small>{nodeKind} {n}개{caption ? ` · ${caption}` : ''}</small></figcaption>
      <div className="jrb-matrix-grid" role="img" aria-label={`${title} 행렬, ${nodeKind} ${n} × ${n}`}
        style={{ gridTemplateColumns: `auto repeat(${n}, minmax(10px, 1fr))` }}>
        <span />
        {matrix.nodes.map((node) => <span className="jrb-matrix-head" key={`c-${node}`}>{n <= 12 ? node : ''}</span>)}
        {matrix.values.map((row, i) => [
          <span className="jrb-matrix-head row" key={`r-${matrix.nodes[i]}`}>{matrix.nodes[i]}</span>,
          ...row.map((value, j) => (
            <span key={`${i}-${j}`} className={`jrb-matrix-cell ${value === null ? 'empty' : ''}`}
              style={{ background: colorFor(value, range) }}
              title={`${matrix.nodes[i]}–${matrix.nodes[j]}: ${i === j ? '자기 연결 정의 안 됨' : formatValue(value)}`} />
          )),
        ])}
      </div>
    </figure>
  )
}
