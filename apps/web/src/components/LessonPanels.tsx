// Shared teaching widgets: graded multiple-choice predictions and "Try this" experiment cards.
// They are lab-agnostic so later labs can reuse the same pattern.
import { Check, CheckCircle2, CircleHelp, FlaskConical, Lightbulb, SkipForward, XCircle } from 'lucide-react'

import type { MethodCardContent } from '../lessons/labGuide'
import type { GradedPrediction } from '../lessons/samplingLesson'

/** null = not answered yet, 'skip' = learner chose to run without predicting. */
export type PredictionAnswer = string | 'skip' | null

export function PredictionChoices({ prediction, answer, onAnswer, reason, onReason, locked }: {
  prediction: GradedPrediction
  answer: PredictionAnswer
  onAnswer: (answer: PredictionAnswer) => void
  reason: string
  onReason: (reason: string) => void
  locked: boolean
}) {
  return (
    <section className="prediction-block graded-prediction" aria-labelledby="prediction-question">
      <span className="prediction-label"><CircleHelp size={15} /> 먼저 예측하기(Predict)</span>
      <p id="prediction-question" className="prediction-question">{prediction.question}</p>
      <div className="prediction-choices" role="radiogroup" aria-labelledby="prediction-question">
        {prediction.choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={answer === choice.id}
            className={answer === choice.id ? 'selected' : ''}
            disabled={locked}
            onClick={() => onAnswer(choice.id)}
          >
            <i aria-hidden="true">{answer === choice.id && <Check size={11} />}</i>
            <span>{choice.text}</span>
          </button>
        ))}
      </div>
      {answer !== null && answer !== 'skip' && (
        <label className="prediction-reason">
          <span>이유를 한 줄로 (선택)</span>
          <input value={reason} disabled={locked} onChange={(event) => onReason(event.target.value)} placeholder="예: 60 Hz는 저역 통과 차단 주파수보다 높다" />
        </label>
      )}
      <button type="button" className="prediction-skip" disabled={locked} aria-pressed={answer === 'skip'} onClick={() => onAnswer(answer === 'skip' ? null : 'skip')}>
        <SkipForward size={12} /> {answer === 'skip' ? '건너뛰기 취소' : '예측 없이 진행 (채점하지 않음)'}
      </button>
    </section>
  )
}

export function PredictionFeedback({ prediction, answer, reason, graded }: {
  prediction: GradedPrediction
  answer: PredictionAnswer
  reason: string
  /** false when the run's settings differ from the ones the question assumes. */
  graded: boolean
}) {
  const chosen = prediction.choices.find((choice) => choice.id === answer)
  const correctChoice = prediction.choices.find((choice) => choice.id === prediction.correct)
  const isCorrect = answer === prediction.correct
  const state = !graded || !chosen ? 'neutral' : isCorrect ? 'correct' : 'incorrect'
  return (
    <div className={`prediction-feedback ${state}`} role="status">
      <div className="prediction-feedback-heading">
        {state === 'correct' ? <CheckCircle2 size={16} /> : state === 'incorrect' ? <XCircle size={16} /> : <CircleHelp size={16} />}
        <strong>
          {!graded ? '이 실행은 채점하지 않았습니다' : !chosen ? '예측 없이 진행했습니다' : isCorrect ? '예측이 맞았습니다' : '예측과 다른 결과입니다'}
        </strong>
      </div>
      {!graded && <p>실행한 설정이 질문이 가정한 설정과 다릅니다. 실험 카드를 다시 눌러 설정을 맞춘 뒤 실행하면 채점됩니다.</p>}
      {graded && chosen && <p>내 예측: {chosen.text}{reason.trim() ? ` · 이유: ${reason.trim()}` : ''}</p>}
      {graded && <p><b>정답</b> {correctChoice?.text}</p>}
      {graded && <p>{prediction.explanation}</p>}
    </div>
  )
}

export interface TryThisItem {
  id: string
  title: string
  change: string
}

export function TryThisList({ items, activeId, completed, disabled, onSelect }: {
  items: TryThisItem[]
  activeId: string | null
  completed: string[]
  disabled: boolean
  onSelect: (id: string | null) => void
}) {
  const done = items.filter((item) => completed.includes(item.id)).length
  return (
    <section className="try-this" aria-labelledby="try-this-title">
      <div className="section-title">
        <span id="try-this-title"><FlaskConical size={13} /> 실험 과제(Try this)</span>
        <small>{done} / {items.length} 완료</small>
      </div>
      <p className="try-this-help">카드를 누르면 기본 설정에서 한 가지만 바뀝니다. 예측을 고른 뒤 EEG를 생성하고, 정답을 공개해 확인하세요.</p>
      <ol className="try-this-list">
        <li>
          <button type="button" className={activeId === null ? 'active' : ''} aria-pressed={activeId === null} disabled={disabled} onClick={() => onSelect(null)}>
            <i aria-hidden="true">0</i>
            <span><strong>기본 설정으로 시작</strong><small>표본화율 250 Hz · 1–40 Hz 필터</small></span>
          </button>
        </li>
        {items.map((item, index) => {
          const isDone = completed.includes(item.id)
          return (
            <li key={item.id}>
              <button type="button" className={`${activeId === item.id ? 'active' : ''} ${isDone ? 'done' : ''}`} aria-pressed={activeId === item.id} disabled={disabled} onClick={() => onSelect(item.id)}>
                <i aria-hidden="true">{isDone ? <Check size={11} /> : index + 1}</i>
                <span><strong>{item.title}</strong><small>{item.change}</small></span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export function LookHere({ children }: { children: string }) {
  return <p className="look-here" role="note"><Lightbulb size={14} aria-hidden="true" /><span><b>여기를 보세요</b> {children}</span></p>
}

/** P0-5: every method in the same four slots, so methods can be compared side by side. */
export function MethodCard({ card }: { card: MethodCardContent }) {
  return (
    <article className="method-card" aria-label={`${card.label} 기법 카드`}>
      <header><strong>{card.label}</strong><small>{card.family}</small></header>
      <dl>
        <div><dt>하는 일</dt><dd>{card.does}</dd></div>
        <div className="breaks"><dt>깨지는 곳</dt><dd>{card.breaks}</dd></div>
        <div><dt>쓸 때</dt><dd>{card.useFor}</dd></div>
        <div><dt>피할 때</dt><dd>{card.avoidFor}</dd></div>
      </dl>
    </article>
  )
}
