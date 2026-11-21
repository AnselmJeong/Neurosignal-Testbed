import { Sigma } from 'lucide-react'

import { MATH_STEPS, MathFormula } from '../lessons/mathSteps'

export interface MathStepAction {
  label: string
  onClick: () => void
  disabled?: boolean
}

/** P1-2: the lab's calculation in named steps, folded by default next to the controls. */
export function MathSteps({ lab, actions = {} }: { lab: keyof typeof MATH_STEPS; actions?: Record<string, MathStepAction> }) {
  const steps = MATH_STEPS[lab]
  return (
    <details className="math-steps">
      <summary><Sigma size={15} /> 수식으로 보기(The math)<small>{steps.length}단계</small></summary>
      <ol>
        {steps.map((step, index) => {
          const action = actions[step.id]
          return (
            <li key={step.id}>
              <b><span>{index + 1}</span>{step.title}</b>
              <p>{step.line}</p>
              <MathFormula label={step.spoken}>{step.formula}</MathFormula>
              {action && <button type="button" className="math-step-action" disabled={action.disabled} onClick={action.onClick}>{action.label}</button>}
            </li>
          )
        })}
      </ol>
      <p className="math-steps-source">매뉴얼의 같은 Lab "이론" 절을 줄인 것입니다. 기호의 뜻과 유도는 매뉴얼에 있습니다.</p>
    </details>
  )
}
