import type {
  ConnectivityRecipe,
  ConnectivitySimulation,
  ConnectivityResult,
  ExperimentRecipe,
  ExperimentResult,
  IcaApplyResult,
  IcaFitResult,
  IcaRecipe,
  IcaSimulationResult,
  SourceModelRecipe,
  SourceModelResult,
  SourceModelSimulation,
  EegbciLessonStatus,
  EegbciImportRequest,
  LocalImportRequest,
  RealDataImportResult,
  RecordingInspection,
  ReportExportResult,
  RealDataQeegRequest,
  RealDataQeegResult,
} from '../types'

const apiBase = import.meta.env.VITE_API_URL ?? '/api'

export async function checkHealth(signal?: AbortSignal): Promise<boolean> {
  const response = await fetch(`${apiBase}/health`, signal ? { signal } : {})
  if (!response.ok) throw new Error('The local analysis service is not ready.')
  return true
}

export async function runRecipe(recipe: ExperimentRecipe): Promise<ExperimentResult> {
  const response = await fetch(`${apiBase}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(recipe),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null
    const detail = typeof payload?.detail === 'string' ? payload.detail : 'Check the frequency settings and try again.'
    throw new Error(detail)
  }
  return response.json() as Promise<ExperimentResult>
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null
    const message = typeof payload?.detail === 'string' ? payload.detail : 'The scientific pipeline stopped safely.'
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export function fitIca(recipe: IcaRecipe): Promise<IcaFitResult> {
  return postJson<IcaFitResult>('/ica/fit', recipe)
}

export function simulateIca(recipe: IcaRecipe): Promise<IcaSimulationResult> {
  return postJson<IcaSimulationResult>('/ica/simulate', recipe)
}

export function applyIca(
  recipe: IcaRecipe,
  fit: IcaFitResult,
  excludedComponents: number[],
): Promise<IcaApplyResult> {
  return postJson<IcaApplyResult>('/ica/apply', {
    recipe,
    excluded_components: excludedComponents,
    compatibility_fingerprint: fit.compatibility.fingerprint,
    target_reference: recipe.reference,
    target_channel_names: fit.compatibility.channel_names,
  })
}

export function simulateConnectivity(recipe: ConnectivityRecipe): Promise<ConnectivitySimulation> {
  return postJson<ConnectivitySimulation>('/connectivity/simulate', recipe)
}

export function runConnectivity(recipe: ConnectivityRecipe): Promise<ConnectivityResult> {
  return postJson<ConnectivityResult>('/connectivity/runs', recipe)
}

export function runSourceModel(recipe: SourceModelRecipe): Promise<SourceModelResult> {
  return postJson<SourceModelResult>('/source-modeling/runs', recipe)
}

export function simulateSourceModel(recipe: SourceModelRecipe): Promise<SourceModelSimulation> {
  return postJson<SourceModelSimulation>('/source-modeling/simulate', recipe)
}

export function inspectRealData(request: LocalImportRequest): Promise<RecordingInspection> {
  return postJson<RecordingInspection>('/real-data/inspect', request)
}

export function importRealData(request: LocalImportRequest): Promise<RealDataImportResult> {
  return postJson<RealDataImportResult>('/real-data/imports', request)
}

export async function getEegbciLessonStatus(): Promise<EegbciLessonStatus> {
  const response = await fetch(`${apiBase}/real-data/eegbci/status`)
  if (!response.ok) throw new Error('Could not inspect the local EEGBCI cache.')
  return response.json() as Promise<EegbciLessonStatus>
}

export function importCachedEegbci(request: EegbciImportRequest): Promise<RealDataImportResult> {
  return postJson<RealDataImportResult>('/real-data/eegbci/import', request)
}

export function exportQcReport(projectId: string): Promise<ReportExportResult> {
  return postJson<ReportExportResult>(`/reports?project_id=${encodeURIComponent(projectId)}`, {})
}

export function runRealDataQeeg(
  projectId: string,
  request: RealDataQeegRequest,
): Promise<RealDataQeegResult> {
  return postJson<RealDataQeegResult>(
    `/real-data/projects/${encodeURIComponent(projectId)}/qeeg`,
    request,
  )
}

export function reportDownloadUrl(path: string): string {
  return `${apiBase}${path}`
}
