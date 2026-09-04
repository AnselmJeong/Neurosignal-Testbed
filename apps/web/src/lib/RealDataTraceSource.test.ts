import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkTraceDataSource } from '@neurosignal/trace-viewer/testing'
import { RealDataTraceSource } from './RealDataTraceSource'

const source = new RealDataTraceSource('real_123456789abc')
const request = { sourceRevision: 'revision-1', startTimeS: 0, durationS: 1,
  channelIds: ['ch-1', 'ch-0'], pixelWidth: 100, preferredRepresentation: 'auto' as const }
const metadata = { sourceId: source.id, revision: 'revision-1', startTimeS: 0, durationS: 2,
  samplingRateHz: 2, annotations: [], capabilities: { canMarkBadChannels: true, canEditAnnotations: true },
  channels: [0, 1].map((i) => ({ id: `ch-${i}`, label: `EEG ${i}`, type: 'eeg', unit: 'V', bad: false })) }
const window = { sourceId: source.id, sourceRevision: 'revision-1', startTimeS: 0, endTimeS: 1,
  annotations: [], channels: {
    'ch-1': { representation: 'points', timesS: [0, 0.5], values: [1e-5, null] },
    'ch-0': { representation: 'min-max', bucketStartTimesS: [0, 0.5], minimum: [-1e-5, null], maximum: [2e-5, null] },
  } }

afterEach(() => vi.unstubAllGlobals())

describe('RealDataTraceSource', () => {
  it('passes the packaged contract harness and restores gaps without converting SI values', async () => {
    const fetcher = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('trace-metadata') ? metadata : window))))
    vi.stubGlobal('fetch', fetcher)
    await checkTraceDataSource(source, [request])
    const result = await source.getWindow(request)
    const points = result.channels.get('ch-1')!
    expect(points.representation).toBe('points')
    if (points.representation === 'points') {
      expect(points.values[0]).toBeCloseTo(1e-5, 10)
      expect(Number.isNaN(points.values[1])).toBe(true)
    }
    const url = new URL(fetcher.mock.calls[1]![0], 'http://localhost')
    expect(url.searchParams.getAll('channels')).toEqual(['ch-1', 'ch-0'])
    expect((await source.getMetadata()).capabilities.canEditAnnotations).toBe(false)
  })

  it('rejects malformed arrays and surfaces revision conflicts', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ...window, channels: {
      ...window.channels, 'ch-1': { representation: 'points', timesS: [0, 0.5], values: [1] },
    } })))))
    await expect(source.getWindow(request)).rejects.toThrow('typed arrays')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ detail: 'Working copy changed; refresh trace metadata' }), { status: 409 }))))
    await expect(source.getWindow(request)).rejects.toThrow('refresh trace metadata')
  })

  it('does not fetch when the request is already aborted', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    controller.abort()
    await expect(source.getWindow(request, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
