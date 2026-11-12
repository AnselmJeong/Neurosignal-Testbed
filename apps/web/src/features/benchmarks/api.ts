import type {
  BenchmarkCapabilities,
  BenchmarkJob,
  BenchmarkRecipe,
  ExperimentResults,
  RunHandle,
  ValidationReport,
} from './types'

// Same base-URL convention as lib/api.ts: Vite proxies /api to the local service,
// remote.py mounts the FastAPI app under /api.
const apiBase = import.meta.env.VITE_API_URL ?? '/api'

/** API failure with every message the server returned (pydantic 422 lists, {errors}, or a string). */
export class BenchmarkApiError extends Error {
  readonly status: number
  readonly messages: string[]
  readonly warnings: string[]

  constructor(status: number, messages: string[], warnings: string[] = []) {
    super(messages.join(' · ') || `요청이 실패했습니다 (HTTP ${status}).`)
    this.name = 'BenchmarkApiError'
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
    throw new BenchmarkApiError(0, ['로컬 분석 서비스에 연결할 수 없습니다.'])
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null
    const { messages, warnings } = detailMessages(payload?.detail)
    throw new BenchmarkApiError(response.status, messages, warnings)
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

export function getBenchmarkCapabilities(): Promise<BenchmarkCapabilities> {
  return request<BenchmarkCapabilities>('/benchmarks/capabilities')
}

export function validateBenchmark(recipe: BenchmarkRecipe): Promise<ValidationReport> {
  return post<ValidationReport>('/benchmarks/validate', recipe)
}

export function createBenchmarkExperiment(recipe: BenchmarkRecipe): Promise<RunHandle> {
  return post<RunHandle>('/benchmarks/experiments', recipe)
}

export function getBenchmarkJob(jobId: string): Promise<BenchmarkJob> {
  return request<BenchmarkJob>(`/benchmarks/jobs/${seg(jobId)}`)
}

export function cancelBenchmarkJob(jobId: string): Promise<BenchmarkJob> {
  return post<BenchmarkJob>(`/benchmarks/jobs/${seg(jobId)}/cancel`)
}

export function resumeBenchmarkExperiment(experimentId: string): Promise<RunHandle> {
  return post<RunHandle>(`/benchmarks/experiments/${seg(experimentId)}/resume`)
}

export function getBenchmarkExperiment(experimentId: string): Promise<ExperimentResults> {
  return request<ExperimentResults>(`/benchmarks/experiments/${seg(experimentId)}`)
}
