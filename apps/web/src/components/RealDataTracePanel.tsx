import { useMemo, useState } from 'react'
import { TraceViewer } from '@neurosignal/trace-viewer'
import '@neurosignal/trace-viewer/styles.css'

import { RealDataTraceSource } from '../lib/RealDataTraceSource'

export function RealDataTracePanel({ projectId }: { projectId: string }) {
  const [refresh, setRefresh] = useState(0)
  const layers = useMemo(() => [{ id: 'working-copy', label: 'FIF working copy',
    source: new RealDataTraceSource(projectId) }], [projectId, refresh])
  return <section className="real-data-trace-panel" aria-label="Working-copy trace review">
    <div className="section-title"><span>Signal review</span>
      <button className="quiet-button" onClick={() => setRefresh((value) => value + 1)}>Refresh traces</button>
    </div>
    <TraceViewer key={`${projectId}:${refresh}`} ariaLabel="Imported FIF EEG traces" layers={layers}
      defaultViewport={{ durationS: 10, visibleChannelCount: 8 }} readOnly />
  </section>
}
