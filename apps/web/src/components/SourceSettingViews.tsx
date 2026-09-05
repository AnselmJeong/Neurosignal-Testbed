import { useId } from 'react'
import type { ConnectivityRecipe } from '../types'

type PhaseSettings = Pick<ConnectivityRecipe, 'coupling_strength' | 'phase_lag_deg' | 'alpha_frequency_hz'>

export function phaseOffsetLabel(recipe: PhaseSettings): string {
  if (recipe.coupling_strength === 0) return 'No shared component · offset inactive'
  const degrees = recipe.phase_lag_deg
  const ms = (degrees / 360 / recipe.alpha_frequency_hz * 1000).toFixed(1)
  if (degrees === 0) return '0° · 0.0 ms · in phase'
  if (degrees === 180) return `180° · ${ms} ms · half a cycle apart`
  return `${degrees}° · ${ms} ms · shared FR leads FL`
}

/** Illustrative footprint, not a head-model projection or an anatomical radius. */
export function SourceFieldHalos({ points, spread }: { points: { x: number; y: number }[]; spread: number }) {
  const id = `source-field-${useId().replace(/:/g, '')}`
  const radius = 26 + 48 * Math.max(0, Math.min(1, spread))
  return <g className="source-field-halos" aria-label={`Configured field spread ${spread.toFixed(2)}; schematic mixing footprints`}>
    <defs><radialGradient id={id}>
      <stop offset="0%" stopColor="#377fa5" stopOpacity="0.42" />
      <stop offset="35%" stopColor="#377fa5" stopOpacity="0.27" />
      <stop offset="70%" stopColor="#377fa5" stopOpacity="0.10" />
      <stop offset="100%" stopColor="#377fa5" stopOpacity="0" />
    </radialGradient></defs>
    {points.map((point, index) => <circle className="source-field-halo" key={index} cx={point.x} cy={point.y} r={radius} fill={`url(#${id})`} />)}
  </g>
}

export function FieldSpreadCaption({ spread }: { spread: number }) {
  return <p className="conn-field-caption"><span className="conn-field-swatch" aria-hidden="true" /><span><strong>Field spread {spread.toFixed(2)}</strong> · wider fading discs = broader sensor mixing. Schematic footprints, not source size; 0 still has some mixing.</span></p>
}
