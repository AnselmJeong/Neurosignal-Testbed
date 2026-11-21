// The Lab 01 teaching loop, made reusable: pick a one-change experiment card, predict, run,
// reveal, and get graded only when the run used the card's settings.
import { useEffect, useRef, useState } from 'react'

import type { PredictionAnswer } from '../components/LessonPanels'
import type { GradedPrediction } from './samplingLesson'

export interface LabExperiment<R> {
  id: string
  title: string
  /** One line naming the single setting that changes, e.g. "λ² 0.111 → 10". */
  change: string
  apply: (recipe: R) => R
  prediction: GradedPrediction
  lookAt: string
  learn: string
}

export interface RevealedPrediction<R> {
  prediction: GradedPrediction
  answer: PredictionAnswer
  reason: string
  graded: boolean
  experiment: LabExperiment<R> | null
}

const sortedJson = (value: unknown): string => JSON.stringify(value, (_, item: unknown) => (
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : item
))

export function useGradedLesson<R>({ storageKey, experiments, baseline, defaultRecipe }: {
  storageKey: string
  experiments: LabExperiment<R>[]
  baseline: GradedPrediction
  defaultRecipe: R
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [answer, setAnswer] = useState<PredictionAnswer>(null)
  const [reason, setReason] = useState('')
  const [lockedIn, setLockedInState] = useState<{ experimentId: string | null; answer: PredictionAnswer; reason: string; recipe: R } | null>(null)
  // A ref as well, so reveal() works when called right after lockIn() in the same async handler.
  const lockedRef = useRef<typeof lockedIn>(null)
  const setLockedIn = (value: typeof lockedIn) => { lockedRef.current = value; setLockedInState(value) }
  const [revealed, setRevealed] = useState<RevealedPrediction<R> | null>(null)
  const [completed, setCompleted] = useState<string[]>(() => {
    try { return JSON.parse(window.localStorage.getItem(storageKey) ?? '[]') as string[] } catch { return [] }
  })

  useEffect(() => { window.localStorage.setItem(storageKey, JSON.stringify(completed)) }, [storageKey, completed])

  const active = experiments.find((item) => item.id === activeId) ?? null
  const recipeFor = (id: string | null): R => {
    const experiment = experiments.find((item) => item.id === id) ?? null
    const base = structuredClone(defaultRecipe)
    return experiment ? experiment.apply(base) : base
  }
  const matches = (recipe: R, id: string | null) => sortedJson(recipe) === sortedJson(recipeFor(id))

  /** Switch card; returns the recipe the caller should load. */
  function select(id: string | null): R {
    setActiveId(id)
    setAnswer(null)
    setReason('')
    setLockedIn(null)
    setRevealed(null)
    return recipeFor(id)
  }

  /** Call when the run that will be graded starts. */
  function lockIn(recipe: R) {
    setLockedIn({ experimentId: activeId, answer, reason, recipe: structuredClone(recipe) })
    setRevealed(null)
  }

  /** Call when the learner reveals the truth for the locked-in run. */
  function reveal() {
    const lockedIn = lockedRef.current
    if (!lockedIn) return
    const experiment = experiments.find((item) => item.id === lockedIn.experimentId) ?? null
    const graded = matches(lockedIn.recipe, lockedIn.experimentId)
    setRevealed({ prediction: experiment?.prediction ?? baseline, answer: lockedIn.answer, reason: lockedIn.reason, graded, experiment: graded ? experiment : null })
    if (graded && experiment) setCompleted((items) => items.includes(experiment.id) ? items : [...items, experiment.id])
    setAnswer(null)
    setReason('')
  }

  return {
    active, activeId, prediction: active?.prediction ?? baseline,
    answer, setAnswer, reason, setReason, ready: answer !== null,
    completed, lockedIn, revealed, select, lockIn, reveal, matches,
    /** True when the current settings are exactly what the active card asks for. */
    onCard: (recipe: R) => matches(recipe, activeId),
  }
}
