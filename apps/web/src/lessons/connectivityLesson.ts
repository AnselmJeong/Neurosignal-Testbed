// Lab 03 experiment cards. Correct answers were checked against the engine
// (neurobridge.connectivity.engine.run_connectivity_challenge), seed 314, coherence:
//   default        sensor 18/28 above null · Frontal L–R 0.725 detected · sensor threshold 0.451
//   shared 0       sensor 17/28           · Frontal L–R 0.330 not detected
//   spread 0.10    sensor 21/28           · Frontal L–R 0.725 detected (source estimate unchanged)
//   reference none sensor 27/28           · Frontal L–R 0.725 detected
//   epochs 8       sensor 12/28           · sensor threshold 0.704
import type { ConnectivityRecipe, ConnectivityResult } from '../types'
import type { GradedPrediction } from './samplingLesson'
import type { LabExperiment } from './useGradedLesson'

export const CONNECTIVITY_BASELINE_PREDICTION: GradedPrediction = {
  question: '기본 설정(공유 가중치 0.78, 장 퍼짐 0.72, 코히어런스)에서 센서 28쌍 가운데 귀무 임계값을 넘는 쌍은?',
  choices: [
    { id: 'few', text: '1–3쌍, 공유 성분이 있는 앞쪽 센서 근처만' },
    { id: 'many', text: '절반 이상' },
    { id: 'none', text: '하나도 없다' },
  ],
  correct: 'many',
  explanation: '28쌍 가운데 18쌍이 임계값을 넘습니다. 원천 공간에서 설정한 관계는 Frontal L–R 한 쌍뿐인데도, 장 퍼짐과 평균 기준이 원천을 여러 센서에 섞어 센서 쌍 대부분이 "연결"로 보입니다.',
}

export const CONNECTIVITY_EXPERIMENTS: LabExperiment<ConnectivityRecipe>[] = [
  {
    id: 'shared-0',
    title: '공유 알파를 빼기',
    change: '공유 알파 가중치(Shared alpha weight) 0.78 → 0',
    apply: (recipe) => ({ ...recipe, coupling_strength: 0 }),
    prediction: {
      question: '원천 사이의 관계를 완전히 없애면, 센서에서 임계값을 넘는 쌍의 수는?',
      choices: [
        { id: 'zero', text: '0쌍 가까이로 줄어든다' },
        { id: 'half', text: '절반쯤으로 줄어든다' },
        { id: 'same', text: '거의 그대로다' },
      ],
      correct: 'same',
      explanation: '센서 쌍은 18쌍에서 17쌍으로 한 쌍만 줄어듭니다. 원천 공간의 Frontal L–R 값은 0.73에서 0.33으로 떨어져 더 이상 검출되지 않지만, 센서 연결선 대부분은 원천의 관계가 아니라 혼합에서 왔기 때문에 남습니다.',
    },
    lookAt: 'A와 B의 센서 행렬을 나란히 보고, "원천 추정"으로 바꿔 Frontal 쌍도 비교하세요.',
    learn: '센서 연결성의 상당 부분은 원천 결합이 아니라 볼륨 전도와 기준전극이 만든 혼합에서 옵니다. 센서 연결선만으로 "두 영역이 대화한다"고 말할 수 없습니다.',
  },
  {
    id: 'spread-010',
    title: '장 퍼짐을 줄이기',
    change: '장 퍼짐(Field spread) 0.72 → 0.10',
    apply: (recipe) => ({ ...recipe, volume_conduction: 0.1 }),
    prediction: {
      question: '장 퍼짐만 0.10으로 줄이면 원천 공간의 Frontal L–R 추정값은?',
      choices: [
        { id: 'up', text: '올라간다' },
        { id: 'same', text: '그대로다' },
        { id: 'down', text: '내려간다' },
      ],
      correct: 'same',
      explanation: '원천 추정은 0.725로 정확히 같습니다. 장 퍼짐은 원천을 센서로 섞는 단계에만 작용하기 때문입니다. 반면 센서 공간에서는 임계값을 넘는 쌍이 18쌍에서 21쌍으로 바뀝니다.',
    },
    lookAt: '"원천 추정"과 "센서 추정"을 번갈아 보며 A와 B의 차이 지도를 비교하세요.',
    learn: '볼륨 전도는 원천의 관계를 바꾸지 않고 센서 지표만 바꿉니다. 같은 뇌 활동이라도 측정 기하가 다르면 센서 연결성이 달라집니다.',
  },
  {
    id: 'reference-none',
    title: '기준전극을 바꾸기',
    change: '센서 기준전극(Reference) 평균 → 재기준화 없음',
    apply: (recipe) => ({ ...recipe, reference: 'none' }),
    prediction: {
      question: '평균 기준을 빼고 원래 혼합 그대로 두면, 센서에서 임계값을 넘는 쌍은?',
      choices: [
        { id: 'fewer', text: '줄어든다' },
        { id: 'same', text: '비슷하다' },
        { id: 'almost-all', text: '거의 모든 쌍(25쌍 이상)이 된다' },
      ],
      correct: 'almost-all',
      explanation: '18쌍에서 27쌍으로 늘어 거의 모든 센서 쌍이 "연결"로 보입니다. 재기준화하지 않으면 모든 채널이 공통 성분을 그대로 나눠 갖기 때문입니다. 원천 공간 결과는 그대로입니다.',
    },
    lookAt: 'B의 센서 행렬에서 테두리가 있는 칸(임계값을 넘은 쌍)을 세어 보세요.',
    learn: '센서 연결성은 기준전극에 따라 크게 달라집니다. 기준전극이 다른 연구의 연결성 결과는 서로 직접 비교할 수 없습니다.',
  },
  {
    id: 'epochs-8',
    title: 'Epoch 수를 8로 줄이기',
    change: 'Epoch 수(Epochs) 24 → 8',
    apply: (recipe) => ({ ...recipe, epoch_count: 8 }),
    prediction: {
      question: 'Epoch를 8개로 줄이면 센서의 귀무 임계값은?',
      choices: [
        { id: 'down', text: '내려간다' },
        { id: 'same', text: '거의 그대로다' },
        { id: 'up', text: '크게 올라간다' },
      ],
      correct: 'up',
      explanation: '임계값이 0.45에서 0.70으로 올라가고, 넘는 쌍은 18쌍에서 12쌍으로 줄어듭니다. 평균할 화살표가 적으면 무관한 신호끼리도 우연히 한쪽으로 쏠려 섞은 귀무 분포 자체가 높아집니다.',
    },
    lookAt: '각 추정 아래 "귀무 임계값" 숫자와 세부 진단의 섞은 귀무 분포를 비교하세요.',
    learn: '표본 수가 적으면 값과 임계값이 모두 부풀고 흔들립니다. Epoch 수가 다른 조건의 연결성 값을 그대로 비교하면 안 됩니다.',
  },
]

const FRONTAL = ['Frontal L', 'Frontal R']
const frontalEdge = (result: ConnectivityResult) => result.latent_edges.find((edge) => FRONTAL.includes(edge.source) && FRONTAL.includes(edge.target))

/** P0-4: one sentence on what crossed the null in the sensors and what happened at the source pair. */
export function summarizeConnectivityResult(result: ConnectivityResult, baseline: ConnectivityResult | null): string {
  const sensorCount = result.sensor_edges.length
  const detected = result.sensor_edges.filter((edge) => edge.detected).length
  const frontal = frontalEdge(result)
  const versus = baseline && baseline.run_id !== result.run_id
    ? ` (A: ${baseline.sensor_edges.filter((edge) => edge.detected).length}쌍)`
    : ''
  const source = frontal
    ? ` 원천 공간에서 설정한 Frontal L–R 쌍은 ${frontal.weight.toFixed(2)}로 ${frontal.detected ? '임계값을 넘었습니다' : '임계값을 넘지 못했습니다'}.`
    : ''
  return `센서 ${sensorCount}쌍 가운데 ${detected}쌍${versus}이 귀무 임계값 ${result.sensor_threshold.toFixed(2)}를 넘었습니다.${source}`
}
