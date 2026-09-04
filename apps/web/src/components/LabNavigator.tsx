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
} from 'lucide-react'

export type LabId = 'filter' | 'ica' | 'connectivity' | 'source' | 'real'

export interface LabStep {
  label: string
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
    number: '03', label: 'Connectivity', title: 'When does a sensor edge lie?',
    objective: 'Compare latent and sensor networks, then test estimates against shuffled null data.', minutes: '15 min', icon: Waves,
  },
  source: {
    number: '04', label: 'Source', title: 'Where does the estimate spread?',
    objective: 'Reconstruct planted ROI activity and inspect leakage before making a location claim.', minutes: '15 min', icon: BrainCircuit,
  },
  real: {
    number: '05', label: 'Real data', title: 'From recording to QC report',
    objective: 'Inspect a local recording safely, make a FIF working copy, and review descriptive QC.', minutes: '12 min', icon: HardDrive,
  },
}

export function LabNavigator({ activeLab, onLabChange, steps, step, onStep }: {
  activeLab: LabId
  onLabChange: (lab: LabId) => void
  steps: readonly LabStep[]
  step: number
  onStep: (step: number) => void
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
          <span className="eyebrow">Lab {lab.number} · learning objective</span>
          <h2>{lab.title}</h2>
          <p>{lab.objective}</p>
        </div>
        <ol>
          {steps.map((item, index) => {
            const Icon = item.icon
            return (
              <li key={item.label} className={index === step ? 'active' : index < step ? 'done' : ''}>
                <button onClick={() => onStep(index)} aria-current={index === step ? 'step' : undefined}>
                  <span className="step-dot">{index < step ? <Check size={13} /> : <Icon size={14} />}</span>
                  <span><small>0{index + 1}</small><strong>{item.label}</strong></span>
                </button>
              </li>
            )
          })}
        </ol>
        <div className="lesson-duration"><FlaskConical size={15} /><span>{lab.minutes}</span></div>
      </section>
    </nav>
  )
}
