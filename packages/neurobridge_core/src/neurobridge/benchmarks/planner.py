"""Expand a JR benchmark recipe into a cache-keyed task plan (plan §2.3, §4.1, §6.2).

Q1 conditions::

    A = (G=0,  identity_probe)   B = (G>0, identity_probe)
    C = (G=0,  eeg_forward)      D = (G>0, eeg_forward)
    source_off = (G=0, source_native)   source_on = (G>0, source_native)   # always added

JR is integrated once per (seed, G); every observation of that (seed, G) reads the same source
artifact. Artifact IDs are content cache keys (:func:`neurobridge.artifacts.store.cache_key`):
changing a metric reuses the epochs, changing an observation reuses the source. Analysis tasks
never receive generation truth; only the final ``evaluate`` tasks reference it.
"""

from __future__ import annotations

import hashlib
import math
import os
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from neurobridge.artifacts.store import cache_key, canonical_json
from neurobridge.benchmarks.contracts import (
    BenchmarkSpec,
    JRSimulationSpec,
    MetricSpec,
    ObservationSpec,
    SeedTree,
)
from neurobridge.benchmarks.presets import QuestionPreset, get_preset
from neurobridge.benchmarks.tasks import TASK_PREFIX
from neurobridge.jobs.worker import TaskSpec

__all__ = [
    "BenchmarkRecipe",
    "CostEstimate",
    "ExperimentPlan",
    "PlannedAnalysis",
    "PlannedCondition",
    "PlannedUnit",
    "build_truth",
    "default_experiment_id",
    "estimate_cost",
    "plan_experiment",
    "recipe_sha256",
    "validate_recipe",
]

PLANNER_VERSION = "1"
SOURCE_OBSERVATION = "source_native"
# Pilot timing from the p2-jr handoff: ~0.42 s wall per simulated second (n <= 32 nodes).
SIM_WALL_PER_SIM_S = 0.55
METRIC_WALL_S = 1.0
SPECTRAL_METRICS = {"M12", "M13", "M14", "M15", "M16", "M17", "M18"}
MIN_SPECTRAL_EPOCHS = 5


class BenchmarkRecipe(BaseModel):
    """File format of ``fixtures/recipes/jr-core-*.json``."""

    model_config = ConfigDict(extra="forbid")

    recipe_version: str = "1.0"
    kind: Literal["jr-benchmark"] = "jr-benchmark"
    title: str = ""
    status: str | None = None
    notes: list[str] = Field(default_factory=list)
    calibration_seeds: list[int] = Field(default_factory=list)
    conditions: dict[str, dict[str, Any]] | None = None
    benchmark: BenchmarkSpec
    simulation: JRSimulationSpec
    observations: dict[str, ObservationSpec]


class PlannedCondition(BaseModel):
    label: str
    G: float
    observation: str
    observation_kind: str
    analysis_space: Literal["source", "sensor"]


class PlannedUnit(BaseModel):
    seed: int
    condition: str
    simulation_id: str
    observation_id: str
    epoch_id: str
    spectral_id: str
    metrics: dict[str, str] = Field(default_factory=dict)  # "M14:default" -> artifact id


class PlannedAnalysis(BaseModel):
    kind: Literal["compare", "evaluate"]
    metric_id: str
    variant: str
    space: Literal["source", "sensor"]
    artifact_id: str
    task_id: str


class CostEstimate(BaseModel):
    n_seeds: int
    n_coupling_levels: int
    n_simulations: int
    n_observations: int
    n_epoch_sets: int
    n_metric_tasks: int
    n_tasks: int
    simulated_seconds: float
    estimated_runtime_s: float
    estimated_bytes: int
    basis: str


class ExperimentPlan(BaseModel):
    planner_version: str = PLANNER_VERSION
    experiment_id: str
    recipe_sha256: str
    preset: str
    profile: str
    seeds: list[int]
    coupling_levels: list[float]
    epoch_s: float
    sfreq: float
    conditions: list[PlannedCondition]
    observations: dict[str, ObservationSpec]
    gain_source: dict[str, str]
    metrics: list[MetricSpec]
    units: list[PlannedUnit]
    analyses: list[PlannedAnalysis]
    truth_sha256: str
    cost: CostEstimate
    warnings: list[str] = Field(default_factory=list)
    tasks: list[TaskSpec]


def recipe_sha256(recipe: BenchmarkRecipe) -> str:
    return hashlib.sha256(canonical_json(recipe.model_dump(mode="json")).encode()).hexdigest()


def default_experiment_id(recipe: BenchmarkRecipe) -> str:
    return f"jr-{recipe_sha256(recipe)[:16]}"


def build_truth(recipe: BenchmarkRecipe) -> dict[str, Any]:
    """Generation truth kept outside analysis (plan §4.5)."""
    C = recipe.simulation.C
    return {
        "orientation": "[target][source]",
        "C": C,
        "D": recipe.simulation.D,
        "D_units": "ms",
        "planted_edges": [
            [t, s] for t, row in enumerate(C) for s, w in enumerate(row) if t != s and w != 0
        ],
        "coupling_levels": [float(g) for g in recipe.benchmark.factors.get("G", [])],
    }


# --------------------------------------------------------------------------- validation


def _conditions(
    recipe: BenchmarkRecipe, preset: QuestionPreset, errors: list[str]
) -> tuple[list[float], list[str]]:
    factors = recipe.benchmark.factors
    if set(factors) != {"G", "observation"}:
        errors.append(
            f"{preset.id} manipulates exactly G and observation; got factors {sorted(factors)}"
        )
        return [], []
    g = [float(x) for x in factors["G"]]
    obs = [str(x) for x in factors["observation"]]
    if len(g) != 2 or g[0] != 0.0 or not g[1] > 0.0:
        errors.append(f"G must be [0, G_on>0] (coupling off/on); got {g}")
    if len(obs) != 2:
        errors.append(f"observation must list [identity_probe, eeg_forward]; got {obs}")
        return g, obs
    for name, kind in zip(obs, ("identity_probe", "eeg_forward"), strict=True):
        spec = recipe.observations.get(name)
        if spec is None:
            errors.append(f"observation {name!r} is not defined in recipe.observations")
        elif spec.kind != kind:
            errors.append(f"observation {name!r} must have kind {kind!r}, got {spec.kind!r}")
    return g, obs


def _resolve_observations(
    recipe: BenchmarkRecipe,
    preset: QuestionPreset,
    obs_names: list[str],
    errors: list[str],
    warnings: list[str],
) -> tuple[dict[str, ObservationSpec], dict[str, str]]:
    held = recipe.benchmark.held_fixed
    out: dict[str, ObservationSpec] = {}
    gain_source: dict[str, str] = {}
    for name in obs_names:
        spec = recipe.observations.get(name)
        if spec is None:
            continue
        for key in ("reference", "sensor_noise_std"):
            if key in held and getattr(spec, key) != held[key]:
                errors.append(
                    f"held_fixed {key}={held[key]!r} but observation {name!r} has "
                    f"{getattr(spec, key)!r}"
                )
        if spec.gain == 1.0 and preset.observation_gain is not None:
            spec = spec.model_copy(update={"gain": preset.observation_gain})
            gain_source[name] = f"preset {preset.id}: {preset.observation_gain_note}"
            warnings.append(
                f"observation {name!r}: placeholder gain 1.0 A·m/mV replaced by the "
                f"uncalibrated {preset.id} preset gain {preset.observation_gain} A·m/mV"
            )
        else:
            gain_source[name] = "recipe"
        out[name] = spec
    n = recipe.simulation.n_nodes
    out[SOURCE_OBSERVATION] = ObservationSpec(kind="source_native", n_sensors=n)
    gain_source[SOURCE_OBSERVATION] = "not applicable (native source, mV)"
    return out, gain_source


def _check_lengths(
    recipe: BenchmarkRecipe, preset: QuestionPreset, epoch_s: float, warnings: list[str]
) -> None:
    sim = recipe.simulation
    fs = sim.output_fs
    n_per = int(round(epoch_s * fs))
    n_epochs = int(round(sim.duration_s * fs)) // n_per if n_per > 0 else 0
    min_dur = preset.required_length.get("min_duration_s")
    if min_dur and sim.duration_s < min_dur:
        warnings.append(
            f"duration {sim.duration_s:g} s < {preset.id} minimum {min_dur:g} s "
            f"({n_epochs} epoch(s) of {epoch_s:g} s)"
        )
    for m in recipe.benchmark.metrics:
        need = int(m.params.get("min_epochs", MIN_SPECTRAL_EPOCHS))
        if m.id in SPECTRAL_METRICS and n_epochs < need:
            warnings.append(
                f"{m.id}: {n_epochs} epoch(s) < {need} required -> expect insufficient_data"
            )
    if len(recipe.benchmark.seeds) < preset.required_length.get("min_seeds_for_ci", 2):
        warnings.append("fewer than 2 seeds: estimates without CI or p-value")


def _check_metrics(recipe: BenchmarkRecipe, warnings: list[str]) -> None:
    import neurobridge.metrics.connectivity  # noqa: F401
    import neurobridge.metrics.directed  # noqa: F401  (registers M27/M28)
    import neurobridge.metrics.information  # noqa: F401
    from neurobridge.metrics import registry

    for m in recipe.benchmark.metrics:
        if m.variant not in registry.registered_variants(m.id):
            warnings.append(
                f"{m.id}:{m.variant} has no registered adapter -> expect unsupported_dependency"
            )


def estimate_cost(recipe: BenchmarkRecipe, n_sensor_obs: int = 2) -> CostEstimate:
    sim = recipe.simulation
    b = recipe.benchmark
    n_seeds = len(b.seeds)
    n_g = len(b.factors.get("G", [0.0])) or 1
    n_sim = n_seeds * n_g
    n_obs = n_sim * (n_sensor_obs + 1)
    n_samples = int(round(sim.duration_s * sim.output_fs))
    sensor_ch = [s.n_sensors for s in recipe.observations.values()][:n_sensor_obs]
    ch_per_sim = sim.n_nodes + sum(sensor_ch)
    n_metric = n_obs * len(b.metrics)
    n_tasks = n_sim + 3 * n_obs + n_metric + 2 * len(b.metrics) + len(b.metrics)
    bytes_ = 8 * n_samples * (sim.n_nodes + 2 * ch_per_sim) * n_sim
    bytes_ += 8 * 5 * n_metric * max(ch_per_sim, 1) ** 2 // max(n_sensor_obs + 1, 1)
    sim_seconds = n_sim * (sim.burn_in_s + sim.duration_s + 0.25)
    runtime = SIM_WALL_PER_SIM_S * sim_seconds + METRIC_WALL_S * n_metric
    return CostEstimate(
        n_seeds=n_seeds,
        n_coupling_levels=n_g,
        n_simulations=n_sim,
        n_observations=n_obs,
        n_epoch_sets=n_obs,
        n_metric_tasks=n_metric,
        n_tasks=n_tasks,
        simulated_seconds=sim_seconds,
        estimated_runtime_s=round(runtime, 1),
        estimated_bytes=int(bytes_),
        basis=(
            "pilot estimate: ~0.42-0.55 s wall per simulated second (TVB JR, n<=32, p2-jr "
            "measurement), ~1 s per metric task; bytes = source + observed + epoch float64"
        ),
    )


def validate_recipe(recipe: BenchmarkRecipe) -> dict[str, Any]:
    """Schema-valid recipe -> scientific/cost checks. Returns {ok, errors, warnings, cost}."""
    errors: list[str] = []
    warnings: list[str] = []
    try:
        preset = get_preset(recipe.benchmark.question_preset)
    except KeyError as exc:
        return {"ok": False, "errors": [str(exc)], "warnings": [], "cost": None}
    if preset.status != "implemented":
        errors.append(f"preset {preset.id} is planned, not implemented")
        return {"ok": False, "errors": errors, "warnings": warnings, "cost": None}
    g, obs = _conditions(recipe, preset, errors)
    _resolve_observations(recipe, preset, obs, errors, warnings)
    held = recipe.benchmark.held_fixed
    if held.get("preprocessing", "none") != "none":
        errors.append("only preprocessing='none' is implemented in the Q1 vertical slice")
    for key in held:
        if key not in {"reference", "sensor_noise_std", "epoch_s", "preprocessing"}:
            warnings.append(f"held_fixed {key!r} is recorded but not interpreted by the runner")
    epoch_s = float(held.get("epoch_s", preset.required_length.get("epoch_s", 8.0)))
    if epoch_s <= 0:
        errors.append("epoch_s must be positive")
    else:
        _check_lengths(recipe, preset, epoch_s, warnings)
    _check_metrics(recipe, warnings)
    if recipe.conditions and g and len(obs) == 2:
        expected = {
            "A": (g[0], obs[0]),
            "B": (g[-1], obs[0]),
            "C": (g[0], obs[1]),
            "D": (g[-1], obs[1]),
        }
        for label, cond in recipe.conditions.items():
            want = expected.get(label)
            got = (float(cond.get("G", math.nan)), cond.get("observation"))
            if want is None or want != got:
                errors.append(f"recipe condition {label}={got} does not match planner {want}")
    cost = estimate_cost(recipe)
    budget = recipe.benchmark.budget
    if budget.max_tasks is not None and cost.n_tasks > budget.max_tasks:
        errors.append(f"{cost.n_tasks} tasks exceed budget.max_tasks={budget.max_tasks}")
    if budget.max_disk_bytes is not None and cost.estimated_bytes > budget.max_disk_bytes:
        errors.append(
            f"~{cost.estimated_bytes} bytes exceed budget.max_disk_bytes={budget.max_disk_bytes}"
        )
    if budget.max_runtime_s is not None and cost.estimated_runtime_s > budget.max_runtime_s:
        errors.append(
            f"~{cost.estimated_runtime_s} s exceed budget.max_runtime_s={budget.max_runtime_s}"
        )
    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "cost": cost.model_dump(mode="json"),
        "preset": preset.to_dict(),
    }


# --------------------------------------------------------------------------- planning


def _task(stage: str, task_id: str, fn: str, params: dict, inputs: list[str], out: str, book: dict):
    return TaskSpec(
        task_id=task_id,
        target=f"{TASK_PREFIX}{fn}",
        params={**params, **book, "artifact_id": out},
        inputs=inputs,
        output=out,
        kind=stage,
        stage=stage,
    )


def plan_experiment(
    recipe: BenchmarkRecipe,
    *,
    root: str | os.PathLike[str],
    experiment_id: str,
    truth_sha256: str,
) -> ExperimentPlan:
    """Expand ``recipe`` into an ordered task list. Raises ValueError if validation fails."""
    report = validate_recipe(recipe)
    if not report["ok"]:
        raise ValueError("invalid recipe: " + "; ".join(report["errors"]))
    preset = get_preset(recipe.benchmark.question_preset)
    errors: list[str] = []
    warnings: list[str] = []
    g_levels, obs_names = _conditions(recipe, preset, errors)
    observations, gain_source = _resolve_observations(recipe, preset, obs_names, errors, warnings)
    b = recipe.benchmark
    sim_base = recipe.simulation
    fs = float(sim_base.output_fs)
    epoch_s = float(b.held_fixed.get("epoch_s", preset.required_length.get("epoch_s", 8.0)))
    book = {"root": str(os.fspath(root)), "experiment_id": experiment_id}

    g_off, g_on = g_levels
    conditions = [
        PlannedCondition(label="A", G=g_off, observation=obs_names[0],
                         observation_kind="identity_probe", analysis_space="sensor"),
        PlannedCondition(label="B", G=g_on, observation=obs_names[0],
                         observation_kind="identity_probe", analysis_space="sensor"),
        PlannedCondition(label="C", G=g_off, observation=obs_names[1],
                         observation_kind="eeg_forward", analysis_space="sensor"),
        PlannedCondition(label="D", G=g_on, observation=obs_names[1],
                         observation_kind="eeg_forward", analysis_space="sensor"),
        PlannedCondition(label="source_off", G=g_off, observation=SOURCE_OBSERVATION,
                         observation_kind="source_native", analysis_space="source"),
        PlannedCondition(label="source_on", G=g_on, observation=SOURCE_OBSERVATION,
                         observation_kind="source_native", analysis_space="source"),
    ]  # fmt: skip

    sims: list[TaskSpec] = []
    obs_tasks: dict[str, TaskSpec] = {}
    epochs: dict[str, TaskSpec] = {}
    spectral: dict[str, TaskSpec] = {}
    metric_tasks: dict[str, TaskSpec] = {}
    sim_ids: dict[tuple[int, float], str] = {}
    units: list[PlannedUnit] = []

    for seed in b.seeds:
        for g in g_levels:
            spec = sim_base.model_copy(update={"G": float(g), "seeds": SeedTree(root=seed)})
            params = {"simulation": spec.model_dump(mode="json")}
            sid = cache_key("simulate", params)
            sim_ids[(seed, g)] = sid
            sims.append(_task("simulate", f"simulate/seed{seed}/G{g:g}", "simulate",
                              params, [], sid, book))  # fmt: skip
    for seed in b.seeds:
        for cond in conditions:
            sid = sim_ids[(seed, cond.G)]
            ospec = observations[cond.observation]
            o_params = {
                "observation": ospec.model_dump(mode="json"),
                "observation_name": cond.observation,
                "seed": seed,
                "seed_path": [cond.observation],
            }
            oid = cache_key("observe", o_params, [sid])
            units_kind = "mV" if cond.analysis_space == "source" else "V"
            if oid not in obs_tasks:
                obs_tasks[oid] = _task("observe", f"observe/seed{seed}/G{cond.G:g}/"
                                       f"{cond.observation}", "observe", o_params, [sid], oid,
                                       book)  # fmt: skip
            e_params = {"epoch_s": epoch_s, "sfreq": fs, "units": units_kind}
            eid = cache_key("epoch", e_params, [oid])
            if eid not in epochs:
                epochs[eid] = _task("epoch", f"epoch/{oid}", "epoch", e_params, [oid], eid, book)
            s_params = {"sfreq": fs, "fmin": 1.0, "fmax": 45.0, "nperseg_s": 4.0}
            spid = cache_key("spectral", s_params, [eid])
            if spid not in spectral:
                spectral[spid] = _task("spectral", f"spectral/{eid}", "spectral_summary",
                                       s_params, [eid], spid, book)  # fmt: skip
            unit = PlannedUnit(
                seed=seed,
                condition=cond.label,
                simulation_id=sid,
                observation_id=oid,
                epoch_id=eid,
                spectral_id=spid,
            )
            for m in b.metrics:
                if cond.analysis_space not in m.input_spaces:
                    continue
                m_params = {
                    "metric_id": m.id,
                    "variant": m.variant,
                    "backend": m.backend,
                    "metric_params": m.params,
                    "sfreq": fs,
                    "analysis_space": cond.analysis_space,
                }
                mid = cache_key("metric", m_params, [eid])
                unit.metrics[f"{m.id}:{m.variant}"] = mid
                if mid not in metric_tasks:
                    metric_tasks[mid] = _task(
                        "metric",
                        f"metric/{m.id}:{m.variant}/{eid}",
                        "metric",
                        {**m_params, "observation_id": oid},
                        [eid],
                        mid,
                        book,
                    )
            units.append(unit)

    analyses: list[PlannedAnalysis] = []
    analysis_tasks: list[TaskSpec] = []
    stats_seed = int(b.seeds[0])
    by_label = {c.label: c for c in conditions}
    for m in b.metrics:
        key = f"{m.id}:{m.variant}"
        for space in ("sensor", "source"):
            if space not in m.input_spaces:
                continue
            labels = [c.label for c in conditions if c.analysis_space == space]
            cells = {
                lab: {str(u.seed): u.metrics[key] for u in units if u.condition == lab}
                for lab in labels
            }
            spec_cells = {
                lab: {str(u.seed): u.spectral_id for u in units if u.condition == lab}
                for lab in labels
            }
            c_params = {
                "metric_id": m.id,
                "variant": m.variant,
                "space": space,
                "seeds": list(b.seeds),
                "cells": cells,
                "spectral": spec_cells,
                "n_bootstrap": b.budget.n_bootstrap,
                "n_surrogates": b.budget.n_surrogates,
                "stats_seed": stats_seed,
            }
            inputs = sorted(
                {a for d in cells.values() for a in d.values()}
                | {a for d in spec_cells.values() for a in d.values()}
            )
            cid = cache_key("compare", c_params, inputs)
            tid = f"compare/{key}/{space}"
            analysis_tasks.append(_task("compare", tid, "compare", c_params, inputs, cid, book))
            analyses.append(PlannedAnalysis(kind="compare", metric_id=m.id, variant=m.variant,
                                            space=space, artifact_id=cid, task_id=tid))  # fmt: skip
    for m in b.metrics:
        if "source" not in m.input_spaces:
            continue
        key = f"{m.id}:{m.variant}"
        cells = {
            lab: {str(u.seed): u.metrics[key] for u in units if u.condition == lab}
            for lab in ("source_off", "source_on")
        }
        ev_params = {
            "metric_id": m.id,
            "variant": m.variant,
            "cells": cells,
            "coupling": {lab: by_label[lab].G for lab in cells},
            "truth_sha256": truth_sha256,
        }
        inputs = sorted({a for d in cells.values() for a in d.values()})
        evid = cache_key("evaluate", ev_params, inputs)
        tid = f"evaluate/{key}/source"
        analysis_tasks.append(_task("evaluate", tid, "evaluate", ev_params, inputs, evid, book))
        analyses.append(PlannedAnalysis(kind="evaluate", metric_id=m.id, variant=m.variant,
                                        space="source", artifact_id=evid, task_id=tid))  # fmt: skip

    tasks = [
        *sims,
        *obs_tasks.values(),
        *epochs.values(),
        *spectral.values(),
        *metric_tasks.values(),
        *analysis_tasks,
    ]
    for t in tasks:
        if not t.target.startswith(TASK_PREFIX):
            raise ValueError(f"task target outside {TASK_PREFIX}: {t.target}")
    cost = estimate_cost(recipe).model_copy(update={"n_tasks": len(tasks)})
    return ExperimentPlan(
        experiment_id=experiment_id,
        recipe_sha256=recipe_sha256(recipe),
        preset=preset.id,
        profile=b.profile,
        seeds=list(b.seeds),
        coupling_levels=list(g_levels),
        epoch_s=epoch_s,
        sfreq=fs,
        conditions=conditions,
        observations=observations,
        gain_source=gain_source,
        metrics=list(b.metrics),
        units=units,
        analyses=analyses,
        truth_sha256=truth_sha256,
        cost=cost,
        warnings=sorted(set(report["warnings"]) | set(warnings)),
        tasks=tasks,
    )
