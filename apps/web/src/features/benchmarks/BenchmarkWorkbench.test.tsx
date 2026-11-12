// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BENCHMARK_STORAGE_KEY, BenchmarkWorkbench } from './BenchmarkWorkbench'
import { capabilitiesFixture, jobFixture, resultsFixture } from './testFixtures'
import type { BenchmarkJob } from './types'

interface Reply { status?: number; body: unknown }
type Route = (method: string, path: string, body: unknown) => Reply | undefined

let calls: { method: string; path: string }[] = []

function mockApi(route: Route) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(input).replace(/^\/api/, '')
    calls.push({ method, path })
    const reply = route(method, path, init?.body ? JSON.parse(String(init.body)) : undefined)
      ?? { status: 404, body: { detail: `no mock for ${method} ${path}` } }
    const status = reply.status ?? 200
    return { ok: status < 400, status, json: async () => reply.body }
  }))
}

const count = (method: string, prefix: string) => calls.filter((c) => c.method === method && c.path.startsWith(prefix)).length

/** Base routes plus a scripted job sequence for one new experiment. */
function scenario({ jobs, completedResults, stored }: {
  jobs: BenchmarkJob[]
  completedResults?: ReturnType<typeof resultsFixture>
  stored?: ReturnType<typeof resultsFixture>
}) {
  let polls = 0
  mockApi((method, path) => {
    if (path === '/benchmarks/capabilities') return { body: capabilitiesFixture }
    if (method === 'POST' && path === '/benchmarks/validate') {
      return { body: { experiment_id: 'jr-new0000000000000', ok: true, errors: [], warnings: ['uncalibrated gain'], cost: resultsFixture('x').cost } }
    }
    if (method === 'POST' && path === '/benchmarks/experiments') {
      return { status: 202, body: { experiment_id: 'jr-new0000000000000', job_id: jobs[0]!.job_id, job: jobFixture({ state: 'queued', stage: null }), cost: resultsFixture('x').cost, warnings: [] } }
    }
    if (method === 'GET' && path.startsWith('/benchmarks/jobs/')) {
      const job = jobs[Math.min(polls, jobs.length - 1)]!
      polls += 1
      return { body: job }
    }
    if (method === 'GET' && path === '/benchmarks/experiments/jr-new0000000000000' && completedResults) return { body: completedResults }
    if (method === 'GET' && stored && path === `/benchmarks/experiments/${stored.experiment_id}`) return { body: stored }
    return undefined
  })
}

async function validateAndRun() {
  await waitFor(() => expect(screen.getByRole('radio', { name: /Q1/ })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: /설정 검증/ }))
  await screen.findByText(/검증 통과/)
  expect(screen.getByLabelText('예상 비용')).toHaveTextContent('85')
  fireEvent.click(screen.getByRole('button', { name: /생성·분석 실행/ }))
}

const renderLab = () => render(<BenchmarkWorkbench activeLab="benchmark" onLabChange={vi.fn()} pollIntervalMs={5} />)

beforeEach(() => window.localStorage.clear())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('BenchmarkWorkbench', () => {
  it('renders the designer with Q1 runnable, Q2–Q7 planned and the 29-ID catalog tab', async () => {
    scenario({ jobs: [jobFixture()] })
    renderLab()
    expect(screen.getByRole('heading', { name: /결합과 관측을/ })).toBeVisible()
    await waitFor(() => expect(screen.getByRole('radio', { name: /Q1/ })).toBeEnabled())
    for (const id of ['Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7']) {
      const radio = screen.getByRole('radio', { name: new RegExp(id) })
      expect(radio).toBeDisabled()
      expect(radio.closest('label')).toHaveTextContent('계획됨')
    }
    expect(screen.getByRole('checkbox', { name: /M14 · PLV/ })).toBeChecked()
    expect(screen.getByRole('button', { name: /생성·분석 실행/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: '지표 카탈로그' }))
    expect(screen.getAllByTestId(/^catalog-row-/)).toHaveLength(29)
  })

  it('sends the designed recipe, polls the real job until it settles, then shows results', async () => {
    const done = jobFixture({ state: 'completed', stage: 'evaluate', tasks: { total: 85, completed: 84, failed: 0, skipped: 0, reused: 1 }, worker: { pid: 11869, alive: false, exitcode: 0 } })
    scenario({
      jobs: [
        jobFixture({ stage: 'simulate' }),
        jobFixture({ stage: 'metric', tasks: { total: 85, completed: 40, failed: 0, skipped: 0, reused: 0 } }),
        done,
      ],
      completedResults: resultsFixture('jr-new0000000000000'),
    })
    renderLab()
    await validateAndRun()

    const validateBody = (vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body) as string
    const recipe = JSON.parse(validateBody)
    expect(recipe.conditions).toEqual({ A: { G: 0, observation: 'identity_probe' }, B: { G: 10, observation: 'identity_probe' }, C: { G: 0, observation: 'eeg_forward' }, D: { G: 10, observation: 'eeg_forward' } })
    expect(recipe.benchmark.metrics.map((m: { id: string }) => m.id)).toEqual(['M14', 'M17', 'M23'])
    expect(recipe).not.toHaveProperty('tasks')

    await waitFor(() => expect(screen.getByTestId('job-state')).toHaveTextContent('완료'))
    expect(screen.getByTestId('job-done')).toHaveTextContent('85 / 85')
    await screen.findByRole('article', { name: '조건 A' })
    const polls = count('GET', '/benchmarks/jobs/')
    expect(polls).toBe(3)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(count('GET', '/benchmarks/jobs/')).toBe(polls)
    expect(JSON.parse(window.localStorage.getItem(BENCHMARK_STORAGE_KEY) ?? '{}').displayed).toBe('jr-new0000000000000')
  })

  it('keeps the previous result visible when a new run fails, and offers resume', async () => {
    const previous = resultsFixture('jr-old0000000000000', 1)
    window.localStorage.setItem(BENCHMARK_STORAGE_KEY, JSON.stringify({ displayed: previous.experiment_id, active: null }))
    scenario({
      stored: previous,
      jobs: [
        jobFixture({ stage: 'simulate' }),
        jobFixture({ state: 'failed', stage: 'metric', tasks: { total: 85, completed: 20, failed: 1, skipped: 0, reused: 0 }, failures: [{ task_id: 'metric-x', reason_code: 'worker_crash', message: 'boom' }], worker: { pid: 1, alive: false, exitcode: 1 } }),
      ],
    })
    // StrictMode double-mounts effects as in `npm run dev`; the restored result must still show.
    render(<StrictMode><BenchmarkWorkbench activeLab="benchmark" onLabChange={vi.fn()} pollIntervalMs={5} /></StrictMode>)
    const before = await screen.findByTestId('cell-A-value')
    const shown = before.textContent
    expect(screen.getByText('jr-old0000000000000', { selector: '.canvas-status span' })).toBeVisible()

    // Loading the displayed result's settings clears the flag; editing sets it again.
    fireEvent.click(screen.getByRole('button', { name: '이 결과의 설정을 편집기로 불러오기' }))
    expect(screen.queryByTestId('edited-badge')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'seed 수' }), { target: { value: '4' } })
    expect(screen.getByTestId('edited-badge')).toBeVisible()

    await validateAndRun()
    await waitFor(() => expect(screen.getByTestId('job-state')).toHaveTextContent('실패'))
    const banner = await screen.findByText(/새 실행이 실패했습니다/)
    expect(banner.closest('[role="alert"]')).toHaveTextContent('이전에 완료된 결과를 그대로 표시합니다')
    expect(screen.getByTestId('cell-A-value').textContent).toBe(shown)
    expect(screen.getByText('jr-old0000000000000', { selector: '.canvas-status span' })).toBeVisible()
    expect(count('GET', '/benchmarks/experiments/jr-new')).toBe(0)
    const progress = screen.getByRole('region', { name: '실행 작업 진행' })
    expect(within(progress).getByText(/worker_crash/)).toBeInTheDocument()
    expect(within(progress).getByRole('button', { name: /이어서 실행/ })).toBeEnabled()
  })

  it('cancels a running job through the API', async () => {
    let cancelled = false
    mockApi((method, path) => {
      if (path === '/benchmarks/capabilities') return { body: capabilitiesFixture }
      if (path === '/benchmarks/validate') return { body: { experiment_id: 'jr-new0000000000000', ok: true, errors: [], warnings: [], cost: resultsFixture('x').cost } }
      if (method === 'POST' && path === '/benchmarks/experiments') return { status: 202, body: { experiment_id: 'jr-new0000000000000', job_id: jobFixture().job_id, job: jobFixture(), cost: resultsFixture('x').cost, warnings: [] } }
      if (method === 'POST' && path.endsWith('/cancel')) { cancelled = true; return { body: jobFixture({ cancel_requested: true }) } }
      if (method === 'GET' && path.startsWith('/benchmarks/jobs/')) {
        return { body: cancelled ? jobFixture({ state: 'cancelled', cancel_requested: true, worker: { pid: 1, alive: false, exitcode: 0 } }) : jobFixture() }
      }
      return undefined
    })
    renderLab()
    await validateAndRun()
    const cancel = await screen.findByRole('button', { name: /취소/ })
    fireEvent.click(cancel)
    await waitFor(() => expect(screen.getByTestId('job-state')).toHaveTextContent('취소됨'))
    expect(count('POST', '/benchmarks/jobs/')).toBe(1)
    expect(screen.getByRole('button', { name: /이어서 실행/ })).toBeEnabled()
  })

  it('shows schema errors from a 422 validation without enabling run', async () => {
    mockApi((_method, path) => {
      if (path === '/benchmarks/capabilities') return { body: capabilitiesFixture }
      if (path === '/benchmarks/validate') return { status: 422, body: { detail: [{ loc: ['body', 'benchmark', 'metrics', 0, 'id'], msg: "metric id 'M99' is not one of the 29 in-scope IDs" }] } }
      return undefined
    })
    renderLab()
    await waitFor(() => expect(screen.getByRole('radio', { name: /Q1/ })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /설정 검증/ }))
    expect(await screen.findByText(/benchmark\.metrics\.0\.id: metric id 'M99'/)).toBeVisible()
    expect(screen.getByRole('button', { name: /생성·분석 실행/ })).toBeDisabled()
  })
})
