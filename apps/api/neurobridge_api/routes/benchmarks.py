"""``/benchmarks`` routes: JR factorial benchmark experiments (plan §5.4, §5.5).

Every route is a thin shell over :mod:`neurobridge.benchmarks.runner`, the same runner the CLI
uses. Jobs run in spawned worker processes (``inline=False``) that outlive the request; their
state lives in the SQLite job index under the storage root, never in API memory. Task targets
are produced by the planner only; request bodies are recipes and metric specs, never targets.

Storage root: ``$NEUROSIGNAL_BENCHMARK_ROOT`` if set, otherwise the parent of the real-data
projects directory (``.../NeuroSignal``), giving ``<root>/benchmarks/<experiment_id>/``.
"""

from __future__ import annotations

import math
import os
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query
from neurobridge.artifacts.store import (
    ArtifactIntegrityError,
    ArtifactNotFoundError,
    ArtifactStore,
    UnsafeIdError,
    validate_id,
)
from neurobridge.benchmarks import runner
from neurobridge.benchmarks.contracts import IN_SCOPE_METRIC_IDS, MetricSpec
from neurobridge.benchmarks.planner import BenchmarkRecipe, default_experiment_id
from neurobridge.benchmarks.presets import PRESETS
from neurobridge.benchmarks.tasks import read_json
from neurobridge.jobs.manager import ACTIVE_STATES, JobManager, JobNotFoundError
from neurobridge.metrics import registry as metric_registry
from neurobridge.real_data import default_project_root
from pydantic import BaseModel, Field

ROOT_ENV = "NEUROSIGNAL_BENCHMARK_ROOT"
MAX_WINDOW_SAMPLES = 16384
MAX_WINDOW_CHANNELS = 64

_LOCK = threading.Lock()
_RECOVERED: set[Path] = set()
_PROCESSES: dict[str, tuple[str, BaseProcess]] = {}  # job_id -> (experiment_id, process)


def benchmark_root() -> Path:
    configured = os.environ.get(ROOT_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    return default_project_root().parent.resolve()


def recover(root: Path | None = None) -> list[str]:
    """Mark jobs left queued/running by a previous server process as ``interrupted``."""
    root = root or benchmark_root()
    with _LOCK:
        recovered = JobManager(root).recover()
        _RECOVERED.add(root)
    return recovered


def _root() -> Path:
    """Storage root; recovers it once per process (mounted sub-apps skip lifespan events)."""
    root = benchmark_root()
    with _LOCK:
        if root not in _RECOVERED:
            JobManager(root).recover()
            _RECOVERED.add(root)
    return root


@asynccontextmanager
async def _lifespan(_app):
    recover()
    yield


router = APIRouter(prefix="/benchmarks", tags=["benchmarks"], lifespan=_lifespan)


# --------------------------------------------------------------------------- helpers


def _safe(value: str, what: str) -> str:
    try:
        return validate_id(value, what=what)
    except UnsafeIdError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _require_experiment(root: Path, experiment_id: str) -> Path:
    _safe(experiment_id, "experiment id")
    exp_dir = ArtifactStore(root).experiment_dir(experiment_id)
    if not (exp_dir / "_run" / "plan.json").is_file():
        raise HTTPException(status_code=404, detail=f"experiment {experiment_id!r} not found")
    return exp_dir


def _live_worker(experiment_id: str) -> str | None:
    """Job ID of a worker process started by this server that is still alive for the experiment."""
    with _LOCK:
        for job_id, (exp, proc) in list(_PROCESSES.items()):
            if proc.is_alive():  # also reaps exited children
                if exp == experiment_id:
                    return job_id
            else:
                proc.join(timeout=0)
    return None


def _track(handle: runner.RunHandle) -> None:
    if handle.process is not None:
        with _LOCK:
            _PROCESSES[handle.job_id] = (handle.experiment_id, handle.process)


def _worker_info(job_id: str) -> dict[str, Any] | None:
    with _LOCK:
        entry = _PROCESSES.get(job_id)
    if entry is None:
        return None
    proc = entry[1]
    alive = proc.is_alive()
    return {"pid": proc.pid, "alive": alive, "exitcode": None if alive else proc.exitcode}


def _job_payload(job) -> dict[str, Any]:
    return {**job.model_dump(mode="json"), "worker": _worker_info(job.job_id)}


def _handle_payload(handle: runner.RunHandle) -> dict[str, Any]:
    return {
        "experiment_id": handle.experiment_id,
        "job_id": handle.job_id,
        "job": _job_payload(handle.job),
        "cost": handle.plan.cost.model_dump(mode="json"),
        "warnings": handle.plan.warnings,
    }


def _guard_idle(root: Path, experiment_id: str) -> None:
    busy = _live_worker(experiment_id)
    if busy is not None:
        raise HTTPException(status_code=409, detail=f"job {busy} is still running")
    for job in JobManager(root).list(experiment_id, states=ACTIVE_STATES):
        raise HTTPException(status_code=409, detail=f"job {job.job_id} is still {job.state}")


def _finite(value: float) -> float | None:
    return value if math.isfinite(value) else None


# --------------------------------------------------------------------------- routes


@router.get("/capabilities")
def capabilities() -> dict[str, Any]:
    import neurobridge.metrics.connectivity  # noqa: F401  (registers adapters)
    import neurobridge.metrics.information  # noqa: F401

    metrics = metric_registry.capabilities()
    return {
        "metric_ids": list(IN_SCOPE_METRIC_IDS),
        "metrics": metrics,
        "dependency_groups": metric_registry.dependency_status(),
        "presets": [preset.to_dict() for preset in PRESETS.values()],
        "limits": {
            "max_window_samples": MAX_WINDOW_SAMPLES,
            "max_window_channels": MAX_WINDOW_CHANNELS,
        },
    }


@router.post("/validate")
def validate(recipe: BenchmarkRecipe) -> dict[str, Any]:
    report = runner.validate(recipe)
    return {"experiment_id": default_experiment_id(recipe), **report}


@router.post("/experiments", status_code=202)
def create_experiment(recipe: BenchmarkRecipe) -> dict[str, Any]:
    report = runner.validate(recipe)
    if not report["ok"]:
        raise HTTPException(
            status_code=422, detail={"errors": report["errors"], "warnings": report["warnings"]}
        )
    root = _root()
    experiment_id = default_experiment_id(recipe)
    _guard_idle(root, experiment_id)
    try:
        handle = runner.run_experiment(recipe, root, inline=False, experiment_id=experiment_id)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    _track(handle)
    return _handle_payload(handle)


@router.get("/experiments/{experiment_id}")
def get_experiment(experiment_id: str) -> dict[str, Any]:
    root = _root()
    exp_dir = _require_experiment(root, experiment_id)
    results = runner.collect_results(root, experiment_id)
    return {
        **results,
        "recipe": read_json(exp_dir / "_run" / "recipe.json"),
        "jobs": [job.model_dump(mode="json") for job in JobManager(root).list(experiment_id)],
        "artifacts": [
            m.model_dump(mode="json") for m in ArtifactStore(root).list_artifacts(experiment_id)
        ],
    }


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    _safe(job_id, "job id")
    try:
        job = JobManager(_root()).get(job_id)
    except JobNotFoundError as error:
        raise HTTPException(status_code=404, detail=f"job {job_id!r} not found") from error
    return _job_payload(job)


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, Any]:
    _safe(job_id, "job id")
    try:
        job = JobManager(_root()).request_cancel(job_id)
    except JobNotFoundError as error:
        raise HTTPException(status_code=404, detail=f"job {job_id!r} not found") from error
    return _job_payload(job)


@router.post("/experiments/{experiment_id}/resume", status_code=202)
def resume_experiment(experiment_id: str) -> dict[str, Any]:
    root = _root()
    _require_experiment(root, experiment_id)
    _guard_idle(root, experiment_id)
    try:
        handle = runner.resume_experiment(root, experiment_id, inline=False)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    _track(handle)
    return _handle_payload(handle)


class AnalysesRequest(BaseModel):
    metrics: list[MetricSpec] = Field(min_length=1)


@router.post("/experiments/{experiment_id}/analyses", status_code=202)
def rerun_analyses(experiment_id: str, request: AnalysesRequest) -> dict[str, Any]:
    root = _root()
    _require_experiment(root, experiment_id)
    _guard_idle(root, experiment_id)
    try:
        handle = runner.rerun_analyses(root, experiment_id, request.metrics, inline=False)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    _track(handle)
    return _handle_payload(handle)


@router.get("/artifacts/{artifact_id}/window")
def artifact_window(
    artifact_id: str,
    experiment_id: str,
    start: Annotated[int, Query(ge=0)] = 0,
    stop: Annotated[int | None, Query(ge=1)] = None,
    channels: Annotated[list[int] | None, Query()] = None,
) -> dict[str, Any]:
    """Bounded slice ``[channels, start:stop]`` of a 2-D (channel/node x time) artifact (mmap)."""
    root = _root()
    exp_dir = _require_experiment(root, experiment_id)
    _safe(artifact_id, "artifact id")
    try:
        stored = ArtifactStore(root).get(experiment_id, artifact_id, mmap=True)
    except ArtifactNotFoundError as error:
        raise HTTPException(
            status_code=404, detail=f"artifact {artifact_id!r} not found"
        ) from error
    except ArtifactIntegrityError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    manifest, array = stored.manifest, stored.array
    if array.ndim != 2 or (manifest.axes and manifest.axes[-1] != "time"):
        raise HTTPException(
            status_code=422,
            detail=f"artifact axes {manifest.axes or list(array.shape)} are not (channel, time)",
        )
    n_channels, n_samples = array.shape
    stop = n_samples if stop is None else stop
    if stop <= start or start >= n_samples:
        raise HTTPException(status_code=422, detail=f"empty window [{start}, {stop})")
    stop = min(stop, n_samples)
    if stop - start > MAX_WINDOW_SAMPLES:
        raise HTTPException(status_code=422, detail=f"window exceeds {MAX_WINDOW_SAMPLES} samples")
    picks = list(range(n_channels)) if not channels else channels
    if len(picks) > MAX_WINDOW_CHANNELS:
        raise HTTPException(
            status_code=422, detail=f"window exceeds {MAX_WINDOW_CHANNELS} channels"
        )
    if any(c < 0 or c >= n_channels for c in picks):
        raise HTTPException(status_code=422, detail=f"channel index out of range 0..{n_channels}")

    meta_path = exp_dir / "_run" / "meta" / f"{artifact_id}.json"
    meta = read_json(meta_path) if meta_path.is_file() else {}
    names = meta.get("channel_names") or meta.get("node_ids")
    sfreq = meta.get("fs") or runner.load_plan(root, experiment_id).sfreq
    window = array[picks, start:stop]
    return {
        "experiment_id": experiment_id,
        "artifact_id": artifact_id,
        "kind": manifest.kind,
        "units": manifest.units,
        "axes": manifest.axes,
        "shape": manifest.shape,
        "sfreq": sfreq,
        "start": start,
        "stop": stop,
        "channels": [
            {"index": c, "name": str(names[c]) if names and c < len(names) else None} for c in picks
        ],
        "data": [[_finite(float(v)) for v in row] for row in window.tolist()],
    }


@router.post("/experiments/{experiment_id}/exports", status_code=201)
def export_experiment(experiment_id: str) -> dict[str, Any]:
    root = _root()
    exp_dir = _require_experiment(root, experiment_id)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    export_id = f"export-{stamp}-{uuid.uuid4().hex[:8]}"
    out_dir = exp_dir / "_exports" / export_id
    files = runner.export_experiment(root, experiment_id, out_dir)
    return {
        "experiment_id": experiment_id,
        "export_id": export_id,
        "directory": str(out_dir),
        "files": {
            name: {"path": path, "bytes": Path(path).stat().st_size} for name, path in files.items()
        },
    }
