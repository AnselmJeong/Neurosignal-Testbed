import type { TraceDataSource, TraceMetadata, TraceSeries, TraceWindowRequest } from '@neurosignal/trace-viewer'
import { validateTraceWindow } from '@neurosignal/trace-viewer/testing'

const apiBase = import.meta.env.VITE_API_URL ?? '/api'

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid trace response.')
  return value as Record<string, unknown>
}

function numericArray(value: unknown, allowGaps: boolean): number[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => (
    (allowGaps && item === null) || (typeof item === 'number' && Number.isFinite(item))
  ))) throw new Error('Invalid trace sample array.')
  return value.map((item: number | null) => item === null ? Number.NaN : item)
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  const response = await fetch(url, signal ? { signal } : {})
  const body: unknown = await response.json()
  if (!response.ok) {
    const detail = record(body).detail
    throw new Error(typeof detail === 'string' ? detail : 'The working-copy trace could not be loaded.')
  }
  signal?.throwIfAborted()
  return body
}

function validateAnnotations(value: unknown): TraceMetadata['annotations'] {
  if (!Array.isArray(value)) throw new Error('Invalid trace annotations.')
  return value.map((item: unknown) => {
    const annotation = record(item)
    if (typeof annotation.id !== 'string' || typeof annotation.label !== 'string'
      || typeof annotation.startTimeS !== 'number' || !Number.isFinite(annotation.startTimeS)
      || typeof annotation.durationS !== 'number' || !Number.isFinite(annotation.durationS) || annotation.durationS < 0
      || (annotation.kind !== 'event' && annotation.kind !== 'annotation' && annotation.kind !== 'bad-segment')) {
      throw new Error('Invalid trace annotation.')
    }
    return { id: annotation.id, label: annotation.label, startTimeS: annotation.startTimeS,
      durationS: annotation.durationS, kind: annotation.kind }
  })
}

/** Consumer-owned HTTP transport. All signal values retain their declared SI units. */
export class RealDataTraceSource implements TraceDataSource {
  readonly id: string
  private readonly base: string

  constructor(projectId: string) {
    this.id = projectId
    this.base = `${apiBase}/real-data/projects/${encodeURIComponent(projectId)}`
  }

  async getMetadata(signal?: AbortSignal): Promise<TraceMetadata> {
    const body = record(await getJson(`${this.base}/trace-metadata`, signal))
    if (body.sourceId !== this.id || typeof body.revision !== 'string'
      || typeof body.samplingRateHz !== 'number' || !Number.isFinite(body.samplingRateHz) || body.samplingRateHz <= 0
      || typeof body.durationS !== 'number' || !Number.isFinite(body.durationS) || body.durationS <= 0
      || body.startTimeS !== 0 || !Array.isArray(body.channels)) throw new Error('Invalid working-copy metadata.')
    const channels = body.channels.map((value: unknown): TraceMetadata['channels'][number] => {
      const channel = record(value)
      if (typeof channel.id !== 'string' || typeof channel.label !== 'string'
        || typeof channel.unit !== 'string' || typeof channel.bad !== 'boolean') throw new Error('Invalid channel metadata.')
      const type = channel.type
      if (type !== 'eeg' && type !== 'eog' && type !== 'ecg' && type !== 'emg' && type !== 'stim'
        && type !== 'misc' && type !== 'source' && type !== 'unknown') throw new Error('Invalid channel type.')
      return { id: channel.id, label: channel.label, type, unit: channel.unit, bad: channel.bad }
    })
    if (new Set(channels.map(({ id }) => id)).size !== channels.length) throw new Error('Duplicate channel IDs.')
    return { sourceId: this.id, revision: body.revision, title: 'Imported FIF working copy', startTimeS: 0, durationS: body.durationS,
      samplingRateHz: body.samplingRateHz, channels, annotations: validateAnnotations(body.annotations),
      capabilities: { canMarkBadChannels: false, canEditAnnotations: false } }
  }

  async getWindow(request: TraceWindowRequest, signal?: AbortSignal) {
    const params = new URLSearchParams({ source_revision: request.sourceRevision,
      start_s: String(request.startTimeS), duration_s: String(request.durationS),
      pixel_width: String(Math.min(2400, request.pixelWidth)), representation: request.preferredRepresentation })
    request.channelIds.forEach((id) => params.append('channels', id))
    const body = record(await getJson(`${this.base}/trace-window?${params}`, signal))
    const channels = new Map<string, TraceSeries>()
    for (const [id, value] of Object.entries(record(body.channels))) {
      const series = record(value)
      if (series.representation === 'points') {
        channels.set(id, { representation: 'points', timesS: Float64Array.from(numericArray(series.timesS, false)),
          values: Float32Array.from(numericArray(series.values, true)) })
      } else if (series.representation === 'min-max') {
        channels.set(id, { representation: 'min-max', bucketStartTimesS: Float64Array.from(numericArray(series.bucketStartTimesS, false)),
          minimum: Float32Array.from(numericArray(series.minimum, true)), maximum: Float32Array.from(numericArray(series.maximum, true)) })
      } else throw new Error('Unknown trace representation.')
    }
    if (typeof body.sourceId !== 'string' || typeof body.sourceRevision !== 'string'
      || typeof body.startTimeS !== 'number' || typeof body.endTimeS !== 'number') throw new Error('Invalid trace window.')
    const window = { sourceId: body.sourceId, sourceRevision: body.sourceRevision,
      startTimeS: body.startTimeS, endTimeS: body.endTimeS, channels,
      annotations: validateAnnotations(body.annotations) }
    validateTraceWindow(this.id, request, window)
    return window
  }
}
