"""Benchmark job worker: runs task descriptors inline or in a spawned process.

A task is a JSON-serializable :class:`TaskSpec` — ``task_id``, a ``"module:function"`` target,
a ``params`` dict, input artifact IDs and the output artifact ID. Nothing is pickled: the spawned
process receives the store root, job ID and the task list as JSON, imports each target by name and
calls it as ``fn(params, inputs)`` where ``inputs`` maps input artifact ID -> checksum-verified
read-only array. The function returns an array or a :class:`TaskOutput`; the worker commits it
atomically to the :class:`ArtifactStore`.

Per task, in order:

1. cooperative cancel check (``JobManager.is_cancel_requested``) — stop before the task; artifacts
   already committed stay, the job ends ``cancelled``;
2. resume: an output artifact that exists with a valid checksum is counted ``reused``; a corrupt
   one is recomputed, never reused;
3. a missing/invalid input (e.g. its producing task failed) -> ``skipped`` with
   ``dependency_unavailable``;
4. an exception -> ``failed`` with ``task_exception``; remaining independent tasks continue.

Targets are trusted, code-defined functions (not user-supplied recipes).
"""

from __future__ import annotations

import importlib
import multiprocessing
import os
import re
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import Any

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator

from neurobridge.artifacts.store import ArtifactStore, validate_id
from neurobridge.benchmarks.contracts import JobManifest
from neurobridge.jobs.manager import JobManager

__all__ = [
    "WORKER_THREAD_ENV",
    "TaskOutput",
    "TaskSpec",
    "resolve_target",
    "run_inline",
    "start_process",
]

WORKER_THREAD_ENV: dict[str, str] = {
    "OMP_NUM_THREADS": "1",
    "OPENBLAS_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
    "NUMBA_NUM_THREADS": "1",
}

_TARGET = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*$")
_ENV_LOCK = threading.Lock()


class TaskSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    task_id: str = Field(min_length=1)
    target: str = Field(description="'package.module:function'")
    params: dict[str, Any] = Field(default_factory=dict)
    inputs: list[str] = Field(default_factory=list, description="input artifact IDs")
    output: str = Field(description="output artifact ID")
    kind: str = "array"
    stage: str | None = None

    @field_validator("target")
    @classmethod
    def _check_target(cls, value: str) -> str:
        if not _TARGET.fullmatch(value):
            raise ValueError(f"target must look like 'module:function', got {value!r}")
        return value

    @field_validator("output")
    @classmethod
    def _check_output(cls, value: str) -> str:
        return validate_id(value, what="output artifact id")

    @field_validator("inputs")
    @classmethod
    def _check_inputs(cls, value: list[str]) -> list[str]:
        return [validate_id(v, what="input artifact id") for v in value]


_TASK_LIST = TypeAdapter(list[TaskSpec])


@dataclass(frozen=True)
class TaskOutput:
    """Optional rich return value of a task function."""

    array: Any
    units: str | None = None
    axes: Sequence[str] = ()
    versions: Mapping[str, str] = field(default_factory=dict)


TaskFunction = Callable[[dict[str, Any], dict[str, np.ndarray]], Any]


def resolve_target(target: str) -> TaskFunction:
    if not _TARGET.fullmatch(target):
        raise ValueError(f"invalid task target {target!r}")
    module_name, func_name = target.split(":", 1)
    fn = getattr(importlib.import_module(module_name), func_name)
    if not callable(fn):
        raise TypeError(f"task target {target!r} is not callable")
    return fn


def _check_order(tasks: Sequence[TaskSpec]) -> None:
    seen_ids: set[str] = set()
    outputs: dict[str, int] = {}
    for i, task in enumerate(tasks):
        if task.task_id in seen_ids:
            raise ValueError(f"duplicate task_id {task.task_id!r}")
        if task.output in outputs:
            raise ValueError(f"duplicate output artifact {task.output!r}")
        seen_ids.add(task.task_id)
        outputs[task.output] = i
    for i, task in enumerate(tasks):
        for inp in task.inputs:
            if outputs.get(inp, -1) >= i:
                raise ValueError(f"task {task.task_id!r} uses {inp!r} before it is produced")


def run_inline(
    root: str | os.PathLike[str], job_id: str, tasks: Sequence[TaskSpec | Mapping[str, Any]]
) -> JobManifest:
    """Run a queued job synchronously in this process and return its final manifest."""
    specs = _TASK_LIST.validate_python(list(tasks))
    _check_order(specs)
    manager = JobManager(root)
    store = ArtifactStore(root)
    job = manager.get(job_id)
    if job.state == "cancelled":
        return job
    experiment_id = job.experiment_id
    manager.start(job_id, total_tasks=len(specs))
    try:
        for task in specs:
            if manager.is_cancel_requested(job_id):
                break
            manager.update_stage(job_id, task.stage or task.task_id)
            _run_task(manager, store, job_id, experiment_id, task)
    except BaseException:
        # Bookkeeping itself broke (e.g. the index vanished); leave a truthful state.
        try:
            manager.finish(job_id, "interrupted")
        finally:
            raise
    return manager.finish(job_id)


def _run_task(
    manager: JobManager, store: ArtifactStore, job_id: str, experiment_id: str, task: TaskSpec
) -> None:
    if store.verify(experiment_id, task.output):
        manager.mark_task(job_id, task.task_id, "reused", artifact_id=task.output)
        return
    missing = [inp for inp in task.inputs if not store.verify(experiment_id, inp)]
    if missing:
        manager.mark_task(
            job_id,
            task.task_id,
            "skipped",
            reason_code="dependency_unavailable",
            message=f"missing or invalid inputs: {', '.join(missing)}",
        )
        return
    try:
        inputs = {inp: store.get(experiment_id, inp).array for inp in task.inputs}
        result = resolve_target(task.target)(dict(task.params), inputs)
        out = result if isinstance(result, TaskOutput) else TaskOutput(array=result)
        if out.array is None:
            raise ValueError("task returned no array")
        store.put_array(
            experiment_id,
            task.output,
            out.array,
            kind=task.kind,
            units=out.units,
            axes=list(out.axes),
            parents=list(task.inputs),
            versions=dict(out.versions),
        )
    except Exception as exc:  # per-task failure; keep going with independent tasks
        manager.mark_task(
            job_id,
            task.task_id,
            "failed",
            reason_code="task_exception",
            message=f"{type(exc).__name__}: {exc}",
        )
        return
    manager.mark_task(job_id, task.task_id, "completed", artifact_id=task.output)


def _process_entry(root: str, job_id: str, tasks_json: str) -> None:
    os.environ.update(WORKER_THREAD_ENV)
    run_inline(root, job_id, _TASK_LIST.validate_json(tasks_json))


def start_process(
    root: str | os.PathLike[str], job_id: str, tasks: Sequence[TaskSpec | Mapping[str, Any]]
) -> BaseProcess:
    """Start the job in a separate ``spawn`` process (outlives the calling request).

    The child inherits the thread caps in :data:`WORKER_THREAD_ENV` from the moment it starts.
    The caller may ``join()`` or forget the returned process; if the worker dies, the job stays
    ``running`` until :meth:`JobManager.recover` marks it ``interrupted``.
    """
    specs = _TASK_LIST.validate_python(list(tasks))
    _check_order(specs)
    tasks_json = _TASK_LIST.dump_json(specs).decode("utf-8")
    ctx = multiprocessing.get_context("spawn")
    proc = ctx.Process(
        target=_process_entry,
        args=(str(Path(root).resolve()), job_id, tasks_json),
        name=f"neurobridge-job-{job_id}",
        daemon=False,
    )
    with _ENV_LOCK:
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
