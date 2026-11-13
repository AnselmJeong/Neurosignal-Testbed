// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FLOW_STORAGE_KEY, FlowWorkbench } from './FlowWorkbench'
import { conceptsFixture, costFixture, flowJobFixture, resultFixture, runStatusFixture } from './testFixtures'
import type { FlowJob, FlowResult } from './types'

interface Reply { status?: number; body: unknown }
type Route = (method: string, path: string, body: unknown) => Reply | undefined

let calls: { method: string; path: string; body: unknown }[] = []

function mockApi(route: Route) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(input).replace(/^\/api/, '')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    const reply = route(method, path, body) ?? { status: 404, body: { detail: `no mock for ${method} ${path}` } }
    const status = reply.status ?? 200
    return { ok: status < 400, status, json: async () => reply.body }
  }))
}

const count = (method: string, prefix: string) => calls.filter((c) => c.method === method && c.path.startsWith(prefix)).length
const NEW_RUN = 'flow-new0000000-aaaaaa'

/** Base routes plus a scripted status sequence for one new run. */
function scenario({ jobs, completed, stored }: { jobs: FlowJob[]; completed?: FlowResult; stored?: FlowResult }) {
  let polls = 0
  mockApi((method, path) => {
    if (path === '/flow/concepts') return { body: conceptsFixture }
    if (method === 'GET' && path === '/flow/runs') return { body: { runs: [] } }
    if (method === 'POST' && path === '/flow/validate') return { body: { ok: true, errors: [], warnings: ['profile is preview'], cost: costFixture, recipe_sha256: 'abc' } }
    if (method === 'POST' && path === '/flow/runs') {
      return { status: 202, body: { run_id: NEW_RUN, job_id: jobs[0]!.job_id, job: flowJobFixture({ state: 'queued', stage: 'queued' }), cost: costFixture, warnings: [] } }
    }
    if (method === 'GET' && path === `/flow/runs/${NEW_RUN}?include_result=false`) {
      const job = jobs[Math.min(polls, jobs.length - 1)]!
      polls += 1
      return { body: runStatusFixture(NEW_RUN, job) }
    }
    if (method === 'GET' && path === `/flow/runs/${NEW_RUN}?include_result=true` && completed) {
      return { body: runStatusFixture(NEW_RUN, jobs[jobs.length - 1]!, completed) }
    }
    if (method === 'GET' && stored && path === `/flow/runs/${stored.run_id}?include_result=true`) {
      return { body: runStatusFixture(stored.run_id, flowJobFixture({ state: 'completed', stage: 'done', worker: { pid: 1, alive: false, exitcode: 0 } }), stored) }
    }
    return undefined
  })
}

async function validateAndRun() {
  fireEvent.click(screen.getByRole('button', { name: /설정 검증/ }))
  await screen.findByText('검증 통과')
  expect(screen.getByLabelText('예상 비용')).toHaveTextContent('약 46초')
  fireEvent.click(screen.getByRole('button', { name: /생성·분석 실행/ }))
}

const renderLab = () => render(<FlowWorkbench activeLab="flow" onLabChange={vi.fn()} pollIntervalMs={5} />)

beforeEach(() => window.localStorage.clear())
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('FlowWorkbench', () => {
  it('opens on the concept primer loaded from GET /flow/concepts', async () => {
    scenario({ jobs: [flowJobFixture()] })
    renderLab()
    expect(screen.getByRole('heading', { level: 1, name: /연결성은/ })).toBeVisible()
    expect(await screen.findByTestId('concept-row-information_flow')).toBeVisible()
    expect(screen.getByTestId('level-2')).toHaveTextContent('해당 없음')
    expect(screen.getByRole('button', { name: /생성·분석 실행/ })).toBeDisabled()
    expect(screen.getByRole('img', { name: '시뮬레이션 정답 소스 그래프' }).querySelectorAll('[data-edge]')).toHaveLength(7)
  })

  it('validates, runs, follows the real stages and then shows the method cards', async () => {
    const done = flowJobFixture({ state: 'completed', stage: 'done', tasks: { total: 1, completed: 1, failed: 0, skipped: 0, reused: 0 }, worker: { pid: 38759, alive: false, exitcode: 0 } })
    scenario({
      jobs: [
        flowJobFixture({ stage: 'simulate: TVB Jansen-Rit coupled + control' }),
        flowJobFixture({ stage: 'analyse source/control (8 channels)' }),
        done,
      ],
      completed: resultFixture(NEW_RUN),
    })
    renderLab()
    fireEvent.change(screen.getByRole('slider', { name: '결합 G' }), { target: { value: '12' } })
    await validateAndRun()

    const sent = calls.find((c) => c.method === 'POST' && c.path === '/flow/runs')!.body as { simulation: { G: number; control_G: number }; graph: { edges: unknown[] } }
    expect(sent.simulation.G).toBe(12)
    expect(sent.simulation.control_G).toBe(0)
    expect(sent).not.toHaveProperty('tasks')

    await waitFor(() => expect(screen.getByTestId('flow-job-state')).toHaveTextContent('완료'))
    expect(count('GET', `/flow/runs/${NEW_RUN}?include_result=false`)).toBe(3)
    await screen.findByText(/완료 · 새 결과를 표시합니다/)
    expect(count('GET', `/flow/runs/${NEW_RUN}?include_result=true`)).toBe(1)
    expect(JSON.parse(window.localStorage.getItem(FLOW_STORAGE_KEY) ?? '{}').displayed).toBe(NEW_RUN)

    fireEvent.click(screen.getByRole('tab', { name: '방법 카드' }))
    expect(screen.getAllByRole('article')).toHaveLength(6)
    expect(screen.getByTestId('gc-significant')).toHaveTextContent('19 / 56')
    fireEvent.click(within(screen.getByRole('group', { name: '분석 공간' })).getByRole('button', { name: /센서/ }))
    fireEvent.click(within(screen.getByRole('group', { name: '결합 조건' })).getByRole('button', { name: /G=0/ }))
    expect(screen.getByTestId('gc-significant')).toHaveTextContent('105 / 240')

    fireEvent.click(screen.getByRole('tab', { name: '센서 vs 소스' }))
    expect(screen.getByTestId('compare-headline')).toHaveTextContent('59%')
  })

  it('reports intermediate stages as progress', async () => {
    scenario({ jobs: [flowJobFixture({ stage: 'analyse sensor-none/coupled (32 channels)' })] })
    renderLab()
    await validateAndRun()
    await waitFor(() => expect(screen.getByTestId('flow-job-stage')).toHaveTextContent('분석 2/4'))
    expect(screen.getByRole('progressbar', { name: '파이프라인 진행' })).toHaveAttribute('aria-valuenow', '57')
  })

  it('keeps the previous result visible when a new run fails', async () => {
    const previous = resultFixture('flow-old0000000-bbbbbb')
    window.localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify({ displayed: previous.run_id, active: null }))
    scenario({
      stored: previous,
      jobs: [
        flowJobFixture({ stage: 'simulate: TVB Jansen-Rit coupled + control' }),
        flowJobFixture({ state: 'failed', stage: 'analyse source/coupled (8 channels)', tasks: { total: 1, completed: 0, failed: 1, skipped: 0, reused: 0 }, failures: [{ task_id: 'flow-pipeline', reason_code: 'pipeline_exception', message: 'LinAlgError: singular' }], worker: { pid: 2, alive: false, exitcode: 0 } }),
      ],
    })
    render(<StrictMode><FlowWorkbench activeLab="flow" onLabChange={vi.fn()} pollIntervalMs={5} /></StrictMode>)
    await screen.findByText(previous.run_id, { selector: '.canvas-status span' })
    fireEvent.click(screen.getByRole('tab', { name: '방법 카드' }))
    expect(screen.getByTestId('gc-significant')).toHaveTextContent('19 / 56')

    fireEvent.change(screen.getByRole('combobox', { name: '신호 길이' }), { target: { value: '20' } })
    expect(screen.getByTestId('flow-edited-badge')).toBeVisible()
    await validateAndRun()
    await waitFor(() => expect(screen.getByTestId('flow-job-state')).toHaveTextContent('실패'))
    const banner = await screen.findByText(/새 실행이 실패했습니다/)
    expect(banner.closest('[role="alert"]')).toHaveTextContent('pipeline_exception')
    expect(banner.closest('[role="alert"]')).toHaveTextContent('이전에 완료된 결과를 그대로 표시합니다')
    expect(within(screen.getByRole('region', { name: '정보 흐름 실행 진행' })).getByText(/LinAlgError: singular/)).toBeInTheDocument()
    expect(screen.getByText(previous.run_id, { selector: '.canvas-status span' })).toBeVisible()
    expect(screen.getByTestId('gc-significant')).toHaveTextContent('19 / 56')
    expect(count('GET', `/flow/runs/${NEW_RUN}?include_result=true`)).toBe(0)
  })

  it('cancels a running job through the API', async () => {
    let cancelled = false
    mockApi((method, path) => {
      if (path === '/flow/concepts') return { body: conceptsFixture }
      if (path === '/flow/runs' && method === 'GET') return { body: { runs: [] } }
      if (path === '/flow/validate') return { body: { ok: true, errors: [], warnings: [], cost: costFixture, recipe_sha256: 'abc' } }
      if (method === 'POST' && path === '/flow/runs') return { status: 202, body: { run_id: NEW_RUN, job_id: 'job-1', job: flowJobFixture(), cost: costFixture, warnings: [] } }
      if (method === 'POST' && path.endsWith('/cancel')) {
        cancelled = true
        return { body: { run_id: NEW_RUN, state: 'running', cancel_requested: true, active: true, job: flowJobFixture({ cancel_requested: true }) } }
      }
      if (method === 'GET' && path.startsWith(`/flow/runs/${NEW_RUN}`)) {
        const job = cancelled
          ? flowJobFixture({ state: 'cancelled', cancel_requested: true, failures: [{ task_id: 'flow-pipeline', reason_code: 'cancelled', message: 'cancelled before: analyse' }], worker: { pid: 1, alive: false, exitcode: 0 } })
          : flowJobFixture()
        return { body: runStatusFixture(NEW_RUN, job) }
      }
      return undefined
    })
    renderLab()
    await validateAndRun()
    fireEvent.click(await screen.findByRole('button', { name: /취소/ }))
    await waitFor(() => expect(screen.getByTestId('flow-job-state')).toHaveTextContent('취소됨'))
    expect(count('POST', `/flow/runs/${NEW_RUN}/cancel`)).toBe(1)
    expect(await screen.findByText(/새 실행이 취소되었습니다/)).toBeVisible()
  })

  it('shows schema errors from a 422 validation without enabling run', async () => {
    mockApi((_method, path) => {
      if (path === '/flow/concepts') return { body: conceptsFixture }
      if (path === '/flow/runs') return { body: { runs: [] } }
      if (path === '/flow/validate') return { status: 422, body: { detail: [{ loc: ['body'], msg: "Value error, analysis references unknown nodes: ['Z']" }] } }
      return undefined
    })
    renderLab()
    fireEvent.click(screen.getByRole('button', { name: /설정 검증/ }))
    expect(await screen.findByText(/analysis references unknown nodes/)).toBeVisible()
    expect(screen.getByRole('button', { name: /생성·분석 실행/ })).toBeDisabled()
  })
})
