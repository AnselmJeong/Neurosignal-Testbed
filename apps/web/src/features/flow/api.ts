import type {
  ConceptCatalog,
  FlowCancelResponse,
  FlowRecipe,
  FlowRunHandle,
  FlowRunStatus,
  FlowRunSummary,
  FlowValidationReport,
} from './types'

// Same base-URL convention as lib/api.ts and the benchmark lab.
const apiBase = import.meta.env.VITE_API_URL ?? '/api'

/** API failure with every message the server returned (pydantic 422 list, {errors}, or a string). */
export class FlowApiError extends Error {
  readonly status: number
  readonly messages: string[]
  readonly warnings: string[]

  constructor(status: number, messages: string[], warnings: string[] = []) {
    super(messages.join(' · ') || `요청이 실패했습니다 (HTTP ${status}).`)
    this.name = 'FlowApiError'
    this.status = status
    this.messages = messages
    this.warnings = warnings
  }
}

function detailMessages(detail: unknown): { messages: string[]; warnings: string[] } {
  if (typeof detail === 'string') return { messages: [detail], warnings: [] }
  if (Array.isArray(detail)) {
    return {
      messages: detail.map((item) => {
        if (item && typeof item === 'object' && 'msg' in item) {
          const { msg, loc } = item as { msg: unknown; loc?: unknown }
          const where = Array.isArray(loc) ? loc.filter((part) => part !== 'body').join('.') : ''
          return where ? `${where}: ${String(msg)}` : String(msg)
        }
        return String(item)
      }),
      warnings: [],
    }
  }
  if (detail && typeof detail === 'object') {
    const { errors, warnings } = detail as { errors?: unknown; warnings?: unknown }
    return {
      messages: Array.isArray(errors) ? errors.map(String) : [JSON.stringify(detail)],
      warnings: Array.isArray(warnings) ? warnings.map(String) : [],
    }
  }
  return { messages: [], warnings: [] }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${apiBase}${path}`, init)
  } catch {
    throw new FlowApiError(0, ['로컬 분석 서비스에 연결할 수 없습니다.'])
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null
    const { messages, warnings } = detailMessages(payload?.detail)
    throw new FlowApiError(response.status, messages, warnings)
  }
  return response.json() as Promise<T>
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  })
}

const seg = (value: string) => encodeURIComponent(value)

export function getFlowConcepts(): Promise<ConceptCatalog> {
  return request<ConceptCatalog>('/flow/concepts')
}

export function validateFlow(recipe: FlowRecipe): Promise<FlowValidationReport> {
  return post<FlowValidationReport>('/flow/validate', recipe)
}

export function createFlowRun(recipe: FlowRecipe): Promise<FlowRunHandle> {
  return post<FlowRunHandle>('/flow/runs', recipe)
}

export function listFlowRuns(): Promise<{ runs: FlowRunSummary[] }> {
  return request<{ runs: FlowRunSummary[] }>('/flow/runs')
}

/** Poll with includeResult=false (the full result is ~0.5 MB); fetch the result once it completes. */
export function getFlowRun(runId: string, includeResult = true): Promise<FlowRunStatus> {
  return request<FlowRunStatus>(`/flow/runs/${seg(runId)}?include_result=${includeResult ? 'true' : 'false'}`)
}

export function cancelFlowRun(runId: string): Promise<FlowCancelResponse> {
  return post<FlowCancelResponse>(`/flow/runs/${seg(runId)}/cancel`)
}
