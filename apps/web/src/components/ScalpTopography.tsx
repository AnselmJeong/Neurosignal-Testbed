// Electrode positions on a flat head drawing (viewBox 100 × 108, nose at the top).
const POSITIONS: Record<string, { x: number; y: number }> = {
  Fp1: { x: 39, y: 18 }, Fp2: { x: 61, y: 18 },
  F7: { x: 20, y: 34 }, F3: { x: 35, y: 37 }, Fz: { x: 50, y: 37 }, F4: { x: 65, y: 37 }, F8: { x: 80, y: 34 },
  T7: { x: 16, y: 55 }, C3: { x: 33, y: 55 }, Cz: { x: 50, y: 55 }, C4: { x: 67, y: 55 }, T8: { x: 84, y: 55 },
  P7: { x: 20, y: 76 }, P3: { x: 35, y: 73 }, Pz: { x: 50, y: 73 }, P4: { x: 65, y: 73 }, P8: { x: 80, y: 76 },
  O1: { x: 39, y: 91 }, O2: { x: 61, y: 91 },
}

// The original eight-channel lesson keeps its roomier layout.
const EIGHT_CHANNEL_POSITIONS: Record<string, { x: number; y: number }> = {
  Fp1: { x: 35, y: 22 }, Fp2: { x: 65, y: 22 },
  F7: { x: 18, y: 39 }, F8: { x: 82, y: 39 },
  C3: { x: 34, y: 55 }, C4: { x: 66, y: 55 },
  O1: { x: 38, y: 80 }, O2: { x: 62, y: 80 },
}

export const EIGHT_CHANNELS = ['Fp1', 'Fp2', 'F7', 'F8', 'C3', 'C4', 'O1', 'O2']

function color(value: number): string {
  const amount = Math.min(1, Math.abs(value))
  return value >= 0
    ? `rgba(8, 127, 131, ${0.18 + amount * 0.82})`
    : `rgba(199, 101, 60, ${0.18 + amount * 0.82})`
}

export function ScalpTopography({ values, label, channelNames = EIGHT_CHANNELS, compact = false }: {
  values: number[]
  label: string
  channelNames?: string[]
  /** Small thumbnail without electrode names, for a grid of components. */
  compact?: boolean
}) {
  const dense = channelNames.length > 8
  const layout = dense ? POSITIONS : EIGHT_CHANNEL_POSITIONS
  const radius = dense ? 6.4 : 8.5
  return (
    <svg className={compact ? 'scalp-map compact' : 'scalp-map'} viewBox="0 0 100 108" role="img" aria-label={`${label} 두피 지형도`}>
      <path d="M50 8 C26 8 13 27 13 54 C13 82 28 99 50 99 C72 99 87 82 87 54 C87 27 74 8 50 8Z" fill="#f4f4ef" stroke="#adb1aa" />
      <path d="M43 10 L50 2 L57 10" fill="none" stroke="#adb1aa" />
      <path d="M13 42 C5 43 5 61 13 64 M87 42 C95 43 95 61 87 64" fill="none" stroke="#adb1aa" />
      {channelNames.map((name, index) => {
        const position = layout[name] ?? POSITIONS[name]
        if (!position) return null
        return (
          <g key={name}>
            <circle cx={position.x} cy={position.y} r={compact ? radius + 1 : radius} fill={color(values[index] ?? 0)} stroke="rgba(32,35,33,.18)" />
            {!compact && <text x={position.x} y={position.y + 2} textAnchor="middle" className={dense ? 'scalp-label dense' : 'scalp-label'}>{name}</text>}
          </g>
        )
      })}
    </svg>
  )
}
