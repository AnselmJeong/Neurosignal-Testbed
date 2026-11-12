import { useMemo, useState } from 'react'

import { ColorLegend, ConditionGrid, MatrixHeatmap, type CellStatus } from './ConditionGrid'
import {
  conditionFeatureValues,
  differenceRange,
  featureLabel,
  formatSigned,
  formatValue,
  metricRange,
  sourceMatrices,
  splitFeature,
} from './model'
import type { BenchmarkCapabilities, ComparisonEntry, ExperimentResults, PairedEffect } from './types'

interface ContrastSpec {
  key: string
  a: string
  b: string
  title: string
  meaning: string
}

const SENSOR_CONTRASTS: ContrastSpec[] = [
  { key: 'B-A', a: 'A', b: 'B', title: 'B − A', meaning: 'identity probe에서 결합을 켠 효과' },
  { key: 'D-C', a: 'C', b: 'D', title: 'D − C', meaning: 'EEG forward에서 결합을 켠 효과' },
  { key: '(D-C)-(B-A)', a: 'B-A', b: 'D-C', title: '(D − C) − (B − A)', meaning: '관측 혼합이 결합 효과를 바꾼 정도 (상호작용)' },
]
const SOURCE_CONTRAST: ContrastSpec = { key: 'source_on-source_off', a: 'source_off', b: 'source_on', title: 'source on − off', meaning: '원신호(혼합 전)에서 결합을 켠 효과' }

const COMPANION_LABELS: Record<string, string> = {
  welch_peak_hz: 'Welch peak 주파수 (Hz)',
  welch_log10_power_1_45Hz: 'log10 power 1–45 Hz',
}

function findEffect(rows: PairedEffect[] | undefined, spec: ContrastSpec, feature: string | null): PairedEffect | undefined {
  return rows?.find((row) => row.contrast.condition_a === spec.a && row.contrast.condition_b === spec.b
    && (feature === null || splitFeature(row.contrast.feature).feature === feature))
}

function comparisonFor(results: ExperimentResults, metricId: string, space: 'sensor' | 'source'): ComparisonEntry | undefined {
  return results.comparisons.find((c) => c.metric_id === metricId && c.analysis_space === space)
}

export function ResultsExplorer({ results, capabilities }: { results: ExperimentResults; capabilities: BenchmarkCapabilities | null }) {
  const metricIds = useMemo(() => {
    const fromRecipe = results.recipe?.benchmark?.metrics?.map((metric) => metric.id) ?? []
    const fromComparisons = results.comparisons.map((comparison) => comparison.metric_id)
    return [...new Set([...fromRecipe, ...fromComparisons])]
  }, [results])
  const [metricChoice, setMetricChoice] = useState<string | null>(null)
  const metricId = metricChoice && metricIds.includes(metricChoice) ? metricChoice : metricIds[0] ?? ''
  const capability = capabilities?.metrics[metricId]
  const sensor = comparisonFor(results, metricId, 'sensor')
  const source = comparisonFor(results, metricId, 'source')
  const features = useMemo(() => {
    const labels = [...(sensor?.feature_labels ?? []), ...(source?.feature_labels ?? [])]
    return [...new Set(labels)]
  }, [sensor, source])
  const [featureChoice, setFeatureChoice] = useState<string | null>(null)
  const feature = featureChoice && features.includes(featureChoice) ? featureChoice : features[0] ?? 'all'

  const conditionValues = useMemo(() => conditionFeatureValues(sensor), [sensor])
  const sourceByFeature = useMemo(() => sourceMatrices(source), [source])
  const range = useMemo(() => {
    const values: (number | null)[] = []
    for (const byFeature of conditionValues.values()) for (const v of byFeature.values()) values.push(v.mean, ...v.perSeed.map((s) => s.value))
    for (const m of sourceByFeature.values()) values.push(...m.off.values.flat(), ...m.on.values.flat())
    return metricRange(values, capability)
  }, [conditionValues, sourceByFeature, capability])
  const diffRange = useMemo(() => differenceRange([...sourceByFeature.values()].flatMap((m) => m.difference.values.flat())), [sourceByFeature])

  const statuses = useMemo(() => {
    const map = new Map<string, CellStatus>()
    for (const row of results.metric_results) {
      if (row.metric_id !== metricId) continue
      const current = map.get(row.condition) ?? { ok: 0, total: 0, reasons: [] }
      current.total += 1
      if (row.status === 'ok') current.ok += 1
      else if (row.reason_code && !current.reasons.includes(row.reason_code)) current.reasons.push(row.reason_code)
      map.set(row.condition, current)
    }
    return map
  }, [results.metric_results, metricId])

  const sensorCounts = Object.fromEntries(Object.entries(results.recipe?.observations ?? {}).map(([name, obs]) => [name, obs.n_sensors]))
  const sourceMatrix = sourceByFeature.get(feature)
  const metricName = capability ? `${metricId} · ${capability.name}` : metricId
  const notComputed = results.comparisons.filter((c) => c.metric_id === metricId && !c.summary)

  return (
    <div className="jrb-results">
      <div className="jrb-metric-tabs" role="tablist" aria-label="결과 지표">
        {metricIds.map((id) => (
          <button type="button" role="tab" key={id} aria-selected={id === metricId} className={id === metricId ? 'active' : ''} onClick={() => setMetricChoice(id)}>
            {id} · {capabilities?.metrics[id]?.name ?? id}
          </button>
        ))}
      </div>
      {capability && <p className="jrb-muted">값의 범위 {capability.value_domain}{capability.signed ? ' · 부호 있는 지표(발산형 색)' : ''} · 단위 {results.metric_results.find((r) => r.metric_id === metricId)?.units ?? '—'}</p>}
      {features.length > 1 && (
        <div className="jrb-feature-tabs" role="group" aria-label="대역 또는 tau">
          {features.map((item) => (
            <button type="button" key={item} aria-pressed={item === feature} className={item === feature ? 'active' : ''} onClick={() => setFeatureChoice(item)}>{featureLabel(item)}</button>
          ))}
        </div>
      )}

      {notComputed.map((c) => (
        <p className="jrb-error" key={c.artifact_id} role="status">
          {c.analysis_space === 'source' ? '원신호' : '센서'} 비교 계산 안 됨 · {c.reason_code ?? c.status ?? '이유 없음'}
          {c.metric_cell_statuses && ` (${Object.entries(c.metric_cell_statuses).map(([k, v]) => `${k} ${v}`).join(', ')})`}
        </p>
      ))}

      <section className="jrb-block" aria-labelledby="jrb-sensor-title">
        <header className="jrb-section-head">
          <div><span className="eyebrow">센서 공간 · 4조건</span><h3 id="jrb-sensor-title">조건별 {metricName}</h3></div>
        </header>
        {sensor?.summary
          ? <ConditionGrid metricId={metricId} metric={capability} conditions={results.conditions} values={conditionValues} features={features.length ? features : ['all']}
              selectedFeature={feature} onSelectFeature={setFeatureChoice} range={range} statuses={statuses} sensorCounts={sensorCounts} />
          : <p className="jrb-note">이 지표의 센서 비교 결과가 없습니다.</p>}
      </section>

      <section className="jrb-block" aria-labelledby="jrb-source-title">
        <header className="jrb-section-head">
          <div><span className="eyebrow">원신호 공간 · JR 노드</span><h3 id="jrb-source-title">원천 노드 행렬 · {featureLabel(feature)}</h3></div>
        </header>
        {sourceMatrix ? (
          <>
            <div className="jrb-matrix-row">
              <MatrixHeatmap title="source off (G = 0)" nodeKind="원천 노드" matrix={sourceMatrix.off} range={range} caption="seed 평균" />
              <MatrixHeatmap title="source on" nodeKind="원천 노드" matrix={sourceMatrix.on} range={range} caption="seed 평균" />
              <MatrixHeatmap title="on − off" nodeKind="원천 노드" matrix={sourceMatrix.difference} range={diffRange} caption="seed paired 차이" />
            </div>
            <div className="jrb-legend-row">
              <ColorLegend range={range} label={`${metricName} 원값 · 센서 조건과 같은 범위`} />
              <ColorLegend range={diffRange} label="on − off 차이" />
            </div>
            <p className="jrb-note">원천 노드(n00…)는 JR 모형의 신경 집단이고, 위 센서 조건의 probe·전극과 같은 노드 집합이 아닙니다.</p>
          </>
        ) : <p className="jrb-note">이 지표·대역의 원천 노드별 값이 없습니다.</p>}
      </section>

      <section className="jrb-block" aria-labelledby="jrb-effect-title">
        <header className="jrb-section-head">
          <div><span className="eyebrow">seed paired 효과 · {featureLabel(feature)}</span><h3 id="jrb-effect-title">결합·관측 효과와 신뢰구간</h3></div>
        </header>
        <div className="jrb-effects">
          {SENSOR_CONTRASTS.map((spec) => <EffectPlot key={spec.key} spec={spec} effect={findEffect(sensor?.summary, spec, feature)} />)}
          <EffectPlot spec={SOURCE_CONTRAST} effect={findEffect(source?.summary, SOURCE_CONTRAST, feature)} />
        </div>
        {typeof sensor?.statistics?.ci === 'string' && <p className="jrb-muted">CI: {sensor.statistics.ci} · p-value: {String(sensor.statistics.p_value ?? '')} · 반복 단위: {String(sensor.statistics.unit ?? 'seed')}</p>}
      </section>

      <Companions sensor={sensor} />
    </div>
  )
}

function EffectPlot({ spec, effect }: { spec: ContrastSpec; effect: PairedEffect | undefined }) {
  if (!effect) {
    return <article className="jrb-effect missing" aria-label={`${spec.title} 효과`}><h4>{spec.title}</h4><p>{spec.meaning}</p><p className="jrb-muted">이 대역의 비교 결과가 없습니다.</p></article>
  }
  const diffs = effect.per_seed_values.map((row) => row.difference).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const extent = [0, ...diffs, effect.ci_low, effect.ci_high, effect.estimate].filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  let lo = Math.min(...extent)
  let hi = Math.max(...extent)
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.12
  lo -= pad
  hi += pad
  const width = 300
  const x = (value: number) => 12 + ((value - lo) / (hi - lo)) * (width - 24)
  const ok = effect.status === 'ok'
  return (
    <article className={`jrb-effect ${ok ? '' : 'missing'}`} aria-label={`${spec.title} 효과`}>
      <h4>{spec.title}</h4>
      <p>{spec.meaning}</p>
      <svg viewBox={`0 0 ${width} 64`} role="img" aria-label={`${spec.title}: seed ${diffs.length}개의 차이와 ${Math.round(effect.ci_level * 100)}% CI`}>
        <line x1={x(0)} x2={x(0)} y1={4} y2={52} className="jrb-zero" />
        {ok && typeof effect.ci_low === 'number' && typeof effect.ci_high === 'number' && (
          <line x1={x(effect.ci_low)} x2={x(effect.ci_high)} y1={44} y2={44} className="jrb-ci" />
        )}
        {ok && typeof effect.estimate === 'number' && <rect x={x(effect.estimate) - 4} y={40} width={8} height={8} transform={`rotate(45 ${x(effect.estimate)} 44)`} className="jrb-estimate" />}
        {effect.per_seed_values.map((row, index) => typeof row.difference === 'number' && Number.isFinite(row.difference) && (
          <circle key={row.seed} cx={x(row.difference)} cy={12 + ((index * 7) % 22)} r={3.2} className="jrb-seed-point"><title>seed {row.seed}: {formatSigned(row.difference)}</title></circle>
        ))}
        <text x={12} y={62}>{formatValue(lo)}</text>
        <text x={width - 12} y={62} textAnchor="end">{formatValue(hi)}</text>
      </svg>
      {ok ? (
        <p className="jrb-effect-text" data-testid={`effect-${spec.key}`}>
          추정 <b>{formatSigned(effect.estimate)}</b> [{formatSigned(effect.ci_low)}, {formatSigned(effect.ci_high)}] · 독립 seed n = {effect.independent_n}
          <small> · p = {formatValue(effect.p_value, 3)} ({effect.null_family}, 보조 지표)</small>
        </p>
      ) : <p className="jrb-error">계산 안 됨 · {effect.reason_code ?? effect.status}</p>}
      <details className="jrb-seed-table">
        <summary>seed별 값</summary>
        <table>
          <thead><tr><th>seed</th><th>{spec.a}</th><th>{spec.b}</th><th>차이</th></tr></thead>
          <tbody>{effect.per_seed_values.map((row) => <tr key={row.seed}><td>{row.seed}</td><td>{formatValue(row.value_a)}</td><td>{formatValue(row.value_b)}</td><td>{formatSigned(row.difference)}</td></tr>)}</tbody>
        </table>
      </details>
    </article>
  )
}

function Companions({ sensor }: { sensor: ComparisonEntry | undefined }) {
  const rows = (sensor?.companions ?? []).filter((row) => ['B-A', 'D-C'].some((key) => {
    const spec = SENSOR_CONTRASTS.find((item) => item.key === key)!
    return row.contrast.condition_a === spec.a && row.contrast.condition_b === spec.b
  }))
  if (!rows.length) return null
  return (
    <section className="jrb-block" aria-labelledby="jrb-companion-title">
      <header className="jrb-section-head"><div><span className="eyebrow">결합과 무관할 수 있는 변화</span><h3 id="jrb-companion-title">스펙트럼 동반 변화</h3></div></header>
      <p className="jrb-note">결합을 켜면 JR peak 주파수와 파워도 바뀝니다. 연결성 효과는 아래 스펙트럼 변화와 함께 읽어야 합니다.</p>
      <table className="jrb-companion-table">
        <thead><tr><th>지표</th><th>대비</th><th>추정 [95% CI]</th><th>n</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.contrast.metric_id}-${row.contrast.condition_a}-${row.contrast.condition_b}`}>
              <td>{COMPANION_LABELS[row.contrast.metric_id] ?? row.contrast.metric_id}</td>
              <td>{row.contrast.condition_b} − {row.contrast.condition_a}</td>
              <td>{row.status === 'ok' ? `${formatSigned(row.estimate)} [${formatSigned(row.ci_low)}, ${formatSigned(row.ci_high)}]` : `계산 안 됨 · ${row.reason_code ?? row.status}`}</td>
              <td>{row.independent_n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
