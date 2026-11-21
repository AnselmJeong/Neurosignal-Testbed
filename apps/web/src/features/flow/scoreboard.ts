// Lab 08 scoreboard: the source-space truth scores and the sensor-space G=0 control,
// rearranged so that each method is one row and each concern is one column.
import { clamp01, speedGoodness, type ScoreCriterion, type ScoreRow, type WeightPreset } from '../../lessons/scoreboard'
import type { FlowResult } from './types'

export const FLOW_SCORE_METHODS: { id: string; label: string }[] = [
  { id: 'gc_pairwise', label: '쌍별 GC' },
  { id: 'gc_conditional', label: '조건부 GC' },
  { id: 'te_gaussian', label: 'Gaussian TE' },
  { id: 'te_ksg', label: 'KSG TE' },
  { id: 'effective_model', label: '선형 효과 모델' },
]

export const FLOW_CRITERIA: ScoreCriterion[] = [
  { id: 'auc', label: '간선 찾기(Edge AUC)', hint: '진짜 간선이 없는 쌍보다 큰 값을 받는 정도입니다. 0.5는 동전 던지기, 1은 완벽입니다.' },
  { id: 'direction', label: '방향 적중', hint: '진짜 간선에서 정방향 값이 역방향보다 큰 비율입니다.' },
  { id: 'missed', label: '놓친 간선', hint: '진짜 간선 가운데 Bonferroni 유의에 이르지 못한 비율입니다. 적을수록 좋습니다.' },
  { id: 'false_positive', label: '거짓 양성', hint: '직접 간선이 없는 쌍을 유의하다고 판정한 비율입니다. 사슬·갈래의 간접 경로가 여기서 걸립니다.' },
  { id: 'volume', label: '볼륨 전도 민감도', hint: '결합이 전혀 없는(G=0) 센서 자료에서 유의하다고 나온 쌍의 비율입니다. 볼륨 전도와 기준전극이 만든 가짜입니다.' },
  { id: 'speed', label: '계산 시간', hint: '소스 자료 하나를 분석한 시간입니다. 가장 빠른 방법과 비교한 상대 점수(로그 척도)입니다.' },
]

export const FLOW_PRESETS: WeightPreset[] = [
  { id: 'balanced', label: '균형', weights: { auc: 1, direction: 1, missed: 1, false_positive: 1, volume: 1, speed: 1 } },
  { id: 'no-false-positive', label: '거짓 양성이 가장 싫다', weights: { auc: 1, direction: 1, missed: 0, false_positive: 3, volume: 3, speed: 0 } },
  { id: 'no-miss', label: '놓치는 것이 가장 싫다', weights: { auc: 2, direction: 1, missed: 3, false_positive: 0, volume: 0, speed: 0 } },
  { id: 'sensor', label: '센서 자료에 쓸 것이다', weights: { auc: 1, direction: 1, missed: 0, false_positive: 0, volume: 3, speed: 0 } },
  { id: 'fast', label: '빨라야 한다', weights: { auc: 1, direction: 1, missed: 0, false_positive: 0, volume: 0, speed: 3 } },
]

const pct = (value: number) => `${Math.round(value * 100)}%`

export function flowScoreRows(result: FlowResult): ScoreRow[] {
  const evaluation = result.evaluation
  const coupled = evaluation?.source.find((item) => item.condition === 'coupled')
  const sensorControl = evaluation?.sensor.find((item) => item.condition === 'control')
  const sourceDataset = result.datasets.find((item) => item.space === 'source' && item.condition === 'coupled')
  const times = FLOW_SCORE_METHODS.map((method) => sourceDataset?.methods[method.id]?.wall_s ?? null)
  const speed = speedGoodness(times)

  return FLOW_SCORE_METHODS.filter((method) => coupled?.scores[method.id]).map((method) => {
    const score = coupled!.scores[method.id]!
    const auc = score.edge_auc?.status === 'ok' ? score.edge_auc.auc ?? null : null
    const direction = score.direction?.status === 'ok' ? score.direction.accuracy : null
    const significance = score.significance
    const missed = significance && significance.n_edges_tested ? 1 - significance.true_positives / significance.n_edges_tested : null
    const falsePositive = significance && significance.n_non_edges_tested ? significance.false_positives / significance.n_non_edges_tested : null
    const sensor = sensorControl?.[method.id as 'gc_pairwise' | 'gc_conditional' | 'te_gaussian']
    const volume = sensor?.status === 'ok' ? sensor.fraction_significant_bonferroni ?? null : null
    const position = FLOW_SCORE_METHODS.indexOf(method)
    const seconds = times[position] ?? null
    return {
      id: method.id,
      label: method.label,
      cells: {
        auc: { display: auc === null ? '—' : auc.toFixed(2), goodness: auc === null ? null : clamp01((auc - 0.5) / 0.5), raw: auc },
        direction: { display: direction === null ? '—' : pct(direction), goodness: direction, raw: direction },
        missed: {
          display: missed === null || !significance ? '—' : `${significance.n_edges_tested - significance.true_positives}/${significance.n_edges_tested}`,
          goodness: missed === null ? null : 1 - missed,
          raw: missed,
        },
        false_positive: {
          display: falsePositive === null || !significance ? '—' : `${significance.false_positives}/${significance.n_non_edges_tested}`,
          goodness: falsePositive === null ? null : 1 - falsePositive,
          raw: falsePositive,
        },
        volume: { display: volume === null ? '—' : pct(volume), goodness: volume === null ? null : 1 - volume, raw: volume },
        speed: { display: seconds === null ? '—' : seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(1)} s`, goodness: speed[position] ?? null, raw: seconds },
      },
    }
  })
}
