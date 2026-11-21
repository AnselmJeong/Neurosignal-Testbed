// Lab 02 experiment cards. Predictions are about the fitted components, which the settings
// alone decide (not which components the learner later removes). Checked against the engine
// (neurobridge.ica.workbench.fit_ica_workbench), seed 97, Ext. Infomax:
//   default      4 ICs, all matched (mean r 0.98); blink IC suggested "eye blink" 68 %
//   blink 0      one IC matches no planted source (0.1 % variance)
//   blink 20     blink IC still matched (r 0.90) but suggested as "muscle artifact"
//   noise 3 µV   mean matched r 0.98 → 0.62; blink IC suggested as "brain"
//   reference none  rank 8, ICLabel not evaluated
//   7 ICs        3 ICs match no planted source
// Multi-artifact variant (19 channels, 10 ICs, seed 97): every planted source gets its own IC
// (r ≥ 0.97). ICLabel calls the blink and horizontal-eye ICs "eye blink" but the muscle IC
// "other", the bad-electrode IC "brain" (89 %) and the heartbeat IC "eye blink" (75 %).
// Mixed component on: the blink IC also carries frontal theta (r 0.36); excluding it alone
// loses 54.5 % of the neural signal, and no IC matches theta.
import type { IcaComponentSummary, IcaFitResult, IcaRecipe } from '../types'
import type { GradedPrediction } from './samplingLesson'
import type { LabExperiment } from './useGradedLesson'

export const ICA_BASELINE_PREDICTION: GradedPrediction = {
  question: '기본 설정(깜박임 90 µV, 성분 4개)에서 심어 둔 깜박임은 ICA 성분에 어떻게 나타날까?',
  choices: [
    { id: 'one', text: '성분 하나에 거의 그대로 모인다' },
    { id: 'split', text: '여러 성분에 나뉘어 흩어진다' },
    { id: 'none', text: '어느 성분에도 뚜렷이 나타나지 않는다' },
  ],
  correct: 'one',
  explanation: '깜박임은 IC 01 하나에 모입니다(정답 원천과의 상관 0.98, 분산의 59%). 원천 수(4)와 성분 수(4)가 같고 잡음이 작아서, 네 성분이 모두 심은 원천 하나씩과 짝지어집니다.',
}

export const ICA_EXPERIMENTS: LabExperiment<IcaRecipe>[] = [
  {
    id: 'no-blink',
    title: '아티팩트 없는 대조군',
    change: '깜박임 진폭(Blink amplitude) 90 → 0 µV',
    apply: (recipe) => ({ ...recipe, blink_amplitude_uv: 0 }),
    prediction: {
      question: '깜박임을 아예 심지 않고 성분 4개를 추정하면?',
      choices: [
        { id: 'all-matched', text: '네 성분이 모두 심은 원천과 짝지어진다' },
        { id: 'one-orphan', text: '한 성분은 대응하는 원천이 없다' },
        { id: 'refuses', text: 'ICA가 성분을 내놓지 않는다' },
      ],
      correct: 'one-orphan',
      explanation: '원천은 알파·세타·베타 셋뿐인데 성분을 4개 요구했으므로, 하나(IC 04)는 대응하는 원천이 없는 잔여 성분이 됩니다. 분산의 0.1%밖에 설명하지 않지만 ICA는 성분을 그대로 내놓습니다.',
    },
    lookAt: '성분을 하나씩 눌러 "원천 정체"를 확인하세요. 분산이 거의 0인 성분은 무엇과 짝지어졌나요?',
    learn: '성분이 있다는 것이 제거할 근거는 아닙니다. 아티팩트가 없으면 제거할 것도 없고, 무엇을 지우든 신호만 잃습니다.',
  },
  {
    id: 'blink-20',
    title: '작은 깜박임',
    change: '깜박임 진폭(Blink amplitude) 90 → 20 µV',
    apply: (recipe) => ({ ...recipe, blink_amplitude_uv: 20 }),
    prediction: {
      question: '깜박임을 20 µV로 줄이면 ICLabel은 깜박임 성분을 뭐라고 제안할까?',
      choices: [
        { id: 'eye', text: '여전히 "eye blink"로 제안한다' },
        { id: 'other', text: '다른 아티팩트 라벨로 잘못 제안한다' },
        { id: 'missing', text: '깜박임 성분이 아예 사라진다' },
      ],
      correct: 'other',
      explanation: '깜박임 성분(IC 04)은 여전히 정답과 상관 0.90으로 분리되지만, ICLabel은 이것을 "muscle artifact"(72%)로 제안합니다. 분산이 6%로 작아져 전형적인 깜박임 모양에서 벗어났기 때문입니다.',
    },
    lookAt: '깜박임에 대응한 성분의 ICLabel 제안과 지형도를 함께 보세요.',
    learn: 'ICLabel은 참고용입니다. 라벨 하나만 보고 제외하면 안 되고, 시계열·스펙트럼·지형도를 함께 봐야 합니다.',
  },
  {
    id: 'noise-3',
    title: '센서 잡음을 크게',
    change: '센서 잡음(Sensor noise) 0.25 → 3 µV',
    apply: (recipe) => ({ ...recipe, sensor_noise_uv: 3 }),
    prediction: {
      question: '센서 잡음을 3 µV로 올리면 성분과 심은 원천의 평균 상관은?',
      choices: [
        { id: 'same', text: '거의 그대로다(0.9 이상)' },
        { id: 'drops', text: '크게 떨어진다(0.7 아래)' },
        { id: 'blink-only', text: '깜박임만 사라지고 나머지는 그대로다' },
      ],
      correct: 'drops',
      explanation: '평균 상관이 0.98에서 0.62로 떨어집니다. 깜박임은 여전히 IC 01(r 0.87)에 모이지만 ICLabel은 "brain"으로 제안하고, 알파 성분은 상관 0.19까지 무너집니다.',
    },
    lookAt: '알파와 세타에 대응한 성분의 상관값과 스펙트럼을 기본 설정과 비교하세요.',
    learn: '잡음이 크면 분해가 불안정해지고 성분의 정체가 흐려집니다. 큰 아티팩트는 그래도 잘 분리되지만, 작은 신경 신호가 먼저 무너집니다.',
  },
  {
    id: 'reference-none',
    title: '기준전극을 없애기',
    change: 'EEG 기준전극(Reference) 평균 → 없음',
    apply: (recipe) => ({ ...recipe, reference: 'none' }),
    prediction: {
      question: '평균 기준을 빼면 ICLabel 제안은?',
      choices: [
        { id: 'same', text: '평균 기준일 때와 같다' },
        { id: 'better', text: '더 확신 있게 제안한다' },
        { id: 'withheld', text: '제안하지 않고 보류한다' },
      ],
      correct: 'withheld',
      explanation: 'ICLabel은 평균 기준 EEG에 extended Infomax를 쓴 경우에 맞춰져 있습니다. 기준전극이 없으면 전제가 맞지 않아 앱이 제안을 보류합니다("not evaluated"). 독립 차원(rank)은 7에서 8로 바뀝니다.',
    },
    lookAt: '경고 카드와 성분 목록의 라벨, 왼쪽 위 rank 숫자를 보세요.',
    learn: '자동 분류기는 학습 조건을 벗어나면 쓸 수 없습니다. 기준전극은 rank와 분류기 전제 조건을 함께 바꿉니다.',
  },
  {
    id: 'multi-artifact',
    title: '아티팩트 다섯 가지, 19채널',
    change: '실습 장면 깜박임 하나 → 여러 아티팩트(19채널), 성분 4 → 10',
    apply: (recipe) => ({ ...recipe, scenario: 'multi_artifact', component_count: 10 }),
    prediction: {
      question: '깜박임, 수평 안구 운동, 근전도, 심전도, 불량 전극을 심었습니다. ICLabel은 이 다섯 성분 중 몇 개에 맞는 종류를 제안할까?',
      choices: [
        { id: 'all', text: '다섯 개 모두' },
        { id: 'some', text: '두세 개' },
        { id: 'none', text: '하나도 못 맞힌다' },
      ],
      correct: 'some',
      explanation: '눈 성분 둘(깜박임, 수평 안구 운동)만 "eye blink"로 맞힙니다. 근전도는 "other", 불량 전극은 "brain"(89%), 심전도는 "eye blink"(75%)로 제안합니다. 그래도 ICA는 다섯 아티팩트를 각각 한 성분으로 분리했습니다(상관 0.97 이상).',
    },
    lookAt: '지형도 격자에서 한 전극에만 몰린 성분, 옆머리에 몰린 성분을 찾고 "네 가지 확인"을 해 보세요.',
    learn: '분리가 잘 되어도 라벨은 틀릴 수 있습니다. 지형도·시계열·스펙트럼을 직접 보고 판정하는 습관이 필요합니다.',
  },
  {
    id: 'mixed-component',
    title: '섞인 성분',
    change: '여러 아티팩트(19채널) + 섞인 성분(Mixed component) 켜기',
    apply: (recipe) => ({ ...recipe, scenario: 'multi_artifact', component_count: 10, mixed_component: true }),
    prediction: {
      question: '전두 세타가 깜박임과 두피 분포가 똑같으면, 깜박임 성분 하나를 지울 때 신경 신호는 얼마나 잃을까?',
      choices: [
        { id: 'little', text: '거의 잃지 않는다(10% 미만)' },
        { id: 'half', text: '절반쯤 잃는다' },
        { id: 'unseparated', text: '깜박임 성분이 아예 나오지 않는다' },
      ],
      correct: 'half',
      explanation: '깜박임 성분은 여전히 나오지만(r 0.90), 세타도 함께 실려 있습니다(r 0.36). 이 성분 하나를 지우면 신경 신호의 55%가 함께 사라집니다. 세타에 대응하는 성분은 따로 없습니다.',
    },
    lookAt: '깜박임 성분의 스펙트럼에서 6 Hz 봉우리를 찾고, 공개 후 "이 성분만 지우면"의 손실을 보세요.',
    learn: '두 원천의 지형도가 같으면 ICA도 나눌 수 없습니다. 아티팩트 단서와 신경 단서가 함께 보이면, 의심되면 남기세요.',
  },
  {
    id: 'components-7',
    title: '성분을 7개로 늘리기',
    change: '성분 수(Components) 4 → 7',
    apply: (recipe) => ({ ...recipe, component_count: 7 }),
    prediction: {
      question: '원천은 4개인데 성분을 7개 추정하면, 심은 원천과 대응하지 않는 성분은 몇 개일까?',
      choices: [
        { id: 'zero', text: '0개, 원천이 더 잘게 나뉠 뿐이다' },
        { id: 'three', text: '3개' },
        { id: 'seven', text: '7개 모두 대응한다' },
      ],
      correct: 'three',
      explanation: '네 성분은 원천 넷과 짝지어지고, 남은 3개는 분산 0.1–0.3%의 잡음 성분입니다. 그런데 ICLabel은 이 중 둘을 "muscle artifact", "heart beat"로 제안합니다.',
    },
    lookAt: 'IC 05–07을 눌러 설명 분산과 ICLabel 제안, 원천 정체를 확인하세요.',
    learn: '성분 수를 원천보다 많이 잡으면 잡음 성분이 생기고, 분류기는 그것에도 그럴듯한 라벨을 붙입니다.',
  },
]

export const TRUTH_LABEL_KO: Record<string, string> = {
  alpha: '알파',
  theta: '세타',
  beta: '베타',
  blink: '깜박임',
  'horizontal eye': '수평 안구 운동',
  muscle: '근전도',
  heartbeat: '심전도',
  'bad electrode': '불량 전극',
}

export const truthName = (label: string) => TRUTH_LABEL_KO[label] ? `${TRUTH_LABEL_KO[label]}(${label})` : label

export type CheckVerdict = 'neural' | 'artifact' | 'unsure'

export interface JudgmentCheck {
  id: string
  label: string
  question: string
}

/** P1-4: the four checks behind every exclusion. One cue is never enough. */
export const ICA_JUDGMENT_CHECKS: JudgmentCheck[] = [
  { id: 'topography', label: '지형도(Topography)', question: '한 전극이나 머리 가장자리(앞 끝, 옆머리)에 몰렸나, 넓고 매끄럽게 퍼졌나?' },
  { id: 'trace', label: '시계열(Time course)', question: '봉우리, 계단, 규칙적인 뾰족파, 잡음 폭발이 보이나, 리듬이 이어지나?' },
  { id: 'spectrum', label: '스펙트럼(Spectrum)', question: '알파 같은 봉우리와 완만한 경사가 있나, 저주파에 몰리거나 고주파가 평평하게 높나?' },
  { id: 'label', label: '분산과 참고 라벨', question: '설명 분산과 ICLabel 제안이 위 세 판단과 맞나? 라벨만 따로 믿지 마세요.' },
]

export function judgmentAdvice(verdicts: Partial<Record<string, CheckVerdict>>): string {
  const values = ICA_JUDGMENT_CHECKS.map((check) => verdicts[check.id]).filter(Boolean) as CheckVerdict[]
  if (values.length < ICA_JUDGMENT_CHECKS.length) return `${values.length}/4 확인. 네 가지를 모두 본 뒤 판정하세요.`
  const artifact = values.filter((value) => value === 'artifact').length
  const neural = values.filter((value) => value === 'neural').length
  if (artifact === 4) return '네 단서가 모두 아티팩트를 가리킵니다. 제외 후보입니다.'
  if (neural >= 3) return '신경 신호 쪽 단서가 많습니다. 남기세요.'
  if (artifact >= 3 && neural === 0) return '아티팩트 쪽이 우세하지만 확신은 아닙니다. 지웠을 때 잃을 것을 생각해 보세요.'
  return '단서가 갈립니다. 섞인 성분일 수 있습니다. 의심되면 남기세요.'
}

export type ComponentGrade = 'removed-artifact' | 'missed-artifact' | 'removed-neural' | 'kept-neural' | 'mixed-removed' | 'mixed-kept' | 'residual'

/** Mixed: carries an artifact and a neural source at the same time (both |r| ≥ 0.3). */
export function isMixedComponent(component: IcaComponentSummary, artifactLabels: string[]): boolean {
  const correlations = Object.entries(component.truth_correlations ?? {}).filter(([, value]) => value >= 0.3)
  return correlations.some(([label]) => artifactLabels.includes(label)) && correlations.some(([label]) => !artifactLabels.includes(label))
}

export function gradeComponent(component: IcaComponentSummary, excluded: boolean, artifactLabels: string[]): ComponentGrade {
  if (isMixedComponent(component, artifactLabels)) return excluded ? 'mixed-removed' : 'mixed-kept'
  if (component.matched_kind === 'artifact') return excluded ? 'removed-artifact' : 'missed-artifact'
  if (component.matched_kind === 'neural') return excluded ? 'removed-neural' : 'kept-neural'
  return 'residual'
}

export const GRADE_TEXT: Record<ComponentGrade, string> = {
  'removed-artifact': '맞게 지움',
  'missed-artifact': '놓친 아티팩트',
  'removed-neural': '신경 신호를 지움',
  'kept-neural': '맞게 남김',
  'mixed-removed': '섞인 성분을 지움',
  'mixed-kept': '섞인 성분을 남김',
  residual: '잔여 성분',
}

/** P0-4: what the decomposition recovered, in one sentence. */
export function summarizeIcaFit(fit: IcaFitResult): string {
  const artifactLabels = fit.artifact_labels ?? ['blink']
  if (artifactLabels.length > 1) {
    const artifacts = fit.components.filter((item) => item.matched_kind === 'artifact')
    const wrong = artifacts.filter((item) => !labelFits(item.suggested_label, item.matched_truth))
    const mixed = fit.components.filter((item) => isMixedComponent(item, artifactLabels))
    return `아티팩트 ${artifactLabels.length}가지 중 ${artifacts.length}가지가 각각 한 성분에 모였고, ICLabel은 그중 ${wrong.length}개에 다른 종류를 제안했습니다.${mixed.length ? ` 성분 ${mixed.length}개는 아티팩트와 신경 신호를 함께 담고 있습니다.` : ''}`
  }
  const matched = fit.components.filter((item) => item.matched_truth !== null)
  const orphans = fit.components.length - matched.length
  const blink = fit.components.find((item) => item.matched_truth === 'blink')
  const blinkPart = blink
    ? ` 깜박임은 IC ${String(blink.index + 1).padStart(2, '0')}(r ${blink.matched_correlation?.toFixed(2)})에 모였고, ICLabel은 이를 "${blink.suggested_label}"로 제안했습니다.`
    : ' 깜박임에 대응한 성분은 없습니다.'
  return `성분 ${fit.components.length}개 가운데 ${matched.length}개가 심은 원천과 짝지어졌고(평균 상관 ${fit.mean_matched_correlation.toFixed(2)}), ${orphans}개는 대응하는 원천이 없습니다.${blinkPart}`
}

const LABEL_FITS: Record<string, string[]> = {
  blink: ['eye blink'],
  'horizontal eye': ['eye blink'],
  muscle: ['muscle artifact'],
  heartbeat: ['heart beat'],
  'bad electrode': ['channel noise'],
}

/** Whether an ICLabel class is the right family for a planted artifact. */
export function labelFits(suggested: string, truth: string | null): boolean {
  if (!truth) return false
  return (LABEL_FITS[truth] ?? []).includes(suggested)
}
