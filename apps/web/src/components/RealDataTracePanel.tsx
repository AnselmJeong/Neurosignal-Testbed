import { useMemo, useState } from 'react'
import { TraceViewer } from '@neurosignal/trace-viewer'
import '@neurosignal/trace-viewer/styles.css'

import { RealDataTraceSource } from '../lib/RealDataTraceSource'

export function RealDataTracePanel({ projectId }: { projectId: string }) {
  const [refresh, setRefresh] = useState(0)
  const layers = useMemo(() => [{ id: 'working-copy', label: 'FIF 작업 사본',
    source: new RealDataTraceSource(projectId) }], [projectId, refresh])
  return <section className="real-data-trace-panel" aria-label="작업 사본 신호 검토">
    <div className="section-title"><span>신호 검토</span>
      <button className="quiet-button" onClick={() => setRefresh((value) => value + 1)}>신호 새로고침</button>
    </div>
    <TraceViewer key={`${projectId}:${refresh}`} ariaLabel="가져온 FIF EEG 신호" layers={layers}
      defaultViewport={{ durationS: 10, visibleChannelCount: 8 }} readOnly />
  </section>
}
