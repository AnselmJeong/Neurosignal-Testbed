"""Job-worker task functions for the JR benchmark (``neurobridge.benchmarks.tasks:<fn>``).

Each function has the worker signature ``fn(params, inputs) -> ndarray | TaskOutput``; the
worker commits the returned array under the task's cache-keyed output ID. JSON side results
(observation metadata, MetricResult, comparisons, evaluation) are written atomically under
``<store>/<experiment>/_run/`` *before* the array is returned, so a committed artifact always
has its sidecar. Generation truth lives in ``<experiment>/_truth/`` and is read only by
:func:`evaluate`.

Common params: ``root``, ``experiment_id``, ``artifact_id`` (this task's output ID). They are
bookkeeping, not part of any cache key.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import numpy as np

from neurobridge.artifacts.store import ArtifactStore, validate_id
from neurobridge.benchmarks.contracts import (
    JRSimulationSpec,
    MetricResult,
    MetricStatus,
    ObservationSpec,
    SeedTree,
)
from neurobridge.jobs.worker import TaskOutput

__all__ = [
    "TASK_PREFIX",
    "MetricNotOkError",
    "compare",
    "epoch",
    "evaluate",
    "load_metric_result",
    "metric",
    "observe",
    "read_json",
    "run_dir",
    "simulate",
    "spectral_summary",
    "truth_path",
    "write_json_atomic",
]

TASK_PREFIX = "neurobridge.benchmarks.tasks:"
SPECTRAL_FMIN, SPECTRAL_FMAX = 1.0, 45.0


class MetricNotOkError(RuntimeError):
    """A metric returned a non-ok status; its MetricResult JSON is already on disk."""


# --------------------------------------------------------------------------- JSON sidecars


def _json_default(obj: Any) -> Any:
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, Path):
        return str(obj)
    raise TypeError(f"not JSON serializable: {type(obj).__name__}")


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, default=_json_default, allow_nan=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def run_dir(root: str | os.PathLike[str], experiment_id: str) -> Path:
    return ArtifactStore(root).experiment_dir(experiment_id, create=True) / "_run"


def truth_path(root: str | os.PathLike[str], experiment_id: str) -> Path:
    return ArtifactStore(root).experiment_dir(experiment_id, create=True) / "_truth" / "truth.json"


def _sidecar(params: Mapping[str, Any], kind: str, artifact_id: str | None = None) -> Path:
    aid = validate_id(artifact_id or params["artifact_id"], what="artifact id")
    return run_dir(params["root"], params["experiment_id"]) / kind / f"{aid}.json"


def _nan_to_none(value: Any) -> Any:
    if isinstance(value, float) and not np.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _nan_to_none(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_nan_to_none(v) for v in value]
    return value


def load_metric_result(root: Any, experiment_id: str, artifact_id: str) -> MetricResult | None:
    path = run_dir(root, experiment_id) / "metrics" / f"{artifact_id}.json"
    if not path.exists():
        return None
    return MetricResult.model_validate_json(path.read_text(encoding="utf-8"))


def _single(inputs: Mapping[str, np.ndarray]) -> np.ndarray:
    if len(inputs) != 1:
        raise ValueError(f"expected exactly one input, got {len(inputs)}")
    return np.asarray(next(iter(inputs.values())))


# --------------------------------------------------------------------------- tasks


def simulate(params: dict[str, Any], inputs: dict[str, np.ndarray]) -> TaskOutput:
    """Integrate the JR network once for one (seed, G); output (n_nodes, n_samples) mV."""
    from neurobridge.simulation.tvb_jr import simulate_jr, tvb_version

    spec = JRSimulationSpec.model_validate(params["simulation"])
    result = simulate_jr(spec)
    meta = {k: v for k, v in result.metadata.items() if k not in ("C", "D")}  # truth stays out
    write_json_atomic(
        _sidecar(params, "meta"),
        _nan_to_none(
            {
                "kind": "jr_source",
                "fs": result.fs,
                "node_ids": result.node_ids,
                "units": "mV",
                "seed": spec.seeds.root,
                "G": spec.G,
                "metadata": json.loads(json.dumps(meta, default=_json_default)),
            }
        ),
    )
    return TaskOutput(
        array=result.v, units="mV", axes=("node", "time"), versions={"tvb": tvb_version()}
    )


def observe(params: dict[str, Any], inputs: dict[str, np.ndarray]) -> TaskOutput:
    """Apply one observation model to a stored source artifact (never modified)."""
    from neurobridge.forward.observation import checksum
    from neurobridge.forward.observation import observe as observe_fn

    v = _single(inputs)
    source_id = next(iter(inputs))
    source_checksum = checksum(v)
    spec = ObservationSpec.model_validate(params["observation"])
    seeds = SeedTree(root=int(params["seed"]))
    res = observe_fn(v, spec, seeds, seed_path=tuple(params.get("seed_path", ())))
    if checksum(v) != source_checksum:
        raise RuntimeError("observation modified its source input")
    store = ArtifactStore(params["root"])
    operators: dict[str, str] = {}
    for name, arr in res.artifacts().items():
        if name == "observed":
            continue
        aid = f"{params['artifact_id']}.{name}"
        store.put_array(params["experiment_id"], aid, arr, kind=f"observation_{name}")
        operators[name] = aid
    write_json_atomic(
        _sidecar(params, "meta"),
        _nan_to_none(
            {
                "kind": res.kind,
                "observation_name": params.get("observation_name"),
                "analysis_space": res.analysis_space,
                "units": res.units,
                "channel_names": list(res.channel_names),
                "reference": res.reference,
                "reference_label": res.reference_label,
                "gain": res.gain,
                "gain_units": res.gain_units,
                "sensor_noise_std": res.sensor_noise_std,
                "sensor_noise_seed": res.sensor_noise_seed,
                "source_artifact_id": source_id,
                "source_checksum": source_checksum,
                "operators": operators,
                "metadata": json.loads(json.dumps(res.metadata, default=_json_default)),
            }
        ),
    )
    return TaskOutput(array=res.data, units=res.units, axes=("channel", "time"))


def epoch(params: dict[str, Any], inputs: dict[str, np.ndarray]) -> TaskOutput:
    """Cut non-overlapping epochs of ``epoch_s``; trailing samples are dropped (recorded)."""
    x = _single(inputs)
    n_per = int(round(float(params["epoch_s"]) * float(params["sfreq"])))
    if n_per <= 0:
        raise ValueError("epoch length must be positive")
    n_ch, n_t = x.shape
    n_ep = n_t // n_per
    if n_ep == 0:
        raise ValueError(f"recording ({n_t} samples) shorter than one epoch ({n_per})")
    out = np.ascontiguousarray(x[:, : n_ep * n_per].reshape(n_ch, n_ep, n_per).transpose(1, 0, 2))
    return TaskOutput(
        array=out,
        units=params.get("units"),
        axes=("epoch", "channel", "time"),
        versions={
            "epoching": f"non-overlapping {params['epoch_s']} s",
            "dropped_trailing_samples": str(n_t - n_ep * n_per),
        },
    )


def spectral_summary(params: dict[str, Any], inputs: dict[str, np.ndarray]) -> TaskOutput:
    """Welch peak frequency and log10 power (1-45 Hz) per channel, averaged over epochs."""
    from scipy.signal import welch

    x = _single(inputs)
    fs = float(params["sfreq"])
    nperseg = min(x.shape[-1], int(round(4 * fs)))
    freqs, psd = welch(x, fs=fs, nperseg=nperseg, axis=-1)
    psd = psd.mean(axis=0)  # (n_ch, n_freqs)
    band = (freqs >= SPECTRAL_FMIN) & (freqs <= SPECTRAL_FMAX)
    peak = freqs[band][np.argmax(psd[:, band], axis=1)]
    power = np.trapezoid(psd[:, band], freqs[band], axis=1)
    with np.errstate(divide="ignore"):
        logp = np.log10(power)
    return TaskOutput(
        array=np.column_stack([peak, logp]),
        axes=("channel", "feature"),
        versions={
            "features": "welch_peak_hz,welch_log10_power_1_45Hz",
            "welch": f"nperseg={nperseg}, mean over epochs",
        },
    )


def metric(params: dict[str, Any], inputs: dict[str, np.ndarray]) -> TaskOutput:
    """Run one registered metric adapter on an epoch artifact."""
    import neurobridge.metrics.connectivity  # noqa: F401  (registers M11-M20)
    import neurobridge.metrics.directed  # noqa: F401  (registers M27/M28)
    import neurobridge.metrics.information  # noqa: F401  (registers M22/M23)
    from neurobridge.metrics import registry

    data = np.array(_single(inputs), dtype=np.float64, copy=True)
    obs_meta = read_json(_sidecar(params, "meta", params["observation_id"]))
    ctx = {
        "sfreq": float(params["sfreq"]),
        "channel_names": obs_meta["channel_names"],
        "analysis_space": params["analysis_space"],
        "input_artifact_id": next(iter(inputs)),
        "units": obs_meta["units"],
        "params": dict(params.get("metric_params") or {}),
    }
    result = registry.run(params["metric_id"], data, ctx, variant=params["variant"])
    path = _sidecar(params, "metrics")
    if result.status is not MetricStatus.OK:
        write_json_atomic(path, _nan_to_none(result.model_dump(mode="json")))
        raise MetricNotOkError(f"{result.status.value}: {result.reason_code}")
    values = np.array(
        [np.nan if v is None else v for v in np.asarray(result.values, dtype=object).ravel()],
        dtype=np.float64,
    ).reshape(np.shape(np.asarray(result.values, dtype=object)))
    stored = result.model_copy(update={"values": None, "artifact_ref": params["artifact_id"]})
    write_json_atomic(path, _nan_to_none(stored.model_dump(mode="json")))
    return TaskOutput(
        array=values,
        units=result.units,
        axes=tuple(result.axes),
        versions={"backend": str(result.backend), "backend_version": str(result.backend_version)},
    )


def _cells(
    params: Mapping[str, Any], inputs: Mapping[str, np.ndarray], key: str
) -> dict[str, dict[int, np.ndarray | None]]:
    out: dict[str, dict[int, np.ndarray | None]] = {}
    for cond, by_seed in (params.get(key) or {}).items():
        out[cond] = {
            int(seed): (np.asarray(inputs[aid]) if aid in inputs else None)
            for seed, aid in by_seed.items()
        }
    return out


def _labels(params: Mapping[str, Any], inputs: Mapping[str, np.ndarray]) -> list[str]:
    from neurobridge.benchmarks.comparisons import feature_labels

    for by_seed in params["cells"].values():
        for aid in by_seed.values():
            res = load_metric_result(params["root"], params["experiment_id"], aid)
            if res is not None and aid in inputs:
                return feature_labels(res.axes, res.parameters, inputs[aid].shape)
    raise ValueError("no metric result available for feature labels")


def compare(params: dict[str, Any], inputs: dict[str, np.ndarray]) -> TaskOutput:
    """Seed-paired comparisons of one metric in one analysis space."""
    from neurobridge.benchmarks.comparisons import compare_metric

    out = compare_metric(
        metric_id=params["metric_id"],
        variant=params["variant"],
        space=params["space"],
        seeds=params["seeds"],
        values=_cells(params, inputs, "cells"),
        labels=_labels(params, inputs),
        spectral=_cells(params, inputs, "spectral"),
        n_bootstrap=int(params["n_bootstrap"]),
        n_surrogates=int(params["n_surrogates"]),
        stats_seed=int(params["stats_seed"]),
    )
    out["input_artifacts"] = {"cells": params["cells"], "spectral": params.get("spectral")}
    write_json_atomic(_sidecar(params, "comparisons"), _nan_to_none(out))
    est = [np.nan if r["estimate"] is None else r["estimate"] for r in out["summary"]]
    return TaskOutput(array=np.asarray(est, dtype=np.float64), axes=("comparison",))


def evaluate(params: dict[str, Any], inputs: dict[str, np.ndarray]) -> TaskOutput:
    """Truth-aware source evaluation; the only task that reads generation truth."""
    from neurobridge.benchmarks.evaluation import evaluate_source_metric

    raw = truth_path(params["root"], params["experiment_id"]).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != params["truth_sha256"]:
        raise RuntimeError("truth changed since planning; re-plan the evaluation")
    truth = json.loads(raw)
    cells = {
        cond: {s: v for s, v in by_seed.items() if v is not None}
        for cond, by_seed in _cells(params, inputs, "cells").items()
    }
    out = evaluate_source_metric(
        metric_id=params["metric_id"],
        variant=params["variant"],
        analysis_space="source",
        labels=_labels(params, inputs),
        values=cells,
        coupling={k: float(v) for k, v in params["coupling"].items()},
        truth=truth,
    )
    out["truth_sha256"] = digest
    write_json_atomic(_sidecar(params, "evaluation"), _nan_to_none(out))
    aucs = [
        np.nan if f["mean_auc"] is None else f["mean_auc"]
        for c in out["conditions"]
        for f in c["by_feature"]
    ]
    return TaskOutput(array=np.asarray(aucs, dtype=np.float64), axes=("condition_feature",))
