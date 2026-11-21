// Lab 07 scoreboard. Metrics have different units (wSMI values are ~100× smaller than PLV), so
// every column is a ratio within one metric: never a raw value compared across metrics.
import { clamp01, type ScoreCriterion, type ScoreRow, type WeightPreset } from '../../lessons/scoreboard'
import { splitFeature, featureLabel } from './model'
import type { BenchmarkCapabilities, ComparisonEntry, ExperimentResults, PairedEffect } from './types'

interface EvaluationFeature { feature: string; n_seeds: number; mean_difference: number | null; mean_auc: number | null }
interface EvaluationEntry {
  metric_id: string
  analysis_space: string
  conditions: { condition: string; coupling_active: boolean; by_feature: EvaluationFeature[] }[]
}

export const BENCH_CRITERIA: ScoreCriterion[] = [
  { id: 'edges', label: '간선 찾기(소스 AUC)', hint: '결합을 켠 원신호에서 심어 둔 간선이 간선 아닌 쌍보다 큰 값을 받는 정도입니다. 0.5는 동전 던지기입니다.' },
  { id: 'quiet', label: '결합 없을 때 조용함', hint: '결합을 끈(G=0) 원신호에서 간선과 비간선을 구별하지 않아야 합니다. AUC가 0.5에서 멀수록 우연한 구조에 반응한 것입니다.' },
  { id: 'survives', label: 'EEG에서 남는 효과', hint: '원신호의 결합 효과(켬 − 끔) 가운데 EEG 관측(D − C)에서 같은 방향으로 남은 비율입니다. 부호가 뒤집히면 0입니다.' },
  { id: 'volume', label: '볼륨 전도 민감도', hint: '결합이 없을 때 관측 방식만 바꿔(A → C, 센서 혼합 추가) 지표 값이 몇 % 바뀌었는지입니다. 0%에 가까울수록 혼합에 덜 흔들립니다.' },
]

export const BENCH_PRESETS: WeightPreset[] = [
  { id: 'balanced', label: '균형', weights: { edges: 1, quiet: 1, survives: 1, volume: 1 } },
  { id: 'no-miss', label: '결합을 놓치기 싫다', weights: { edges: 3, quiet: 0, survives: 1, volume: 0 } },
  { id: 'no-fake', label: '가짜 연결이 가장 싫다', weights: { edges: 0, quiet: 3, survives: 0, volume: 3 } },
  { id: 'sensor', label: '센서 EEG에 쓸 것이다', weights: { edges: 1, quiet: 0, survives: 3, volume: 2 } },
]

function evaluationFor(results: ExperimentResults, metricId: string): EvaluationEntry | undefined {
  return (results.evaluation as EvaluationEntry[] | undefined)?.find((item) => item?.metric_id === metricId && item.analysis_space === 'source')
}

function effect(comparison: ComparisonEntry | undefined, a: string, b: string, feature: string): PairedEffect | undefined {
  return comparison?.summary?.find((row) => row.contrast.condition_a === a && row.contrast.condition_b === b && splitFeature(row.contrast.feature).feature === feature)
}

/** The feature (band or tau) where the metric separates planted edges best: its best showing. */
function bestFeature(entry: EvaluationEntry | undefined): EvaluationFeature | undefined {
  const on = entry?.conditions.find((item) => item.coupling_active)
  return [...(on?.by_feature ?? [])].filter((item) => item.mean_auc !== null).sort((a, b) => (b.mean_auc ?? 0) - (a.mean_auc ?? 0))[0]
}

export function benchmarkScoreRows(results: ExperimentResults, capabilities: BenchmarkCapabilities | null): ScoreRow[] {
  const metricIds = [...new Set(results.comparisons.map((item) => item.metric_id))]
  return metricIds.map((metricId) => {
    const entry = evaluationFor(results, metricId)
    const best = bestFeature(entry)
    const feature = best?.feature ?? ''
    const off = entry?.conditions.find((item) => !item.coupling_active)?.by_feature.find((item) => item.feature === feature)
    const sensor = results.comparisons.find((item) => item.metric_id === metricId && item.analysis_space === 'sensor')
    const source = results.comparisons.find((item) => item.metric_id === metricId && item.analysis_space === 'source')
    const sourceEffect = effect(source, 'source_off', 'source_on', feature)?.estimate ?? null
    const eegEffect = effect(sensor, 'C', 'D', feature)?.estimate ?? null
    const mixing = effect(sensor, 'A', 'C', feature)
    const baselineValues = (mixing?.per_seed_values ?? []).map((item) => item.value_a).filter((value): value is number => typeof value === 'number')
    const baseline = baselineValues.length ? baselineValues.reduce((sum, value) => sum + value, 0) / baselineValues.length : null

    const auc = best?.mean_auc ?? null
    const offAuc = off?.mean_auc ?? null
    const survives = sourceEffect !== null && eegEffect !== null && Math.abs(sourceEffect) > 1e-12 ? eegEffect / sourceEffect : null
    // Relative change from mixing alone, against the metric's own value without mixing (A).
    const volume = mixing?.estimate != null && baseline !== null && Math.abs(baseline) > 1e-12 ? mixing.estimate / Math.abs(baseline) : null
    const name = capabilities?.metrics[metricId]?.name ?? metricId

    return {
      id: metricId,
      label: `${name}${feature ? ` · ${featureLabel(feature)}` : ''}`,
      cells: {
        edges: { display: auc === null ? '—' : auc.toFixed(2), goodness: auc === null ? null : clamp01((auc - 0.5) / 0.5), raw: auc },
        quiet: { display: offAuc === null ? '—' : offAuc.toFixed(2), goodness: offAuc === null ? null : 1 - clamp01(Math.abs(offAuc - 0.5) / 0.5), raw: offAuc },
        survives: {
          display: survives === null ? '—' : survives < 0 ? '부호 뒤집힘' : `${Math.round(survives * 100)}%`,
          goodness: survives === null ? null : clamp01(survives),
          raw: survives,
        },
        volume: {
          display: volume === null ? '—' : `${volume >= 0 ? '+' : '−'}${Math.round(Math.abs(volume) * 100)}%`,
          goodness: volume === null ? null : 1 - clamp01(Math.abs(volume)),
          raw: volume === null ? null : Math.abs(volume),
        },
      },
    }
  })
}
