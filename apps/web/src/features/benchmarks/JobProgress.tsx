import { CircleStop, RotateCw } from 'lucide-react'

import { isTerminal, jobActive } from './model'
import type { BenchmarkJob, JobState } from './types'

const STATE_LABELS: Record<JobState, string> = {
  queued: '대기 중',
  running: '실행 중',
  completed: '완료',
  failed: '실패',
  cancelled: '취소됨',
  interrupted: '중단됨 (서버 재시작)',
}

const STAGE_LABELS: Record<string, string> = {
  simulate: 'JR 신호 생성',
  observe: '관측 연산',
  epoch: '구간 분할',
  epochs: '구간 분할',
  spectral: '스펙트럼 계산',
  metric: '지표 계산',
  metrics: '지표 계산',
  compare: 'seed paired 비교',
  evaluate: 'truth 기반 평가',
}

export const stageLabel = (stage: string | null) => (stage ? STAGE_LABELS[stage] ?? stage : '시작 전')

export function JobProgress({ job, busy, pollError, onCancel, onResume, onRefresh }: {
  job: BenchmarkJob
  busy: boolean
  pollError: string | null
  onCancel: () => void
  onResume: () => void
  onRefresh: () => void
}) {
  const { tasks } = job
  const done = tasks.completed + tasks.reused + tasks.failed + tasks.skipped
  const percent = tasks.total > 0 ? Math.round((done / tasks.total) * 100) : 0
  const active = jobActive(job)
  const resumable = job.state === 'cancelled' || job.state === 'failed' || job.state === 'interrupted'

  return (
    <section className={`jrb-job ${job.state}`} aria-label="실행 작업 진행" aria-live="polite">
      <div className="jrb-job-head">
        <span className="eyebrow">작업 {job.job_id.slice(-8)}</span>
        <strong data-testid="job-state">{STATE_LABELS[job.state] ?? job.state}</strong>
      </div>
      <p className="jrb-job-stage">현재 단계 · <b>{stageLabel(job.stage)}</b></p>
      <div className="progress-track" role="progressbar" aria-label="완료된 task 비율" aria-valuemin={0} aria-valuemax={tasks.total} aria-valuenow={done}>
        <i style={{ width: `${percent}%` }} />
      </div>
      <dl className="jrb-job-counts">
        <div><dt>완료</dt><dd data-testid="job-done">{done} / {tasks.total}</dd></div>
        <div><dt>새로 계산</dt><dd>{tasks.completed}</dd></div>
        <div><dt>재사용</dt><dd>{tasks.reused}</dd></div>
        <div><dt>실패</dt><dd>{tasks.failed}</dd></div>
        <div><dt>건너뜀</dt><dd>{tasks.skipped}</dd></div>
      </dl>
      {job.cancel_requested && active && <p className="jrb-note">취소 요청됨 · 진행 중인 task가 끝나는 checkpoint에서 멈춥니다.</p>}
      {job.worker && <p className="jrb-muted">worker pid {job.worker.pid ?? '—'} · {job.worker.alive ? '실행 중' : `종료 (exit ${job.worker.exitcode ?? '—'})`}</p>}
      {job.worker === null && !isTerminal(job.state) && <p className="jrb-muted">다른 서버 프로세스가 시작한 작업입니다. 상태는 작업 색인에서 읽습니다.</p>}
      {job.failures.length > 0 && (
        <details className="jrb-failures" open={job.state === 'failed'}>
          <summary>실패한 task {job.failures.length}개</summary>
          <ul>
            {job.failures.map((failure) => (
              <li key={failure.task_id}><code>{failure.task_id}</code> · {failure.reason_code ?? '이유 코드 없음'}{failure.message ? ` — ${failure.message}` : ''}</li>
            ))}
          </ul>
        </details>
      )}
      {pollError && <p className="jrb-error" role="alert">상태 확인 실패: {pollError}</p>}
      <div className="jrb-job-actions">
        {active && <button type="button" onClick={onCancel} disabled={busy || job.cancel_requested}><CircleStop size={14} /> 취소</button>}
        {resumable && <button type="button" onClick={onResume} disabled={busy}><RotateCw size={14} /> 이어서 실행</button>}
        {pollError && <button type="button" onClick={onRefresh} disabled={busy}>상태 다시 확인</button>}
      </div>
    </section>
  )
}
