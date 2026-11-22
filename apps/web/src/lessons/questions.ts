// P2-4: suggested questions per lab. Each answer is a short paraphrase of the app manual, and
// `section` names where the full explanation is, so a learner can go straight to it.
import type { LabKey } from '../components/LabNavigator'

export interface SuggestedQuestion {
  question: string
  answer: string
  /** Manual location: chapter › section › subsection, as titled in the manual. */
  section: string
  /** Optional in-app place to try it right away. */
  tryIn?: LabKey
}

export const SUGGESTED_QUESTIONS: Record<LabKey, SuggestedQuestion[]> = {
  journey: [
    {
      question: '평균 기준은 왜 rank를 하나 줄이나요?',
      answer: '평균 기준은 매 시점 모든 채널의 평균을 빼므로 채널 값의 합이 항상 0입니다. 그래서 N채널이어도 독립 차원은 N−1개입니다. ICA의 성분 수, 역해의 정보량, 조건부 Granger의 계산 가능 여부가 모두 이 숫자에 묶입니다.',
      section: '공통 기초 › 기준전극과 rank',
      tryIn: 'ica',
    },
    {
      question: '"연결성"이라는 말이 가리키는 것이 다 같은가요?',
      answer: '아닙니다. 구조적 연결성(도로 지도), 기능적 연결성(두 동네가 같은 시간에 붐비는가), 방향성·유효 연결성(차가 어디서 어디로 가는가), 정보 흐름(무엇을 싣고 가서 무엇이 만들어지는가)은 서로 다른 질문입니다. 강한 기능적 연결성은 여러 인과 구조 어느 것에서도 나옵니다.',
      section: 'Lab 08 › 이론 › 네 가지 개념의 구분',
      tryIn: 'flow',
    },
  ],
  filter: [
    {
      question: '60 Hz가 왜 40 Hz에 나타나나요?',
      answer: 'Nyquist 주파수(표본화율의 절반)보다 빠른 성분은 사라지지 않고 |f − k·fₛ| 자리로 접힙니다. 100 Hz로 표본화하면 60 Hz는 |60 − 100| = 40 Hz에 나타나고, 원래 40 Hz였던 성분과 구별할 수 없습니다. 실제 장비는 표본화 전에 anti-aliasing 필터를 겁니다.',
      section: 'Lab 01 › 이론 › Aliasing',
    },
    {
      question: '차단 주파수 위의 성분은 완전히 사라지나요?',
      answer: '아닙니다. 차단 주파수 근처에는 이득이 서서히 변하는 전이 대역이 있고, 그 안의 성분은 줄어들 뿐 남습니다. Butterworth 필터는 차단 주파수에서 −3 dB이고 차수가 클수록 경사가 가파릅니다.',
      section: 'Lab 01 › 이론 › 디지털 필터',
      tryIn: 'practice',
    },
    {
      question: '영위상 필터는 언제 쓰면 안 되나요?',
      answer: '앞뒤로 두 번 걸러 위상 지연을 없애지만 각 시점에 미래 표본이 섞입니다. "과거가 미래를 예측하는가"를 묻는 방향성 분석에서는 시험 문제가 미리 새는 것과 같아서, Lab 08은 한 방향으로만 거는 인과 필터를 씁니다.',
      section: 'Lab 01 › 이론 › 영위상(zero-phase) 필터링',
      tryIn: 'flow',
    },
  ],
  ica: [
    {
      question: 'ICA를 왜 1 Hz로 거른 사본에 맞추나요?',
      answer: '느린 drift는 분산이 커서 분해를 지배하고 성분 분리를 망칩니다. 그래서 거른 사본에 ICA를 적합하고, 얻은 분리 행렬은 원래 자료에 적용합니다. 두 자료는 채널 순서, 기준전극, rank가 같아야 합니다.',
      section: 'Lab 02 › 이론 › 적합용 사본과 적용 대상',
    },
    {
      question: '성분을 지우면 무엇이 함께 사라지나요?',
      answer: '성분 하나를 지우면 그 성분의 지형도 × 시계열을 전극 신호에서 뺍니다. 분리가 완벽하지 않으면 그 성분에 섞인 뇌 신호도 함께 빠집니다. 제거는 언제나 아티팩트 감소와 신호 손실의 교환입니다.',
      section: 'Lab 02 › 이론 › 성분 제거와 재구성',
      tryIn: 'journey',
    },
    {
      question: '아티팩트 성분은 무엇으로 판단하나요?',
      answer: '한 가지 단서로는 부족합니다. 시간 경과(간헐적인 큰 봉우리인가), 스펙트럼(저주파에 몰리는가, 특정 리듬 봉우리가 있는가), 지형도(전두극에 몰리는가)를 함께 봅니다.',
      section: 'Lab 02 › 이론 › 성분을 판단하는 세 가지 증거',
      tryIn: 'practice',
    },
  ],
  phase: [
    {
      question: '복소수가 왜 연결성에 나오나요?',
      answer: '복소수는 길이와 방향을 가진 화살표를 숫자 하나로 적는 방법일 뿐입니다. 위상차를 화살표로 적고 여러 epoch에서 평균하면, 그 평균 화살표의 길이가 일관성(PLV, coherence)이 됩니다.',
      section: '준비 · 위상과 화살표 › 생각 2, 생각 3',
    },
    {
      question: '숫자 하나는 왜 비교 대상이 필요한가요?',
      answer: '관계가 없는 두 신호도 epoch가 적으면 화살표가 우연히 쏠려 PLV가 0보다 크게 나옵니다. 그래서 관계를 끊은 자료로 "관계가 없을 때의 분포"를 만들어 견줍니다.',
      section: '준비 · 위상과 화살표 › 생각 4',
    },
  ],
  connectivity: [
    {
      question: 'PLV가 높으면 두 영역이 대화하는 건가요?',
      answer: '아닐 수 있습니다. 한 원천의 전기장은 지연 없이 여러 전극에 번져서 위상차가 매번 0°가 됩니다. 한결같은 위상차이므로 coherence와 PLV는 높게 나오지만, 대화인지 번짐인지는 알려 주지 못합니다.',
      section: 'Lab 03 › 이론 › 볼륨 전도라는 함정',
      tryIn: 'practice',
    },
    {
      question: 'wPLI가 0에 가까우면 두 원천은 독립인가요?',
      answer: '아닙니다. 세로 성분만 쓰는 지표는 진짜로 위상차가 0°인 관계도 함께 버립니다. "wPLI가 0에 가깝다"는 "시간 지연이 있는 관계는 찾지 못했다"로 읽어야 합니다.',
      section: 'Lab 03 › 이론 › 대가: 버린 것 속에 진짜도 있다',
    },
    {
      question: '대리자료 검정을 넘으면 진짜 결합인가요?',
      answer: '아닙니다. 임계값을 넘었다는 것은 epoch마다 한결같은 관계가 있다는 뜻일 뿐이고, 번짐으로 생긴 관계도 한결같으므로 넘습니다. 통계적으로 유의한 것과 뇌 영역 사이의 결합인 것은 별개입니다.',
      section: 'Lab 03 › 이론 › 대리자료(surrogate) 검정',
    },
  ],
  source: [
    {
      question: '왜 역문제의 답이 하나로 정해지지 않나요?',
      answer: '이 Lab에서는 13개의 독립 측정으로 250개 후보 위치의 세기를 풀어야 합니다. 식보다 미지수가 많으면 답이 무한히 많고, 두피에 흔적을 남기지 않는 원천 조합도 있습니다. 그래서 모든 역해법은 "무엇을 고를지"라는 규칙을 덧붙입니다.',
      section: 'Lab 04 › 이론 › 역문제: 왜 답이 하나로 정해지지 않는가',
      tryIn: 'journey',
    },
    {
      question: 'λ²를 작게 하면 위치가 더 정확해지나요?',
      answer: '보장되지 않습니다. 작으면 자료를 곧이곧대로 믿어 잡음도 원천처럼 그리고, 크면 지도가 매끄럽고 넓게 퍼집니다. 관례는 λ² = 1/SNR²이고 기본값 1/9는 신호가 잡음의 3배라는 가정입니다.',
      section: 'Lab 04 › 이론 › Minimum-norm 추정',
    },
    {
      question: '원천 공간으로 가면 볼륨 전도가 사라지나요?',
      answer: '아닙니다. 추정값은 전극 전압의 가중합이므로 다른 원천이 섞여 듭니다(교차 누설). 추정한 원천 시계열 사이의 연결성에도 겉보기 연결이 남습니다.',
      section: 'Lab 04 › 이론 › 해상도 행렬',
      tryIn: 'practice',
    },
  ],
  real: [
    {
      question: '분석 전에 무엇을 확인해야 하나요?',
      answer: '파일 형식과 표본화율, 채널 유형과 단위, 기록 시 필터 설정, annotation, 전극 위치입니다. 단위 가정이 틀리면 파워가 수백만 배 틀리고, 전극 위치가 없으면 두피 지도와 원천 분석을 할 수 없습니다.',
      section: 'Lab 05 › 이론과 원칙 › 분석 전에 확인할 메타데이터',
    },
    {
      question: 'QC 결과는 진단인가요?',
      answer: '아닙니다. QC는 기술(descriptive)입니다. 눈 감은 기록에서 알파가 커지는지(Berger 효과) 보는 것도 파이프라인이 제대로 작동하는지에 대한 점검이지 개인에 대한 결론이 아닙니다.',
      section: 'Lab 05 › 이론과 원칙 › 기술적 QC',
    },
  ],
  qeeg: [
    {
      question: 'z 지도에 붉은 점이 몇 개 있으면 이상 소견인가요?',
      answer: '그렇지 않습니다. 전극 19개 × 대역 5개면 z가 95개이고, 완전히 정상인 사람도 약 5%(네댓 개)는 |z| > 2가 됩니다. ±2는 표시 기준일 뿐 다중비교를 보정한 유의 기준이 아닙니다.',
      section: 'Lab 06 › 이론 › 규준 비교와 z 점수',
    },
    {
      question: '두피 지도의 색은 어디서 오나요?',
      answer: '원천 활동 → 전극 EEG → 기준전극과 Welch 스펙트럼 → 대역 적분 → 전극 사이 보간 → 참조 집단과의 z 변환이라는 긴 사슬의 끝입니다. 앞 단계의 선택이 뒤의 모든 숫자를 바꿉니다.',
      section: 'Lab 06 › 이론 › 계산 사슬',
    },
  ],
  benchmark: [
    {
      question: '조건 C가 왜 가장 교훈적인가요?',
      answer: 'C는 결합이 없고 번짐만 있는 칸입니다. C에서 값이 높다면 그것은 전부 번짐이 만든 것입니다. A는 결합도 번짐도 없는 바닥값(위약군)입니다.',
      section: 'Lab 07 › 이론 › 네 조건과 대비: 2×2 요인 설계',
    },
    {
      question: 'epoch가 많으면 표본도 많은 건가요?',
      answer: '아닙니다. 독립 반복의 단위는 seed(시뮬레이션 한 번)입니다. 한 실행의 epoch들을 독립 표본으로 세면 신뢰구간이 거짓으로 좁아집니다(pseudoreplication). 실제 연구에서는 피험자가 단위입니다.',
      section: 'Lab 07 › 이론 › 통계: "n이 몇인가"를 정직하게 센다',
    },
  ],
  flow: [
    {
      question: 'Granger causality는 원인을 말해 주나요?',
      answer: '"A의 과거가 B의 예측을 돕는다"는 뜻이지 원인이라는 뜻은 아닙니다. 수탉의 울음은 해돋이를 잘 예측하지만 해를 뜨게 하지 않습니다. 측정하지 않은 공통 원인에는 조건부 GC도 손쓸 수 없습니다.',
      section: 'Lab 08 › 이론 › Granger causality: 과거가 예측을 돕는가',
      tryIn: 'journey',
    },
    {
      question: '시간 역전 검정은 무엇을 보나요?',
      answer: '녹음을 거꾸로 틀어 다시 계산합니다. 지연이 있는 진짜 관계라면 방향도 뒤집혀야 합니다. 번짐처럼 지연이 없는 관계가 만든 겉보기 방향은 거꾸로 틀어도 그대로 남습니다.',
      section: 'Lab 08 › 이론 › Granger causality: 과거가 예측을 돕는가 (시간 역전 검정)',
    },
  ],
  practice: [
    {
      question: '아티팩트를 판독하는 순서가 있나요?',
      answer: '시간 경과(모양), 스펙트럼(주파수), 지형도(위치)를 함께 봅니다. 연습장의 아티팩트 문제는 이 순서대로 단서를 엽니다.',
      section: 'Lab 02 › 이론 › 성분을 판단하는 세 가지 증거',
    },
    {
      question: '0 ms 봉우리는 왜 번짐을 뜻하나요?',
      answer: '번짐은 순간적이라 두 전극의 마루와 골이 정확히 같은 시점에 옵니다. 뉴런이 다른 영역에 영향을 주는 데는 수 ms에서 수십 ms가 걸리므로, 진짜 상호작용은 대개 0°가 아닌 위상차를 남깁니다.',
      section: 'Lab 03 › 이론 › 둘째 부류: 0° 관계를 일부러 버린다',
    },
  ],
}
