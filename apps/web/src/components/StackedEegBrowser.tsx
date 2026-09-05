import { useMemo } from 'react'
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

// Keep transport adaptation here; EEG-Tracer owns rendering, navigation and gain.
export function StackedEegBrowser({ x, series, ariaLabel, unit = 'µV', channelType }: StackedEegBrowserProps) {
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

export function StackedEegComparison({ x, series, channelNames, ariaLabel, beforeLabel = 'Before · generated EEG', afterLabel = 'After · cleaned EEG' }: StackedEegComparisonProps) {
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
