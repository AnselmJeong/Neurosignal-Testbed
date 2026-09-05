import { useEffect, useRef } from 'react'

// A positive, normalized IDW interpolation; colors never exceed the sensor extrema.
export function interpolateScalp(x: number, y: number, positions: [number, number][], values: number[]) {
  let sum = 0; let weights = 0
  positions.forEach(([px, py], i) => {
    const weight = 1 / Math.max(1e-8, ((x - px) ** 2 + (y - py) ** 2) ** 2)
    sum += weight * values[i]!; weights += weight
  })
  return sum / weights
}
function color(t: number, divergent: boolean): [number, number, number] {
  const stops = divergent ? [[44, 88, 163], [245, 244, 234], [188, 54, 49]]
    : [[42, 49, 143], [30, 163, 199], [76, 201, 112], [246, 219, 63], [200, 47, 37]]
  const value = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(value)); const fraction = value - index
  return stops[index]!.map((v, k) => Math.round(v + fraction * (stops[index + 1]![k]! - v))) as [number, number, number]
}
export function QeegTopomap({ positions, names, values, low = 0, high, label, divergent = false, labels = false }: {
  positions: [number, number][]; names: string[]; values: number[]; low?: number; high: number
  label: string; divergent?: boolean; labels?: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = ref.current?.getContext('2d'); if (!ctx) return
    const n = 160; const pixels = ctx.createImageData(n, n)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = (i - 80) / 70; const y = (80 - j) / 70
      if (x * x + y * y > 1) continue
      const value = interpolateScalp(x, y, positions, values)
      const rgb = color(high > low ? (value - low) / (high - low) : .5, divergent)
      const offset = (j * n + i) * 4
      pixels.data.set([...rgb, 255], offset)
    }
    ctx.putImageData(pixels, 0, 0)
  }, [positions, values, low, high, divergent])
  return <div className="ql-map" role="img" aria-label={label}>
    <canvas ref={ref} width={160} height={160} aria-hidden="true" />
    <svg viewBox="0 0 160 160" aria-hidden="true"><circle cx="80" cy="80" r="70" fill="none" stroke="#354b4a" strokeWidth="1" /><path d="M72 10 L80 2 L88 10 M10 60 Q0 80 10 100 M150 60 Q160 80 150 100" fill="none" stroke="#354b4a" />{positions.map(([x, y], i) => <g key={names[i]}><circle cx={80 + x * 70} cy={80 - y * 70} r="1.5" fill="#233c3c" /><title>{names[i]}: {values[i]!.toFixed(3)}</title>{labels && <text x={80 + x * 70} y={76 - y * 70} textAnchor="middle" fontSize="7" fill="#132e32" stroke="#fff" strokeWidth="1.5" paintOrder="stroke">{names[i]}</text>}</g>)}</svg>
  </div>
}
