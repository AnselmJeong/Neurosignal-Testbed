"""``/flow`` routes: educational information-flow pipeline (concepts, validate, background runs).

Every route is a thin shell over :mod:`neurobridge.flow` (the same pipeline the CLI ``flow run``
uses). A run executes in a spawned worker process that outlives the request; its state lives in
the SQLite job index of the flow storage root (:class:`neurobridge.jobs.JobManager`), never in API
memory. Request bodies are :class:`FlowRecipe` documents only — the worker entry point is fixed in
code, so no task target string is ever taken from a user.

Storage root: ``<benchmark root>/flow`` where the benchmark root follows ``routes.benchmarks``
(``$NEUROSIGNAL_BENCHMARK_ROOT`` or the parent of the real-data projects directory). A run lives
in ``<root>/flow/benchmarks/<run_id>/`` (recipe in ``_run/``, ``flow_result.json`` and arrays from
the pipeline) and its job in ``<root>/flow/benchmarks/jobs.sqlite``.

Cancellation is cooperative: the worker checks the cancel flag at every pipeline progress step
(after simulation and before each dataset is analysed), so a cancel takes effect within one step.
"""

from __future__ import annotations

import json
import multiprocessing
import os
import threading
import uuid
from datetime import UTC, datetime
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from neurobridge.artifacts.store import ArtifactStore, UnsafeIdError, validate_id
from neurobridge.benchmarks.tasks import read_json, write_json_atomic
from neurobridge.flow import concepts as concepts_mod
from neurobridge.flow.pipeline import RESULT_FILENAME, FlowRecipe, payload_sha256
from neurobridge.jobs.manager import ACTIVE_STATES, JobManager, JobNotFoundError
from neurobridge.jobs.worker import WORKER_THREAD_ENV

from neurobridge_api.routes.benchmarks import benchmark_root

FLOW_SUBDIR = "flow"
MAX_DURATION_S = 300.0
MAX_SURROGATES = 199
MAX_ACTIVE_RUNS = 2

# Rough wall-time model calibrated on this machine: preview recipe (60 s, 8 sources, 32 sensors)
# ~86 s, 20 s / 16 sensors ~23 s, full recipe ~750 s. It is a planning hint, not a promise.
_SIM_S_PER_SIMULATED_S = 0.42
_ANALYSIS_S_PER_S_PER_UNIT = 0.018

_LOCK = threading.Lock()
_ENV_LOCK = threading.Lock()
_RECOVERED: set[Path] = set()
_PROCESSES: dict[str, tuple[str, BaseProcess]] = {}  # job_id -> (run_id, process)

router = APIRouter(prefix="/flow", tags=["flow"])


# --------------------------------------------------------------------------- storage helpers


def flow_root() -> Path:
    return benchmark_root() / FLOW_SUBDIR


def _root() -> Path:
    """Flow storage root; marks jobs orphaned by a previous server process ``interrupted`` once."""
    root = flow_root()
    with _LOCK:
        if root not in _RECOVERED:
            JobManager(root).recover()
            _RECOVERED.add(root)
    return root


def _safe(value: str, what: str) -> str:
    try:
        return validate_id(value, what=what)
    except UnsafeIdError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _run_dir(root: Path, run_id: str) -> Path:
    _safe(run_id, "run id")
    run_dir = ArtifactStore(root).experiment_dir(run_id)
    if not (run_dir / "_run" / "recipe.json").is_file():
        raise HTTPException(status_code=404, detail=f"flow run {run_id!r} not found")
    return run_dir


def _latest_job(root: Path, run_id: str):
    jobs = JobManager(root).list(run_id)
    return jobs[-1] if jobs else None


def _worker_info(job_id: str) -> dict[str, Any] | None:
    with _LOCK:
        entry = _PROCESSES.get(job_id)
    if entry is None:
        return None
    proc = entry[1]
    alive = proc.is_alive()
    return {"pid": proc.pid, "alive": alive, "exitcode": None if alive else proc.exitcode}


def _job_payload(job) -> dict[str, Any] | None:
    if job is None:
        return None
    return {**job.model_dump(mode="json"), "worker": _worker_info(job.job_id)}


def _live_workers() -> int:
    with _LOCK:
        alive = 0
        for job_id, (_run, proc) in list(_PROCESSES.items()):
            if proc.is_alive():
                alive += 1
            else:
                proc.join(timeout=0)
                _PROCESSES.pop(job_id, None)
        return alive


# --------------------------------------------------------------------------- validation / cost


def estimate_cost(recipe: FlowRecipe) -> dict[str, Any]:
    sim, obs, pre, methods = (
        recipe.simulation,
        recipe.observation,
        recipe.preprocessing,
        recipe.methods,
    )
    n_nodes = len(recipe.graph.nodes)
    views = ([n_nodes] if obs.include_source_native else []) + [obs.n_sensors] * len(obs.references)
    settle = pre.highpass_settle_s if pre.highpass_hz else 0.0
    analysed_s = max(sim.duration_s - settle, 0.0)
    sfreq = sim.output_fs / pre.decimate
    simulated_s = 2 * (sim.duration_s + sim.burn_in_s)
    units = 2 * sum(1.0 + (n / 8.0) ** 2 for n in views)
    multiplier = (2.0 if methods.gc.pairwise_order == "per_pair" else 1.0) * (
        1.0 + (methods.te.n_surrogates / 19.0 if methods.te.ksg else 0.0)
    )
    analysis_s = _ANALYSIS_S_PER_S_PER_UNIT * analysed_s * units * multiplier
    return {
        "n_conditions": 2,
        "n_datasets": 2 * len(views),
        "dataset_channels": views,
        "simulated_seconds": simulated_s,
        "analysed_samples_per_dataset": int(analysed_s * sfreq),
        "analysis_sfreq": sfreq,
        "estimated_wall_s": round(_SIM_S_PER_SIMULATED_S * simulated_s + analysis_s, 1),
        "estimate_basis": "rough; calibrated on the preview recipe (~86 s) on one machine",
    }


def validate_flow_recipe(recipe: FlowRecipe) -> dict[str, Any]:
    """Schema is already enforced by pydantic; this adds run limits and scientific warnings."""
    errors: list[str] = []
    warnings: list[str] = []
    sim, methods = recipe.simulation, recipe.methods
    cost = estimate_cost(recipe)
    if sim.duration_s > MAX_DURATION_S:
        errors.append(
            f"simulation.duration_s {sim.duration_s} exceeds the API limit {MAX_DURATION_S}"
        )
    if methods.te.n_surrogates > MAX_SURROGATES:
        errors.append(f"methods.te.n_surrogates exceeds the API limit {MAX_SURROGATES}")
    if cost["analysed_samples_per_dataset"] <= 0:
        errors.append("no samples remain after the high-pass settling time")
    if not recipe.graph.edges:
        warnings.append("graph has no edges: every directed estimate should be null-like")
    if recipe.profile == "full":
        warnings.append("profile 'full' is slow (the bundled full recipe takes ~12 min)")
    if methods.te.ksg and 0 < methods.te.n_surrogates < 19:
        warnings.append(
            "KSG surrogate test with < 19 surrogates cannot reach p < 0.05; "
            "use >= 499 surrogates if KSG significance matters"
        )
    n_obs = cost["analysed_samples_per_dataset"]
    for n_ch in sorted(set(cost["dataset_channels"])):
        params = n_ch * methods.gc.max_order + 1
        if n_obs < methods.gc.min_obs_per_param * params:
            warnings.append(
                f"{n_ch}-channel conditional GC at max_order {methods.gc.max_order}: "
                f"{n_obs} samples < {methods.gc.min_obs_per_param:g} x {params} parameters; "
                "the order search is capped and may report the method as ineligible"
            )
    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "cost": cost,
        "recipe_sha256": payload_sha256(recipe.model_dump(mode="json")),
    }


# --------------------------------------------------------------------------- worker process


class _Cancelled(Exception):
    pass


def _flow_worker(root: str, job_id: str, run_id: str, recipe_json: str) -> None:
    """Entry point of the spawned worker (fixed in code; never chosen by a request)."""
    os.environ.update(WORKER_THREAD_ENV)
    from neurobridge.flow.pipeline import run_flow_pipeline

    manager = JobManager(root)
    if manager.get(job_id).state == "cancelled":
        return
    manager.start(job_id, total_tasks=1)

    def progress(message: str) -> None:
        if manager.is_cancel_requested(job_id):
            raise _Cancelled(message)
        manager.update_stage(job_id, message[:200])

    try:
        run_flow_pipeline(json.loads(recipe_json), root, run_id=run_id, progress=progress)
    except _Cancelled as stop:
        manager.mark_task(
            job_id,
            "flow-pipeline",
            "skipped",
            reason_code="cancelled",
            message=f"cancelled before: {stop}",
        )
        manager.finish(job_id, "cancelled")
        return
    except Exception as exc:  # the pipeline itself broke; report it truthfully
        manager.mark_task(
            job_id,
            "flow-pipeline",
            "failed",
            reason_code="pipeline_exception",
            message=f"{type(exc).__name__}: {exc}",
        )
        manager.finish(job_id, "failed")
        return
    manager.mark_task(job_id, "flow-pipeline", "completed", artifact_id=None)
    manager.update_stage(job_id, "done")
    manager.finish(job_id)


def _start_worker(root: Path, job_id: str, run_id: str, recipe: FlowRecipe) -> BaseProcess:
    ctx = multiprocessing.get_context("spawn")
    proc = ctx.Process(
        target=_flow_worker,
        args=(str(root), job_id, run_id, recipe.model_dump_json()),
        name=f"neurobridge-flow-{job_id}",
        daemon=False,
    )
    with _ENV_LOCK:  # the child must start with the thread caps already in place
        saved = {k: os.environ.get(k) for k in WORKER_THREAD_ENV}
        os.environ.update(WORKER_THREAD_ENV)
        try:
            proc.start()
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    return proc


# --------------------------------------------------------------------------- routes


@router.get("/concepts")
def get_concepts() -> dict[str, Any]:
    return {
        **concepts_mod.catalog().model_dump(mode="json"),
        "method_concepts": dict(concepts_mod.METHOD_CONCEPTS),
    }


@router.get("/concepts/{concept_id}")
def get_concept(concept_id: str) -> dict[str, Any]:
    try:
        return concepts_mod.get_concept(concept_id).model_dump(mode="json")
    except KeyError as error:
        raise HTTPException(status_code=404, detail=f"concept {concept_id!r} not found") from error


@router.post("/validate")
def validate(recipe: FlowRecipe) -> dict[str, Any]:
    return validate_flow_recipe(recipe)


@router.post("/runs", status_code=202)
def create_run(recipe: FlowRecipe) -> dict[str, Any]:
    report = validate_flow_recipe(recipe)
    if not report["ok"]:
        raise HTTPException(
            status_code=422, detail={"errors": report["errors"], "warnings": report["warnings"]}
        )
    if _live_workers() >= MAX_ACTIVE_RUNS:
        raise HTTPException(
            status_code=409, detail=f"{MAX_ACTIVE_RUNS} flow runs are already running"
        )
    root = _root()
    run_id = f"flow-{report['recipe_sha256'][:10]}-{uuid.uuid4().hex[:6]}"
    run_dir = ArtifactStore(root).experiment_dir(run_id, create=True)
    write_json_atomic(run_dir / "_run" / "recipe.json", recipe.model_dump(mode="json"))
    write_json_atomic(
        run_dir / "_run" / "meta.json",
        {
            "run_id": run_id,
            "title": recipe.title,
            "profile": recipe.profile,
            "recipe_sha256": report["recipe_sha256"],
            "created_at": datetime.now(UTC).isoformat(),
            "cost": report["cost"],
        },
    )
    job = JobManager(root).create(run_id, total_tasks=1, stage="queued")
    proc = _start_worker(root, job.job_id, run_id, recipe)
    with _LOCK:
        _PROCESSES[job.job_id] = (run_id, proc)
    return {
        "run_id": run_id,
        "job_id": job.job_id,
        "job": _job_payload(job),
        "cost": report["cost"],
        "warnings": report["warnings"],
    }


@router.get("/runs")
def list_runs() -> dict[str, Any]:
    root = _root()
    latest: dict[str, Any] = {}
    for job in JobManager(root).list():
        latest[job.experiment_id] = job  # ordered by created_at: last one wins
    runs = []
    for run_id, job in latest.items():
        run_dir = ArtifactStore(root).experiment_dir(run_id)
        meta_path = run_dir / "_run" / "meta.json"
        if not meta_path.is_file():
            continue
        meta = read_json(meta_path)
        runs.append(
            {
                "run_id": run_id,
                "title": meta.get("title"),
                "profile": meta.get("profile"),
                "created_at": meta.get("created_at"),
                "job_id": job.job_id,
                "state": job.state,
                "stage": job.stage,
                "has_result": (run_dir / RESULT_FILENAME).is_file(),
            }
        )
    runs.sort(key=lambda r: r["created_at"] or "", reverse=True)
    return {"runs": runs}


@router.get("/runs/{run_id}")
def get_run(run_id: str, include_result: bool = True) -> dict[str, Any]:
    root = _root()
    run_dir = _run_dir(root, run_id)
    job = _latest_job(root, run_id)
    result_path = run_dir / RESULT_FILENAME
    done = job is not None and job.state == "completed" and result_path.is_file()
    meta_path = run_dir / "_run" / "meta.json"
    return {
        "run_id": run_id,
        "state": job.state if job is not None else "unknown",
        "stage": job.stage if job is not None else None,
        "job": _job_payload(job),
        "meta": read_json(meta_path) if meta_path.is_file() else None,
        "recipe": read_json(run_dir / "_run" / "recipe.json"),
        "has_result": result_path.is_file(),
        "result": read_json(result_path) if (done and include_result) else None,
    }


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str) -> dict[str, Any]:
    root = _root()
    _run_dir(root, run_id)
    job = _latest_job(root, run_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no job for flow run {run_id!r}")
    try:
        job = JobManager(root).request_cancel(job.job_id)
    except JobNotFoundError as error:  # pragma: no cover - index raced away
        raise HTTPException(status_code=404, detail=str(error)) from error
    return {
        "run_id": run_id,
        "state": job.state,
        "cancel_requested": job.cancel_requested,
        "active": job.state in ACTIVE_STATES,
        "job": _job_payload(job),
    }
