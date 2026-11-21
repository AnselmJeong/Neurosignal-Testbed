// Lab 04 experiment cards. Every correct answer was checked against the engine
// (neurobridge.source_modeling.engine.run_source_model_benchmark) at the default seed 2718:
//   default  matched 4 / missed 0 / unmatched 0 / mean error 24.1 mm
//   lag 0°   matched 4 / missed 0 / unmatched 0 (alpha peaks: still 2)
//   noise 1  matched 4 / missed 0 / unmatched 16
//   thr 10%  matched 4 / missed 0 / unmatched 7
//   λ² 10    matched 2 / missed 2 / unmatched 2
//   λ² 0.01  matched 4 / missed 0 / unmatched 7
import type { SourceModelRecipe, SourceModelResult } from '../types'
import type { GradedPrediction } from './samplingLesson'
import type { LabExperiment } from './useGradedLesson'

export const SOURCE_BASELINE_PREDICTION: GradedPrediction = {
  question: '기본 설정에서 심어 둔 원천 4개 가운데 몇 개가 파워 봉우리와 짝지어질까?',
  choices: [
    { id: 'all', text: '4개 모두 짝지어진다' },
    { id: 'some', text: '2–3개만 짝지어진다' },
    { id: 'few', text: '1개 이하만 짝지어진다' },
  ],
  correct: 'all',
  explanation: '잡음이 작고(0.08 µV) 원천들이 서로 멀리 떨어져 있어 네 원천이 모두 짝지어집니다. 하지만 짝지은 평균 거리는 약 24 mm입니다. 정답을 아는 깨끗한 시뮬레이션에서도 minimum norm은 활동을 퍼뜨려 위치를 정확히 되찾지 못합니다.',
}

export const SOURCE_EXPERIMENTS: LabExperiment<SourceModelRecipe>[] = [
  {
    id: 'lag-0',
    title: '앞쪽 두 알파 원천을 완전히 동기화하기',
    change: '알파 위상 지연(Alpha phase lag) 55 → 0°',
    apply: (recipe) => ({ ...recipe, phase_lag_deg: 0 }),
    prediction: {
      question: '앞쪽 두 10 Hz 원천을 0°로 동기화하면 알파 대역 파워 봉우리는?',
      choices: [
        { id: 'merge', text: '하나로 합쳐진다' },
        { id: 'two', text: '두 개가 그대로 남는다' },
        { id: 'none', text: '하나도 검출되지 않는다' },
      ],
      correct: 'two',
      explanation: '이 모형에서 두 앞쪽 원천은 좌우로 멀리 떨어져 있어, 동기화해도 알파 봉우리 두 개가 그대로 남고 짝짓기 결과도 같습니다. 두 원천의 퍼짐이 거의 겹치지 않아서 동기화만으로는 봉우리가 합쳐지지 않습니다. 합쳐짐은 두 원천의 퍼짐이 겹칠 만큼 가까울 때 생깁니다.',
    },
    lookAt: '파워 지도에서 알파 대역 봉우리 수와 위치를 보세요. 기본 설정(55°) 실행과 같나요?',
    learn: '동기화가 곧 "구별 불가"는 아닙니다. 역해가 두 원천을 하나로 보는 것은 주로 공간적 거리와 퍼짐 때문입니다. 실제 머리에서 가깝게 붙은 동기 원천이면 이야기가 달라집니다.',
  },
  {
    id: 'noise-1',
    title: '센서 잡음을 1 µV로 올리기',
    change: '센서 잡음(Sensor noise) 0.08 → 1 µV',
    apply: (recipe) => ({ ...recipe, sensor_noise_uv: 1 }),
    prediction: {
      question: '센서 잡음을 1 µV로 올리면 정답에 없는 "짝 없는 봉우리"는?',
      choices: [
        { id: 'same', text: '0개 그대로다' },
        { id: 'few', text: '1–5개 생긴다' },
        { id: 'many', text: '10개 이상 생긴다' },
      ],
      correct: 'many',
      explanation: '짝 없는 봉우리가 0개에서 16개로 늘어납니다. 심은 원천 4개는 여전히 짝지어지지만, 잡음이 모든 대역에 국소 극댓값을 만들어 검출기가 그것들도 봉우리로 보고합니다.',
    },
    lookAt: '세타·베타 대역 파워 지도에서 정답 위치 표시와 짝이 없는 봉우리를 세어 보세요.',
    learn: '잡음도 파워 봉우리를 만듭니다. 원천 지도에서 봉우리가 많다고 원천이 많은 것이 아닙니다. 실제 자료에서는 짝 없는 봉우리를 가려낼 정답이 없습니다.',
  },
  {
    id: 'threshold-10',
    title: '봉우리 임계값을 10%로 낮추기',
    change: '봉우리 임계값(Peak threshold) 35 → 10%',
    apply: (recipe) => ({ ...recipe, inverse: { ...recipe.inverse, peak_threshold: 0.1 } }),
    prediction: {
      question: '임계값을 10%로 낮춰 더 약한 극댓값까지 봉우리로 세면?',
      choices: [
        { id: 'fewer-missed', text: '놓친 원천이 줄어든다' },
        { id: 'more-false', text: '놓친 원천은 0개 그대로이고 짝 없는 봉우리가 늘어난다' },
        { id: 'nothing', text: '아무것도 바뀌지 않는다' },
      ],
      correct: 'more-false',
      explanation: '기본 설정에서 이미 놓친 원천이 없으므로 민감도를 올려도 얻는 것이 없습니다. 대신 베타 대역에서 봉우리가 1개에서 8개로 늘어 짝 없는 봉우리가 7개 생깁니다.',
    },
    lookAt: '베타 대역 파워 지도의 봉우리 수를 기본 실행과 비교하세요.',
    learn: '민감도와 거짓 검출은 맞바꾸는 관계입니다. 임계값은 유의성 검정이 아니라 내가 정한 기술적 기준선입니다.',
  },
  {
    id: 'lambda-10',
    title: '정규화를 아주 강하게(λ² 10)',
    change: '정규화(Regularization) λ² 0.111 → 10',
    apply: (recipe) => ({ ...recipe, inverse: { ...recipe.inverse, lambda2: 10 } }),
    prediction: {
      question: 'λ²를 10으로 키워 해를 더 "조용하게" 만들면?',
      choices: [
        { id: 'better', text: '위치가 더 정확해진다' },
        { id: 'missed', text: '심은 원천 일부를 놓친다' },
        { id: 'same', text: '결과가 거의 같다' },
      ],
      correct: 'missed',
      explanation: '짝지어진 원천이 4개에서 2개로 줄고 2개를 놓칩니다. 짝 없는 봉우리도 2개 생깁니다. 강한 정규화가 약한 원천을 누르고 활동을 넓게 번지게 해서 봉우리가 엉뚱한 곳으로 옮겨 갑니다.',
    },
    lookAt: '정답 진단의 "놓친 원천"과 파워 지도의 퍼짐을 기본 실행과 비교하세요.',
    learn: '정규화는 해의 모양을 바꿉니다. 강하게 걸면 잡음은 눌리지만 약한 원천도 함께 사라집니다. 사진의 노이즈 제거를 너무 세게 걸면 윤곽이 뭉개지는 것과 같습니다.',
  },
  {
    id: 'lambda-001',
    title: '정규화를 아주 약하게(λ² 0.01)',
    change: '정규화(Regularization) λ² 0.111 → 0.01',
    apply: (recipe) => ({ ...recipe, inverse: { ...recipe.inverse, lambda2: 0.01 } }),
    prediction: {
      question: 'λ²를 0.01로 줄여 자료에 더 충실하게 맞추면?',
      choices: [
        { id: 'perfect', text: '오차 없이 모든 원천을 정확히 찾는다' },
        { id: 'false', text: '원천은 모두 찾지만 짝 없는 봉우리가 생긴다' },
        { id: 'missed', text: '원천을 놓치기 시작한다' },
      ],
      correct: 'false',
      explanation: '네 원천은 모두 짝지어지지만 짝 없는 봉우리가 7개 생기고 평균 거리도 24 mm에서 28 mm로 늘어납니다. 정규화가 약하면 작은 잡음까지 그대로 설명하려 해서 가짜 극댓값이 생깁니다.',
    },
    lookAt: '베타 대역 파워 지도의 봉우리 수와 정답 진단의 평균 거리를 보세요.',
    learn: '작은 λ²가 더 정확한 위치를 보장하지 않습니다. 너무 약하면 잡음을, 너무 강하면 원천을 놓칩니다.',
  },
]

/** P0-4: the result in one sentence, counting misses and false peaks next to the distance. */
export function summarizeSourceResult(result: SourceModelResult): string {
  const { evaluation } = result
  const planted = result.rois.length
  const distance = evaluation.mean_error_mm === null ? '' : ` 짝지은 봉우리의 평균 거리는 ${evaluation.mean_error_mm.toFixed(1)} mm입니다.`
  return `심어 둔 원천 ${planted}개 가운데 ${evaluation.matched_count}개를 ${evaluation.match_radius_mm} mm 안에서 짝지었고, ${evaluation.missed_count}개를 놓쳤으며, 정답에 없는 봉우리가 ${evaluation.unmatched_peak_count}개 생겼습니다.${distance}`
}
