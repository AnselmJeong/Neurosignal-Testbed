import {
  Activity,
  Brain,
  BrainCircuit,
  Check,
  CircleHelp,
  FlaskConical,
  HardDrive,
  type LucideIcon,
  Waves,
  ChartNoAxesCombined,
  Network,
  Workflow,
} from 'lucide-react'

export type LabId = 'filter' | 'ica' | 'connectivity' | 'source' | 'real' | 'qeeg' | 'benchmark' | 'flow'

export interface LabStep {
  label: string
  description: string
  icon: LucideIcon
}

const LABS: Record<LabId, { number: string; label: string; english: string; title: string; objective: string; minutes: string; icon: LucideIcon }> = {
  filter: {
    number: '01', label: '표본화', english: 'Sampling', title: '센서를 거치면 무엇이 남는가?',
    objective: '2, 10, 60 Hz를 심은 신호에서 표본화와 필터가 무엇을 바꾸는지 예측하고 확인합니다.', minutes: '8분', icon: Activity,
  },
  ica: {
    number: '02', label: 'ICA', english: 'ICA', title: '어느 성분이 눈 깜박임인가?',
    objective: '성분을 살펴보고, 신경 신호를 잃지 않으면서 심어 둔 깜박임을 제거합니다.', minutes: '12분', icon: Brain,
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
}

export function LabNavigator({ activeLab, onLabChange, steps, step }: {
  activeLab: LabId
  onLabChange: (lab: LabId) => void
  steps: readonly LabStep[]
  step: number
}) {
  const lab = LABS[activeLab]

  return (
    <nav className="lab-navigation" aria-label="Lab과 학습 단계">
      <section className="lab-list" aria-label="Lab 목록">
        <span className="eyebrow">Labs</span>
        <div>
          {(Object.entries(LABS) as [LabId, typeof lab][]).map(([id, item]) => {
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
