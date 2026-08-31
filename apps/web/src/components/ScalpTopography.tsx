const POSITIONS = [
  { name: 'Fp1', x: 35, y: 22 },
  { name: 'Fp2', x: 65, y: 22 },
  { name: 'F7', x: 18, y: 39 },
  { name: 'F8', x: 82, y: 39 },
  { name: 'C3', x: 34, y: 55 },
  { name: 'C4', x: 66, y: 55 },
  { name: 'O1', x: 38, y: 80 },
  { name: 'O2', x: 62, y: 80 },
]

function color(value: number): string {
  const amount = Math.min(1, Math.abs(value))
  return value >= 0
    ? `rgba(8, 127, 131, ${0.18 + amount * 0.82})`
    : `rgba(199, 101, 60, ${0.18 + amount * 0.82})`
}

export function ScalpTopography({ values, label }: { values: number[]; label: string }) {
  return (
    <svg className="scalp-map" viewBox="0 0 100 108" role="img" aria-label={`${label} scalp topography`}>
      <path d="M50 8 C26 8 13 27 13 54 C13 82 28 99 50 99 C72 99 87 82 87 54 C87 27 74 8 50 8Z" fill="#f4f4ef" stroke="#adb1aa" />
      <path d="M43 10 L50 2 L57 10" fill="none" stroke="#adb1aa" />
      <path d="M13 42 C5 43 5 61 13 64 M87 42 C95 43 95 61 87 64" fill="none" stroke="#adb1aa" />
      {POSITIONS.map((position, index) => (
        <g key={position.name}>
          <circle cx={position.x} cy={position.y} r={8.5} fill={color(values[index] ?? 0)} stroke="rgba(32,35,33,.18)" />
          <text x={position.x} y={position.y + 2.3} textAnchor="middle" className="scalp-label">{position.name}</text>
        </g>
      ))}
    </svg>
  )
}
