import { LineChart } from './Charts'

export const REMOVED_COLOR = '#c7653c'

/** The third layer of the before/after/removed rule: what processing took out, always in rust. */
export function RemovedSignalStrip({ x, values, channelName }: { x: number[]; values: number[]; channelName: string }) {
  const peak = values.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  return (
    <div className="removed-strip">
      <div className="removed-strip-heading">
        <span><i aria-hidden="true" />제거된 것 = 처리 전 − 처리 후</span>
        <small>최대 {peak.toFixed(1)} µV</small>
      </div>
      <LineChart
        x={x}
        series={[{ label: `제거된 신호 · ${channelName}`, values, color: REMOVED_COLOR }]}
        xLabel="시간(s)"
        yLabel="µV"
        ariaLabel={`Signal removed from ${channelName} by processing`}
        height={120}
      />
    </div>
  )
}
