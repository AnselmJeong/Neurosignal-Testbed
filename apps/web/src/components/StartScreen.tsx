// P0-6: the first screen asks what the learner wants to know, not which technique to open.
import { ArrowRight, Compass } from 'lucide-react'

import { DATA_KIND_LABEL, LAB_LIMITS, START_QUESTIONS } from '../lessons/labGuide'
import { LABS, type LabId } from './LabNavigator'

export function StartScreen({ onLabChange }: { onLabChange: (lab: LabId) => void }) {
  return (
    <main className="start-screen">
      <header className="start-intro">
        <span className="eyebrow"><Compass size={13} /> 시작하기(Start here)</span>
        <h1>무엇이 궁금한가요?</h1>
        <p>기법 이름을 몰라도 괜찮습니다. 질문을 고르면 그 답을 직접 만들어 볼 수 있는 Lab으로 갑니다. 모든 Lab은 같은 순서로 진행합니다. 먼저 예측하고, 실행하고, 정답과 대조합니다.</p>
      </header>
      <ol className="start-questions">
        {START_QUESTIONS.map((item) => {
          const lab = LABS[item.lab]
          const kind = LAB_LIMITS[item.lab].kind
          return (
            <li key={item.question}>
              <button onClick={() => onLabChange(item.lab)}>
                <span className="start-question-lab">Lab {lab.number}{item.then ? ` → ${LABS[item.then].number}` : ''} · {lab.label}<em className={`data-kind ${kind === 'real' ? 'real' : 'simulated'}`}>{DATA_KIND_LABEL[kind]}</em></span>
                <strong>{item.question}</strong>
                <small>{item.hint}</small>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </li>
          )
        })}
      </ol>
      <p className="start-footnote">처음이라면 위에서부터 차례로 권합니다. 언제든 왼쪽 위의 "질문" 버튼으로 이 화면에 돌아올 수 있습니다. Lab 07(JR 벤치마크)은 Lab 03 다음 심화 과정입니다.</p>
    </main>
  )
}
