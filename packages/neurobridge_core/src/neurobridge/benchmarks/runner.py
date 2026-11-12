"""Run, resume, re-analyse and export JR benchmark experiments (plan §4.1, §5.4, §5.5).

One runner serves the CLI and the API: it plans the cache-keyed tasks, writes the recipe/plan
and the separately-held truth, and hands the task list to the job worker (inline or in a
spawned process). Everything after the worker is a read of committed artifacts and JSON
sidecars, so a restarted server can restore any experiment from ``root`` alone.

Layout under ``<root>/benchmarks/<experiment_id>/``::

    <artifact>.npy / <artifact>.json        arrays + manifests (ArtifactStore)
    _run/recipe.json, _run/plan.json        current analysis recipe and plan
    _run/plans/<plan_sha>.json              plan history (rerun_analyses)
    _run/meta|metrics|comparisons|evaluation/<artifact>.json
    _truth/truth.json                       generation truth; read only by evaluate tasks
"""

from __future__ import annotations

import csv
import hashlib
import os
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import Any

from neurobridge.artifacts.store import ArtifactStore, canonical_json
from neurobridge.benchmarks.contracts import JobManifest, MetricSpec
from neurobridge.benchmarks.planner import (
    BenchmarkRecipe,
    ExperimentPlan,
    build_truth,
    default_experiment_id,
    plan_experiment,
    validate_recipe,
)
from neurobridge.benchmarks.tasks import (
    TASK_PREFIX,
    load_metric_result,
    read_json,
    run_dir,
    truth_path,
    write_json_atomic,
)
from neurobridge.jobs.manager import ACTIVE_STATES, JobManager
from neurobridge.jobs.worker import run_inline, start_process

__all__ = [
    "RunHandle",
    "collect_results",
    "export_experiment",
    "load_plan",
    "load_recipe",
    "prepare_experiment",
    "rerun_analyses",
    "resume_experiment",
    "run_experiment",
    "validate",
]

RESUMABLE_STATES = {"interrupted", "cancelled", "failed"}


@dataclass
class RunHandle:
    experiment_id: str
    job_id: str
    plan: ExperimentPlan
    job: JobManifest
    process: BaseProcess | None = None


def load_recipe(source: str | os.PathLike[str] | Mapping[str, Any] | BenchmarkRecipe):
    if isinstance(source, BenchmarkRecipe):
        return source
    if isinstance(source, Mapping):
        return BenchmarkRecipe.model_validate(dict(source))
    return BenchmarkRecipe.model_validate_json(Path(source).read_text(encoding="utf-8"))


def validate(source: Any) -> dict[str, Any]:
    return validate_recipe(load_recipe(source))


def load_plan(root: str | os.PathLike[str], experiment_id: str) -> ExperimentPlan:
    path = run_dir(root, experiment_id) / "plan.json"
    if not path.exists():
        raise KeyError(f"experiment {experiment_id!r} has no plan under {root}")
    return ExperimentPlan.model_validate_json(path.read_text(encoding="utf-8"))


def _stored_recipe(root: Any, experiment_id: str) -> BenchmarkRecipe:
    return load_recipe(run_dir(root, experiment_id) / "recipe.json")


def prepare_experiment(
    recipe: Any, root: str | os.PathLike[str], experiment_id: str | None = None
) -> ExperimentPlan:
    """Write truth (once), recipe and plan; return the plan. Raises ValueError if invalid."""
    recipe = load_recipe(recipe)
    root = Path(root).resolve()
    exp = experiment_id or default_experiment_id(recipe)
    tpath = truth_path(root, exp)
    if not tpath.exists():  # truth is fixed at experiment creation
        write_json_atomic(tpath, build_truth(recipe))
    truth_sha = hashlib.sha256(tpath.read_bytes()).hexdigest()
    plan = plan_experiment(recipe, root=root, experiment_id=exp, truth_sha256=truth_sha)
    rdir = run_dir(root, exp)
    write_json_atomic(rdir / "recipe.json", recipe.model_dump(mode="json"))
    plan_json = plan.model_dump(mode="json")
    write_json_atomic(rdir / "plan.json", plan_json)
    plan_sha = hashlib.sha256(canonical_json(plan_json).encode()).hexdigest()[:16]
    write_json_atomic(rdir / "plans" / f"{plan_sha}.json", plan_json)
    return plan


def _launch(root: Path, plan: ExperimentPlan, job_id: str | None, inline: bool) -> RunHandle:
    for task in plan.tasks:
        if not task.target.startswith(TASK_PREFIX):
            raise ValueError(f"refusing task target {task.target!r}")
    mgr = JobManager(root)
    job = None
    if job_id is not None:
        try:
            job = mgr.get(job_id)
        except KeyError:
            job = None
        if job is not None:
            if job.experiment_id != plan.experiment_id:
                raise ValueError(f"job {job_id} belongs to experiment {job.experiment_id}")
            if job.state in RESUMABLE_STATES:
                job = mgr.resume(job_id)
            elif job.state != "queued":
                raise ValueError(f"job {job_id} is {job.state}")
    if job is None:
        job = mgr.create(plan.experiment_id, total_tasks=len(plan.tasks), job_id=job_id)
    if inline:
        final = run_inline(root, job.job_id, plan.tasks)
        return RunHandle(plan.experiment_id, job.job_id, plan, final)
    proc = start_process(root, job.job_id, plan.tasks)
    return RunHandle(plan.experiment_id, job.job_id, plan, mgr.get(job.job_id), proc)


def run_experiment(
    spec: Any,
    root: str | os.PathLike[str],
    job_id: str | None = None,
    inline: bool = False,
    *,
    experiment_id: str | None = None,
) -> RunHandle:
    """Plan and run a recipe. ``inline`` blocks; otherwise a spawned worker runs the job."""
    root = Path(root).resolve()
    plan = prepare_experiment(spec, root, experiment_id)
    return _launch(root, plan, job_id, inline)


def _latest_job(mgr: JobManager, experiment_id: str) -> JobManifest | None:
    jobs = mgr.list(experiment_id)
    return max(jobs, key=lambda j: j.created_at) if jobs else None


def resume_experiment(
    root: str | os.PathLike[str], experiment_id: str, *, inline: bool = False
) -> RunHandle:
    """Re-run the stored plan; committed, checksum-valid artifacts are reused."""
    root = Path(root).resolve()
    recipe = _stored_recipe(root, experiment_id)
    plan = prepare_experiment(recipe, root, experiment_id)
    latest = _latest_job(JobManager(root), experiment_id)
    if latest is not None and latest.state in ACTIVE_STATES:
        raise ValueError(f"job {latest.job_id} is still {latest.state}")
    job_id = latest.job_id if latest is not None and latest.state in RESUMABLE_STATES else None
    return _launch(root, plan, job_id, inline)


def rerun_analyses(
    root: str | os.PathLike[str],
    experiment_id: str,
    metrics: Sequence[MetricSpec | Mapping[str, Any]],
    *,
    inline: bool = False,
) -> RunHandle:
    """Recompute metrics on the same stored signals (no re-simulation if sources are intact)."""
    root = Path(root).resolve()
    recipe = _stored_recipe(root, experiment_id)
    specs = [m if isinstance(m, MetricSpec) else MetricSpec.model_validate(m) for m in metrics]
    bench = recipe.benchmark.model_copy(update={"metrics": specs})
    bench = type(bench).model_validate(bench.model_dump())
    updated = recipe.model_copy(update={"benchmark": bench})
    plan = prepare_experiment(updated, root, experiment_id)
    latest = _latest_job(JobManager(root), experiment_id)
    if latest is not None and latest.state in ACTIVE_STATES:
        raise ValueError(f"job {latest.job_id} is still {latest.state}")
    return _launch(root, plan, None, inline)


# --------------------------------------------------------------------------- results


def _read_optional(path: Path) -> Any:
    return read_json(path) if path.exists() else None


def collect_results(root: str | os.PathLike[str], experiment_id: str) -> dict[str, Any]:
    """Restore the experiment state from disk (plan, statuses, comparisons, evaluation)."""
    root = Path(root).resolve()
    plan = load_plan(root, experiment_id)
    store = ArtifactStore(root)
    rdir = run_dir(root, experiment_id)
    latest = _latest_job(JobManager(root), experiment_id)

    metric_rows: list[dict[str, Any]] = []
    for unit in plan.units:
        cond = next(c for c in plan.conditions if c.label == unit.condition)
        for key, aid in unit.metrics.items():
            mid, variant = key.split(":", 1)
            res = load_metric_result(root, experiment_id, aid)
            committed = store.verify(experiment_id, aid)
            if res is None:
                status, reason = "not_run", "no_result_recorded"
            elif res.status.value == "ok" and not committed:
                status, reason = "not_run", "artifact_missing_or_corrupt"
            else:
                status, reason = res.status.value, res.reason_code
            metric_rows.append(
                {
                    "seed": unit.seed,
                    "condition": unit.condition,
                    "analysis_space": cond.analysis_space,
                    "metric_id": mid,
                    "variant": variant,
                    "status": status,
                    "reason_code": reason,
                    "artifact_id": aid if status == "ok" else None,
                    "n_epochs": None if res is None else res.n_epochs,
                    "units": None if res is None else res.units,
                    "validity_flags": [] if res is None else res.validity_flags,
                }
            )

    comparisons: list[dict[str, Any]] = []
    evaluations: list[dict[str, Any]] = []
    for an in plan.analyses:
        sub = "comparisons" if an.kind == "compare" else "evaluation"
        payload = _read_optional(rdir / sub / f"{an.artifact_id}.json")
        if payload is None or not store.verify(experiment_id, an.artifact_id):
            cells = Counter(
                r["status"]
                for r in metric_rows
                if r["metric_id"] == an.metric_id
                and r["variant"] == an.variant
                and r["analysis_space"] == an.space
            )
            payload = {
                "metric_id": an.metric_id,
                "variant": an.variant,
                "analysis_space": an.space,
                "status": "not_computed",
                "reason_code": "metric_results_unavailable",
                "metric_cell_statuses": dict(cells),
            }
        payload = {"artifact_id": an.artifact_id, **payload}
        (comparisons if an.kind == "compare" else evaluations).append(payload)

    observations: dict[str, Any] = {}
    for unit in plan.units:
        meta = _read_optional(rdir / "meta" / f"{unit.observation_id}.json")
        if meta is not None:
            observations[unit.observation_id] = {
                k: meta.get(k)
                for k in (
                    "kind",
                    "observation_name",
                    "analysis_space",
                    "units",
                    "reference_label",
                    "gain",
                    "source_artifact_id",
                    "source_checksum",
                )
            }
    return {
        "experiment_id": experiment_id,
        "preset": plan.preset,
        "profile": plan.profile,
        "seeds": plan.seeds,
        "coupling_levels": plan.coupling_levels,
        "conditions": [c.model_dump(mode="json") for c in plan.conditions],
        "gain_source": plan.gain_source,
        "cost": plan.cost.model_dump(mode="json"),
        "warnings": plan.warnings,
        "job": None if latest is None else latest.model_dump(mode="json"),
        "metric_results": metric_rows,
        "observations": observations,
        "comparisons": comparisons,
        "evaluation": evaluations,
    }


CSV_FIELDS = [
    "kind",
    "metric_id",
    "variant",
    "analysis_space",
    "condition_a",
    "condition_b",
    "feature",
    "status",
    "reason_code",
    "independent_n",
    "estimate",
    "ci_low",
    "ci_high",
    "p_value",
    "null_family",
    "test_family",
]


def _csv_rows(results: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for comp in results["comparisons"]:
        if "summary" not in comp:
            rows.append(
                {
                    "kind": "summary",
                    "metric_id": comp["metric_id"],
                    "variant": comp["variant"],
                    "analysis_space": comp["analysis_space"],
                    "status": comp["status"],
                    "reason_code": comp["reason_code"],
                }
            )
            continue
        for kind in ("summary", "companions"):
            for r in comp[kind]:
                c = r["contrast"]
                rows.append(
                    {
                        "kind": kind,
                        "metric_id": c["metric_id"],
                        "variant": c["variant"],
                        "analysis_space": c["analysis_space"],
                        "condition_a": c["condition_a"],
                        "condition_b": c["condition_b"],
                        "feature": c["feature"],
                        **{k: r.get(k) for k in CSV_FIELDS[7:]},
                    }
                )
    return rows


def export_experiment(
    root: str | os.PathLike[str], experiment_id: str, out_dir: str | os.PathLike[str]
) -> dict[str, str]:
    """Write ``results.json``, ``summary.csv`` and ``recipe.json`` into ``out_dir``."""
    root = Path(root).resolve()
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    results = collect_results(root, experiment_id)
    write_json_atomic(out / "results.json", results)
    write_json_atomic(out / "recipe.json", read_json(run_dir(root, experiment_id) / "recipe.json"))
    with (out / "summary.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(_csv_rows(results))
    return {name: str(out / name) for name in ("results.json", "summary.csv", "recipe.json")}
