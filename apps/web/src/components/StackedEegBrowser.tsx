import { useMemo, useRef, useState, type ReactNode } from 'react'
import { TraceViewer, createArrayTraceSource, type TraceCursor, type TraceViewport } from '@neurosignal/trace-viewer'
import '@neurosignal/trace-viewer/styles.css'

import { MeasurementLens, type LensTrace, type LensView } from './MeasurementLens'

interface StackedEegBrowserProps {
  x: number[]
  series: Record<string, number[]>
  ariaLabel: string
  unit?: string
  channelType?: 'eeg' | 'source'
  /** The measurement lens (P1-6). Off for small strips where there is no room for it. */
  lens?: boolean
}

interface StackedEegComparisonProps extends StackedEegBrowserProps {
  channelNames: string[]
  beforeLabel?: string
  afterLabel?: string
}

// Callers often pass freshly built objects (`series={{ ... }}`, `channelNames={[name]}`) on every
// render. Reuse the previous one while its entries are unchanged; otherwise each parent render
// would build a new trace source and reset the viewer's zoom, position and gain.
function useShallowStable<T extends object>(value: T): T {
  const previous = useRef(value)
  const before = previous.current as Record<string, unknown>
  const after = value as Record<string, unknown>
  const keys = Object.keys(after)
  if (before !== after && (keys.length !== Object.keys(before).length || keys.some((key) => before[key] !== after[key]))) {
    previous.current = value
  }
  return previous.current
}

const DEFAULT_DURATION_S = 10
const DEFAULT_VISIBLE = 8

/** Cursor and viewport state shared by both wrappers, plus the lens laid over the viewer. */
function useMeasurement(x: number[], channelIds: string[], seriesFor: (channel: string) => number[][]) {
  const [cursor, setCursor] = useState<TraceCursor | null>(null)
  const [viewport, setViewport] = useState<TraceViewport | null>(null)
  const view = useMemo<LensView>(() => {
    const start = viewport?.startTimeS ?? x[0] ?? 0
    const duration = viewport?.durationS ?? DEFAULT_DURATION_S
    const offset = viewport?.channelOffset ?? 0
    const count = viewport?.visibleChannelCount ?? DEFAULT_VISIBLE
    let visibleMax = 0
    let i0 = x.findIndex((value) => value >= start)
    if (i0 < 0) i0 = 0
    for (const channel of channelIds.slice(offset, offset + count)) {
      for (const values of seriesFor(channel)) {
        for (let i = i0; i < x.length && x[i]! <= start + duration; i += 1) {
          const value = Math.abs(values[i] ?? 0)
          if (Number.isFinite(value) && value > visibleMax) visibleMax = value
        }
      }
    }
    const gains = Object.values(viewport?.gainByType ?? {})
    return { startTimeS: start, durationS: duration, visibleMax, gain: gains[0] ?? 1 }
  }, [viewport, x, channelIds, seriesFor])
  return { cursor, setCursor, setViewport, view, clear: () => setCursor(null) }
}

function LensHost({ children, lens }: { children: ReactNode; lens: ReactNode }) {
  return <div className="measure-host">{children}{lens}</div>
}

// Keep transport adaptation here; EEG-Tracer owns rendering, navigation and gain.
export function StackedEegBrowser({ x, series: seriesProp, ariaLabel, unit = 'µV', channelType, lens = true }: StackedEegBrowserProps) {
  const series = useShallowStable(seriesProp)
  const channelIds = useMemo(() => Object.keys(series), [series])
  const seriesFor = useMemo(() => (channel: string) => [series[channel] ?? []], [series])
  const measure = useMeasurement(x, channelIds, seriesFor)
  const channel = measure.cursor?.channelId ?? null
  const traces = useMemo<LensTrace[]>(() => channel ? [{ id: 'signal', label: channel, values: series[channel] ?? [], color: '#087f83' }] : [], [channel, series])
  const layers = useMemo(() => [{
    id: 'signal',
    label: unit === 'µV' ? 'EEG' : unit === 'a.u.' ? '시뮬레이션 신호' : 'ICA 활성도',
    source: createArrayTraceSource({
      sourceId: 'simulation', title: ariaLabel, timesS: x, series, unit,
      channels: Object.keys(series).map((id) => ({
        id, label: id, type: channelType ?? (unit === 'µV' ? 'eeg' as const : 'source' as const), unit, bad: false,
      })),
    }),
  }], [x, series, unit, ariaLabel, channelType])

  const viewer = <TraceViewer className="eeg-tracer-browser" ariaLabel={ariaLabel} layers={layers}
    defaultViewport={{ startTimeS: x[0] ?? 0, durationS: DEFAULT_DURATION_S, visibleChannelCount: DEFAULT_VISIBLE }} readOnly
    onCursorChange={lens ? measure.setCursor : undefined} onViewportChange={lens ? measure.setViewport : undefined} />
  if (!lens) return viewer
  return <LensHost lens={<MeasurementLens key={`${channel}-${measure.cursor?.timeS}`} x={x} channel={channel} timeS={measure.cursor?.timeS ?? null} traces={traces} unit={unit} view={measure.view} onClose={measure.clear} />}>{viewer}</LensHost>
}

export function StackedEegComparison({ x, series: seriesProp, channelNames: channelNamesProp, ariaLabel, beforeLabel = '처리 전 · 생성한 EEG', afterLabel = '처리 후 · 정리한 EEG' }: StackedEegComparisonProps) {
  const series = useShallowStable(seriesProp)
  const channelNames = useShallowStable(channelNamesProp)
  const seriesFor = useMemo(() => (channel: string) => [series[`Before · ${channel}`] ?? [], series[`After · ${channel}`] ?? []], [series])
  const measure = useMeasurement(x, channelNames, seriesFor)
  const channel = measure.cursor?.channelId ?? null
  const traces = useMemo<LensTrace[]>(() => channel ? [
    { id: 'before', label: beforeLabel, values: series[`Before · ${channel}`] ?? [], color: '#9a9d97', dashed: true },
    { id: 'after', label: afterLabel, values: series[`After · ${channel}`] ?? [], color: '#087f83' },
  ] : [], [channel, series, beforeLabel, afterLabel])
  const layers = useMemo(() => [
    // Colour rule shared by every lab: faint grey = before, teal = after, rust = removed.
    { id: 'before', label: beforeLabel, prefix: 'Before', color: '#9a9d97', lineStyle: 'dashed' as const },
    { id: 'after', label: afterLabel, prefix: 'After', color: '#087f83', lineStyle: 'solid' as const },
  ].map(({ prefix, ...layer }) => ({
    ...layer,
    source: createArrayTraceSource({
      sourceId: layer.id, title: ariaLabel, timesS: x, unit: 'µV',
      series: Object.fromEntries(channelNames.map((channel) => [channel, series[`${prefix} · ${channel}`] ?? []])),
    }),
  })), [x, series, channelNames, ariaLabel, beforeLabel, afterLabel])

  return <LensHost lens={<MeasurementLens key={`${channel}-${measure.cursor?.timeS}`} x={x} channel={channel} timeS={measure.cursor?.timeS ?? null} traces={traces} unit="µV" view={measure.view} removed onClose={measure.clear} />}>
    <TraceViewer className="eeg-tracer-browser" ariaLabel={ariaLabel} layers={layers}
      defaultViewport={{ startTimeS: x[0] ?? 0, durationS: DEFAULT_DURATION_S, visibleChannelCount: DEFAULT_VISIBLE }} readOnly
      onCursorChange={measure.setCursor} onViewportChange={measure.setViewport} />
  </LensHost>
}
