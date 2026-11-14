import { useMemo, useRef } from 'react'
import { TraceViewer, createArrayTraceSource } from '@neurosignal/trace-viewer'
import '@neurosignal/trace-viewer/styles.css'

interface StackedEegBrowserProps {
  x: number[]
  series: Record<string, number[]>
  ariaLabel: string
  unit?: string
  channelType?: 'eeg' | 'source'
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

// Keep transport adaptation here; EEG-Tracer owns rendering, navigation and gain.
export function StackedEegBrowser({ x, series: seriesProp, ariaLabel, unit = 'µV', channelType }: StackedEegBrowserProps) {
  const series = useShallowStable(seriesProp)
  const layers = useMemo(() => [{
    id: 'signal',
    label: unit === 'µV' ? 'EEG' : unit === 'a.u.' ? 'Simulated signal' : 'ICA activation',
    source: createArrayTraceSource({
      sourceId: 'simulation', title: ariaLabel, timesS: x, series, unit,
      channels: Object.keys(series).map((id) => ({
        id, label: id, type: channelType ?? (unit === 'µV' ? 'eeg' as const : 'source' as const), unit, bad: false,
      })),
    }),
  }], [x, series, unit, ariaLabel, channelType])

  return <TraceViewer className="eeg-tracer-browser" ariaLabel={ariaLabel} layers={layers}
    defaultViewport={{ startTimeS: x[0] ?? 0, durationS: 10, visibleChannelCount: 8 }} readOnly />
}

export function StackedEegComparison({ x, series: seriesProp, channelNames: channelNamesProp, ariaLabel, beforeLabel = 'Before · generated EEG', afterLabel = 'After · cleaned EEG' }: StackedEegComparisonProps) {
  const series = useShallowStable(seriesProp)
  const channelNames = useShallowStable(channelNamesProp)
  const layers = useMemo(() => [
    { id: 'before', label: beforeLabel, prefix: 'Before', color: '#c7653c', lineStyle: 'dashed' as const },
    { id: 'after', label: afterLabel, prefix: 'After', color: '#087f83', lineStyle: 'solid' as const },
  ].map(({ prefix, ...layer }) => ({
    ...layer,
    source: createArrayTraceSource({
      sourceId: layer.id, title: ariaLabel, timesS: x, unit: 'µV',
      series: Object.fromEntries(channelNames.map((channel) => [channel, series[`${prefix} · ${channel}`] ?? []])),
    }),
  })), [x, series, channelNames, ariaLabel, beforeLabel, afterLabel])

  return <TraceViewer className="eeg-tracer-browser" ariaLabel={ariaLabel} layers={layers}
    defaultViewport={{ startTimeS: x[0] ?? 0, durationS: 10, visibleChannelCount: 8 }} readOnly />
}
