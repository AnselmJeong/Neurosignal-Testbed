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
} from 'lucide-react'

export type LabId = 'filter' | 'ica' | 'connectivity' | 'source' | 'real' | 'qeeg'

export interface LabStep {
  label: string
  description: string
  icon: LucideIcon
}

const LABS: Record<LabId, { number: string; label: string; title: string; objective: string; minutes: string; icon: LucideIcon }> = {
  filter: {
    number: '01', label: 'Sampling', title: 'What survives the sensor?',
    objective: 'Predict how sampling and filtering change a known 2, 10, and 60 Hz signal.', minutes: '8 min', icon: Activity,
  },
  ica: {
    number: '02', label: 'ICA', title: 'Which component is the blink?',
    objective: 'Inspect components and remove a planted blink without losing neural signal.', minutes: '12 min', icon: Brain,
  },
  connectivity: {
    number: '03', label: 'Connectivity', title: 'From sources to sensor edges',
    objective: 'Build a source relationship, observe its EEG, and compare sensor estimates under two settings.', minutes: '15 min', icon: Waves,
  },
  source: {
    number: '04', label: 'Source', title: 'Can EEG locate its sources?',
    objective: 'Estimate spatial power peaks from EEG, then reveal displacement, missed sources and unmatched peaks.', minutes: '15 min', icon: BrainCircuit,
  },
  real: {
    number: '05', label: 'Real data', title: 'From recording to QC report',
    objective: 'Inspect a local recording safely, make a FIF working copy, and review descriptive QC.', minutes: '12 min', icon: HardDrive,
  },
  qeeg: {
    number: '06', label: 'QEEG', title: 'How does EEG become a map?',
    objective: 'Simulate EEG, build scalp maps, calculate metrics, and compare a synthetic reference cohort.', minutes: '18 min', icon: ChartNoAxesCombined,
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
    <nav className="lab-navigation" aria-label="Lab and lesson navigation">
      <section className="lab-list" aria-label="Labs">
        <span className="eyebrow">Labs</span>
        <div>
          {(Object.entries(LABS) as [LabId, typeof lab][]).map(([id, item]) => {
            const Icon = item.icon
            return (
              <button key={id} className={id === activeLab ? 'active' : ''} onClick={() => onLabChange(id)} aria-current={id === activeLab ? 'page' : undefined}>
                <small>{item.number}</small><Icon size={16} /><span>{item.label}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="lesson-steps" aria-label={`${lab.label} lesson steps`}>
        <div className="lesson-intro">
          <span className="eyebrow">Lab {lab.number} · learning goal</span>
          <h2>{lab.title}</h2>
          <p>{lab.objective}</p>
        </div>
        <div className="lesson-progress-heading">
          <span>Lesson progress</span>
          <small>Step {step + 1} of {steps.length}</small>
        </div>
        <ol aria-label={`${lab.label} lesson progress`}>
          {steps.map((item, index) => {
            const Icon = item.icon
            const status = index === step ? 'Current step' : index < step ? 'Completed' : 'Upcoming'
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
