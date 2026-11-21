// Cross-lab teaching content: the question-first start screen (P0-6), what each lab cannot
// tell you (P0-7), and method cards in one shared shape (P0-5).
import type { LabId } from '../components/LabNavigator'

export type DataKind = 'simulated' | 'real' | 'mixed'

export const DATA_KIND_LABEL: Record<DataKind, string> = {
  simulated: '시뮬레이션 · 정답을 앎',
  real: '실제 기록 · 정답 없음',
  mixed: '시뮬레이션 또는 실제 기록',
}

export interface StartQuestion {
  question: string
  hint: string
  lab: Exclude<LabId, 'start'>
  then?: Exclude<LabId, 'start'>
}

/** The question a learner brings, not the technique name. Ordered like the recommended path. */
export const START_QUESTIONS: StartQuestion[] = [
  { question: '표본화율을 낮추면 무엇을 잃는가?', hint: '60 Hz가 40 Hz로 접히는 것을 직접 만들어 봅니다.', lab: 'filter' },
  { question: '눈 깜박임을 어떻게 빼는가?', hint: '성분을 하나씩 판정해 지우고, 무엇이 함께 사라졌는지 확인합니다.', lab: 'ica' },
  { question: '위상, 코히어런스, PLV가 낯설다', hint: '시계바늘과 화살표로 연결성 지표의 공통 원리를 5분 안에 봅니다.', lab: 'phase' },
  { question: '두 전극이 함께 움직이면 연결된 것인가?', hint: '연결이 없는 원천에서도 센서 연결선이 생기는 것을 봅니다.', lab: 'connectivity' },
  { question: '두피 신호로 뇌의 위치를 알 수 있는가?', hint: '정답 위치를 아는 원천으로 역해의 오차를 잽니다.', lab: 'source' },
  { question: '내 기록을 열어 보고 싶다', hint: '원본을 건드리지 않고 점검한 뒤 QEEG 지도까지 갑니다.', lab: 'real', then: 'qeeg' },
  { question: '연결과 방향은 같은 말인가?', hint: '정답 방향을 아는 모델에서 방향성 지표가 맞히는 것과 놓치는 것을 봅니다.', lab: 'flow' },
]

export interface LabLimits {
  kind: DataKind
  limits: string[]
}

/** "What this lab cannot tell you": the caveats that used to be scattered in small print. */
export const LAB_LIMITS: Record<Exclude<LabId, 'start'>, LabLimits> = {
  filter: {
    kind: 'simulated',
    limits: [
      '신호는 사인파 세 개와 1/f 배경의 합입니다. 실제 EEG의 눈·근육·움직임 아티팩트는 없습니다.',
      '실제 장비는 표본화 전에 anti-aliasing 필터를 겁니다. 여기서 60 Hz가 접히는 것은 그 필터를 일부러 뺐기 때문입니다.',
      '필터가 사건 관련 전위(ERP)의 모양과 시점을 어떻게 바꾸는지는 이 Lab에서 다루지 않습니다.',
    ],
  },
  ica: {
    kind: 'simulated',
    limits: [
      '심어 둔 아티팩트는 눈 깜박임 하나입니다. 근전도, 심전도, 전극 튐이 섞인 실제 자료는 판정이 더 어렵습니다.',
      '정답 성분을 알기 때문에 "얼마나 잘 지웠나"를 잴 수 있습니다. 실제 자료에서는 이 점수를 구할 수 없습니다.',
      'ICA는 확률적 알고리즘이라 seed가 바뀌면 성분의 순서와 부호가 바뀝니다.',
    ],
  },
  phase: {
    kind: 'simulated',
    limits: [
      '주파수 하나짜리 이상적인 사인파입니다. 실제 EEG의 위상은 필터와 대역 폭에 따라 달라집니다.',
      '화살표 길이를 모두 1로 두었습니다. 코히어런스처럼 진폭으로 가중하는 지표는 결과가 조금 다릅니다.',
    ],
  },
  connectivity: {
    kind: 'simulated',
    limits: [
      '원천 네 개와 센서 여덟 개의 도식입니다. 해부학적 뇌 모형이 아닙니다.',
      '임계값을 넘었다는 것은 "섞은 귀무 분포보다 크다"는 뜻일 뿐, 직접 연결이나 인과를 뜻하지 않습니다.',
      '위상차가 0°인 진짜 관계는 wPLI·PLI·허수 코히어런스로 보이지 않습니다.',
    ],
  },
  source: {
    kind: 'simulated',
    limits: [
      '순방향과 역방향 계산이 같은 구형 머리 모델을 씁니다. 실제 자료에서는 머리 모델·전극 위치 오차가 더해집니다.',
      '위치 오차는 이 기하와 이 잡음 수준에서의 값입니다. 다른 몽타주나 원천 깊이로 일반화할 수 없습니다.',
      'Minimum-norm은 가장 "조용한" 답을 고르는 사전 가정입니다. 뇌가 실제로 그렇게 작동한다는 주장이 아닙니다.',
    ],
  },
  real: {
    kind: 'real',
    limits: [
      '정답이 없습니다. QC 지표는 기술적 품질을 말할 뿐, 자료가 임상적으로 정상인지 말해 주지 않습니다.',
      '단위와 채널 유형은 파일의 메타데이터를 믿습니다. 메타데이터가 틀리면 이후 계산도 틀립니다.',
    ],
  },
  qeeg: {
    kind: 'mixed',
    limits: [
      '참조 집단(norm)은 합성입니다. 실제 규준 데이터베이스가 아니므로 z 점수를 진단에 쓸 수 없습니다.',
      '두피 지도는 전극 사이를 보간한 그림입니다. 전극이 없는 곳의 값은 측정값이 아닙니다.',
      '고정 주파수 대역은 개인의 알파 주파수가 바뀌면 경계를 넘나듭니다.',
    ],
  },
  benchmark: {
    kind: 'simulated',
    limits: [
      'Jansen–Rit 신경 집단 모델의 신호입니다. 효과 크기는 이 모델 안에서의 값이며 실제 뇌의 효과 크기가 아닙니다.',
      'seed가 적은 미리보기 실행은 p값이 작아질 수 없습니다. 이때는 효과의 방향과 신뢰구간의 폭을 보세요.',
    ],
  },
  flow: {
    kind: 'simulated',
    limits: [
      '방향의 정답은 모델이 정한 것입니다. 측정하지 않은 공통 원인이 있는 실제 자료에서는 어느 지표도 방향을 보장하지 않습니다.',
      '모델 비교의 사후확률은 "나열한 후보 가운데" 상대적으로 낫다는 뜻입니다. 정답일 확률이 아닙니다.',
      '센서 공간 결과는 볼륨 전도로 섞여 있습니다. 소스 공간 결과와 따로 읽어야 합니다.',
    ],
  },
}

export interface MethodCardContent {
  label: string
  /** Which family the method belongs to, in the lab's own words. */
  family: string
  does: string
  breaks: string
  useFor: string
  avoidFor: string
}

/** Lab 03 metric cards, condensed from the manual's "첫째 부류 / 둘째 부류 / 대가" sections. */
export const CONNECTIVITY_METHOD_CARDS: Record<'pearson' | 'coh' | 'plv' | 'imcoh' | 'ppc' | 'pli' | 'wpli', MethodCardContent> = {
  pearson: {
    label: 'Pearson |r|', family: '첫째 부류 · 0° 관계도 센다',
    does: '주파수로 나누지 않고 파형 전체가 함께 오르내리는지 잽니다. 이 앱은 절댓값을 씁니다.',
    breaks: '어느 리듬 때문에 닮았는지 알려 주지 않습니다. 볼륨 전도로 부풀려집니다.',
    useFor: '두 신호가 대체로 닮았는지 처음 훑어볼 때.', avoidFor: '특정 대역의 결합이나 영역 사이의 상호작용을 주장할 때.',
  },
  coh: {
    label: '코히어런스(Coherence)', family: '첫째 부류 · 0° 관계도 센다',
    does: '이 주파수에서 진폭과 위상이 함께 움직이는지, 주파수별 상관계수처럼 잽니다.',
    breaks: '한 원천이 두 전극에 번지기만 해도 높게 나옵니다. 진폭이 큰 epoch이 평균을 좌우합니다.',
    useFor: '원천 공간 자료나, 번짐이 작다고 알려진 비교.', avoidFor: '센서 공간에서 "두 영역이 연결되었다"고 말할 때.',
  },
  plv: {
    label: '위상 고정값(PLV)', family: '첫째 부류 · 0° 관계도 센다',
    does: '진폭을 버리고 위상차가 epoch마다 얼마나 한결같은지 잽니다.',
    breaks: '번짐으로 부풀려집니다. epoch이 적으면 무관한 신호에서도 0보다 크게 나옵니다.',
    useFor: 'epoch 수가 같은 조건끼리 위상 동기를 비교할 때.', avoidFor: 'epoch 수가 다른 조건의 비교(PPC를 쓰세요).',
  },
  ppc: {
    label: 'PPC 크기(Pairwise phase consistency)', family: '첫째 부류 · 0° 관계도 센다',
    does: 'PLV에서 epoch 수 때문에 생기는 편향을 뺀 값입니다. 무관한 신호에서 평균 0이 나옵니다.',
    breaks: '번짐과 진짜 결합은 여전히 구별하지 못합니다. 이 앱은 절댓값을 표시하므로 음수도 양수로 보입니다.',
    useFor: 'epoch 수가 다른 조건 사이의 위상 동기 비교.', avoidFor: '볼륨 전도가 큰 센서 공간 해석.',
  },
  imcoh: {
    label: '|허수 코히어런스|(Imag. coherence)', family: '둘째 부류 · 0° 관계를 버린다',
    does: '평균 화살표의 세로 성분만 봅니다. 0이 아니면 번짐만으로는 설명되지 않는, 지연이 있는 관계가 있습니다.',
    breaks: '값의 크기가 결합 강도와 위상차에 함께 좌우됩니다. 진짜 0° 관계를 놓칩니다.',
    useFor: '센서 공간에서 번짐을 피해 지연 관계를 찾을 때.', avoidFor: '값의 크기로 결합 강도를 비교할 때.',
  },
  pli: {
    label: '위상 지연 지수(PLI)', family: '둘째 부류 · 0° 관계를 버린다',
    does: '크기는 버리고 "누가 앞섰나"의 부호만 epoch마다 투표하게 합니다.',
    breaks: '위상차가 0° 근처면 작은 잡음에도 표가 뒤집혀 불안정합니다. 0° 관계를 놓칩니다.',
    useFor: '한쪽이 한결같이 앞서는지를 단순하게 볼 때.', avoidFor: '잡음이 크거나 위상차가 작은 자료.',
  },
  wpli: {
    label: '가중 위상 지연 지수(wPLI)', family: '둘째 부류 · 0° 관계를 버린다',
    does: 'PLI와 같되, 세로 성분이 커서 부호가 확실한 epoch의 표를 크게 셉니다.',
    breaks: '진짜 0° 관계를 놓칩니다. 0에 가깝다는 것은 "독립"이 아니라 "지연 관계를 찾지 못함"입니다.',
    useFor: '센서 공간에서 번짐에 강한 지연 결합 탐색.', avoidFor: '같은 입력을 동시에 받는 두 영역의 관계를 찾을 때.',
  },
}
