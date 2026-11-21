// P1-5: a scoreboard whose ranking depends on what the learner cares about.
// Each criterion maps a raw value to "goodness" in [0, 1]; the weighted mean of the
// available goodness values is the score. Missing values are skipped, never treated as 0.

export interface ScoreCriterion {
  id: string
  label: string
  /** One line on what the column measures and why someone would care. */
  hint: string
}

export interface ScoreCell {
  /** Text shown in the table, already formatted. */
  display: string
  /** 0 = worst, 1 = best. null = not computed for this method. */
  goodness: number | null
  /** Raw value for the scatter plot. */
  raw?: number | null
}

export interface ScoreRow {
  id: string
  label: string
  cells: Record<string, ScoreCell>
}

export interface WeightPreset {
  id: string
  label: string
  weights: Record<string, number>
}

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

export function weightedScore(row: ScoreRow, weights: Record<string, number>): number | null {
  let total = 0
  let weightSum = 0
  for (const [id, weight] of Object.entries(weights)) {
    const goodness = row.cells[id]?.goodness
    if (!weight || goodness === null || goodness === undefined) continue
    total += weight * goodness
    weightSum += weight
  }
  return weightSum > 0 ? total / weightSum : null
}

/** Weighted criteria this method could not be scored on. */
export function missingCriteria(row: ScoreRow, weights: Record<string, number>): string[] {
  return Object.entries(weights)
    .filter(([id, weight]) => weight > 0 && (row.cells[id]?.goodness === null || row.cells[id]?.goodness === undefined))
    .map(([id]) => id)
}

/**
 * Rows scored on every weighted criterion come first. A method that skipped the column you
 * care most about must not win by default, so incomplete rows rank below complete ones.
 */
export function rankRows(rows: ScoreRow[], weights: Record<string, number>) {
  return rows
    .map((row) => ({ row, score: weightedScore(row, weights), missing: missingCriteria(row, weights) }))
    .sort((a, b) => (Number(a.missing.length > 0) - Number(b.missing.length > 0)) || ((b.score ?? -1) - (a.score ?? -1)))
}

/** Which method wins under each preset: the lesson is that the winner changes. */
export function presetWinners(rows: ScoreRow[], presets: WeightPreset[]): Record<string, string | null> {
  return Object.fromEntries(presets.map((preset) => [preset.id, rankRows(rows, preset.weights)[0]?.row.id ?? null]))
}

/** Relative speed on a log scale: fastest method = 1, slowest = 0. */
export function speedGoodness(seconds: (number | null | undefined)[]): (number | null)[] {
  const valid = seconds.filter((value): value is number => typeof value === 'number' && value > 0)
  if (valid.length < 2) return seconds.map((value) => (typeof value === 'number' ? 1 : null))
  const lo = Math.log10(Math.min(...valid))
  const hi = Math.log10(Math.max(...valid))
  return seconds.map((value) => (typeof value === 'number' && value > 0 ? (hi > lo ? 1 - (Math.log10(value) - lo) / (hi - lo) : 1) : null))
}
