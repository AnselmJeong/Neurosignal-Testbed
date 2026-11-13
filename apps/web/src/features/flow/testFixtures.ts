// Test fixtures for the Information Flow lab. The JSON files are real API output, trimmed:
// - flow-concepts.sample.json: GET /flow/concepts (catalog_json() + method_concepts).
// - flow-result.sample.json: flow_result.json of run_flow_pipeline on the preview recipe shortened
//   to 20 s / 16 sensors / GC max order 8, rounded to 3 significant digits, with large arrays
//   (A_discrete, FC matrices, reversed GC, order matrices) dropped and example traces cut to 160 samples.
import conceptsJson from './fixtures/flow-concepts.sample.json'
import resultJson from './fixtures/flow-result.sample.json'
import type { ConceptCatalog, FlowJob, FlowResult, FlowRunStatus } from './types'

export const conceptsFixture = conceptsJson as unknown as ConceptCatalog

export function resultFixture(runId = 'flow-small-test'): FlowResult {
  const result = structuredClone(resultJson) as unknown as FlowResult
  result.run_id = runId
  return result
}

export function flowJobFixture(overrides: Partial<FlowJob> = {}): FlowJob {
  return {
    job_id: 'job-91cfa3304a9e4573a66f784fa7e6be93',
    experiment_id: 'flow-new',
    state: 'running',
    stage: 'simulate: TVB Jansen-Rit coupled + control',
    tasks: { total: 1, completed: 0, failed: 0, skipped: 0, reused: 0 },
    failures: [],
    cancel_requested: false,
    created_at: '2026-11-13T09:28:30.127412Z',
    updated_at: '2026-11-13T09:28:35.127412Z',
    worker: { pid: 37974, alive: true, exitcode: null },
    ...overrides,
  }
}

export function runStatusFixture(runId: string, job: FlowJob, result: FlowResult | null = null): FlowRunStatus {
  return {
    run_id: runId,
    state: job.state,
    stage: job.stage,
    job,
    meta: null,
    recipe: result?.recipe ?? null,
    has_result: result !== null,
    result,
  }
}

export const costFixture = {
  n_conditions: 2,
  n_datasets: 4,
  dataset_channels: [8, 32],
  simulated_seconds: 64,
  analysed_samples_per_dataset: 3584,
  analysis_sfreq: 128,
  estimated_wall_s: 46,
  estimate_basis: 'rough; calibrated on the preview recipe (~86 s) on one machine',
}
