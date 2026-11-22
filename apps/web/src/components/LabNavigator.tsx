import { LAB_LIMITS } from '../lessons/labGuide'
import { LIBRARY } from '../lessons/library'
import {
  Activity,
  Brain,
  BrainCircuit,
  Check,
  Clock3,
  Compass,
  Route,
  Gamepad2,
  CircleHelp,
  FlaskConical,
  HardDrive,
  type LucideIcon,
  Waves,
  ChartNoAxesCombined,
  Network,
  Workflow,
} from 'lucide-react'

export type LabId = 'start' | 'journey' | 'filter' | 'ica' | 'phase' | 'connectivity' | 'source' | 'real' | 'qeeg' | 'benchmark' | 'flow' | 'practice'
export type LabKey = Exclude<LabId, 'start'>

export interface LabStep {
  label: string
  description: string
  icon: LucideIcon
}

export const LABS: Record<LabKey, { number: string; label: string; english: string; title: string; objective: string; minutes: string; icon: LucideIcon }> = {
  journey: {
    number: '00', label: '신호 여행', english: 'Signal journey', title: '원천에서 전극, 그리고 추정까지',
    objective: '일곱 장면에서 조작을 하나씩 움직이며, 모든 Lab이 놓인 길(원천 → 전극 → 추정)을 먼저 훑어봅니다.', minutes: '5–8분', icon: Route,
  },
  filter: {
    number: '01', label: '표본화', english: 'Sampling', title: '센서를 거치면 무엇이 남는가?',
    objective: '2, 10, 60 Hz를 심은 신호에서 표본화와 필터가 무엇을 바꾸는지 예측하고 확인합니다.', minutes: '8분', icon: Activity,
  },
  ica: {
    number: '02', label: 'ICA', english: 'ICA', title: '어느 성분이 눈 깜박임인가?',
    objective: '성분을 살펴보고, 신경 신호를 잃지 않으면서 심어 둔 깜박임을 제거합니다.', minutes: '12분', icon: Brain,
  },
  phase: {
    number: '준비', label: '위상', english: 'Phase primer', title: '화살표 하나로 읽는 위상',
    objective: '시계바늘, 화살표, 평균, 비교 대상. Lab 03부터 나오는 지표를 읽는 네 가지 생각을 직접 움직여 봅니다.', minutes: '5분', icon: Clock3,
  },
  connectivity: {
    number: '03', label: '연결성', english: 'Connectivity', title: '원천의 관계에서 센서의 연결선까지',
    objective: '원천 사이의 관계를 만들고, 그 EEG를 본 뒤, 두 설정에서 센서 연결성 추정을 비교합니다.', minutes: '15분', icon: Waves,
  },
  source: {
    number: '04', label: '원천', english: 'Source', title: 'EEG로 원천의 위치를 찾을 수 있는가?',
    objective: 'EEG에서 공간 파워 봉우리를 추정한 뒤, 위치 오차·놓친 원천·짝 없는 봉우리를 공개합니다.', minutes: '15분', icon: BrainCircuit,
  },
  real: {
    number: '05', label: '실제 자료', english: 'Real data', title: '기록에서 QC 보고서까지',
    objective: '로컬 기록을 안전하게 점검하고, FIF 작업 사본을 만든 뒤, 기술적 QC를 검토합니다.', minutes: '12분', icon: HardDrive,
  },
  qeeg: {
    number: '06', label: 'QEEG', english: 'QEEG', title: 'EEG는 어떻게 지도가 되는가?',
    objective: 'EEG를 시뮬레이션하고, 두피 지도를 만들고, 지표를 계산한 뒤, 합성 참조 집단과 비교합니다.', minutes: '18분', icon: ChartNoAxesCombined,
  },
  benchmark: {
    number: '07', label: 'JR 벤치마크', english: 'JR Benchmark', title: '결합이 바뀌면 무엇이 달라지는가?',
    objective: 'JR 네트워크로 네 조건을 생성하고 PLV·wPLI·wSMI의 seed paired 효과와 신뢰구간을 비교합니다.', minutes: '20분+', icon: Network,
  },
  flow: {
    number: '08', label: '정보 흐름', english: 'Information Flow', title: '연결성은 정보 흐름인가?',
    objective: '정답 방향을 아는 JR 소스와 그 EEG에서 GC·TE·DCM식 모델·activity flow·PID가 보여주는 것과 놓치는 것을 비교합니다.', minutes: '20분', icon: Workflow,
  },
  practice: {
    number: '+', label: '연습장', english: 'Practice', title: '판독을 문제로 반복하기',
    objective: '아티팩트 맞히기, 진짜 봉우리 가리기, 복원 샌드박스, 오늘의 문제로 Lab에서 배운 판독을 다시 연습합니다.', minutes: '자유', icon: Gamepad2,
  },
}

export function LabNavigator({ activeLab, onLabChange, steps, step }: {
  activeLab: LabId
  onLabChange: (lab: LabId) => void
  steps: readonly LabStep[]
  step: number
}) {
  const labKey: LabKey = activeLab === 'start' ? 'filter' : activeLab
  const lab = LABS[labKey]
  const limits = LAB_LIMITS[labKey]

  return (
    <nav className="lab-navigation" aria-label="Lab과 학습 단계">
      <section className="lab-list" aria-label="Lab 목록">
        <span className="eyebrow">Labs</span>
        <div>
          <button className="lab-start-button" onClick={() => onLabChange('start')} title="무엇이 궁금한가 · 질문으로 Lab 고르기">
            <small>시작</small><Compass size={16} /><span>질문</span>
          </button>
          {(Object.entries(LABS) as [LabKey, typeof lab][]).map(([id, item]) => {
            const Icon = item.icon
            return (
              <button key={id} className={id === activeLab ? 'active' : ''} onClick={() => onLabChange(id)} title={`Lab ${item.number} · ${item.english}`} aria-current={id === activeLab ? 'page' : undefined}>
                <small>{item.number}</small><Icon size={16} /><span>{item.label}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="lesson-steps" aria-label={`${lab.label} 학습 단계`}>
        <div className="lesson-intro">
          <span className="eyebrow">Lab {lab.number} · {lab.english} · 학습 목표</span>
          <h2>{lab.title}</h2>
          <p>{lab.objective}</p>
          <details className="lab-limits">
            <summary>이 Lab이 말해 주지 못하는 것</summary>
            <ul>{limits.limits.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>
          <details className="lab-limits lab-reading">
            <summary>더 읽기(Further reading)</summary>
            <ul>
              {LIBRARY[labKey].map((item) => (
                <li key={item.cite}>
                  <span className={`reading-level level-${item.level}`}>{item.level}</span>
                  <b>{item.title}</b>
                  <small>{item.cite}</small>
                  <span>{item.why}</span>
                  {item.alsoFor && <small className="reading-also">함께: {item.alsoFor.map((lab) => `Lab ${LABS[lab].number} ${LABS[lab].label}`).join(', ')}</small>}
                </li>
              ))}
            </ul>
            <p className="reading-source">모두 설명서 부록 C(참고 문헌)에 있는 문헌입니다.</p>
          </details>
        </div>
        <div className="lesson-progress-heading">
          <span>학습 진행</span>
          <small>{steps.length}단계 중 {step + 1}</small>
        </div>
        <ol aria-label={`${lab.label} 학습 진행`}>
          {steps.map((item, index) => {
            const Icon = item.icon
            const status = index === step ? '현재 단계' : index < step ? '완료' : '예정'
            return (
              <li key={item.label} className={index === step ? 'active' : index < step ? 'done' : ''} aria-current={index === step ? 'step' : undefined}>
                <div className="lesson-step">
                  <span className="step-dot">{index < step ? <Check size={13} /> : <Icon size={14} />}</span>
                  <span className="step-copy">
                    <small>0{index + 1} · {status}</small>
                    <strong>{item.label}</strong>
                    <p>{item.description}</p>
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
        <div className="lesson-duration"><FlaskConical size={15} /><span>{lab.minutes}</span></div>
      </section>
    </nav>
  )
}
