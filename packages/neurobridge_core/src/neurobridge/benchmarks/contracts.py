"""Versioned data contracts for the resting-state Jansen-Rit (JR) benchmark.

Plan: ``docs/plans/2026-11-12-resting-eeg-jr-benchmark.ko.md`` §2.1-2.4, §3.5, §5.3, §6.2.

Public API (other modules import these names exactly):

Constants
    ``IN_SCOPE_METRIC_IDS``  tuple of the 29 metric IDs (M01-M06, M11-M33).
    ``SEED_STREAMS``         ``("initial_state", "input", "sensor_noise", "artifact",
                             "surrogate", "bootstrap")``.

Enums / literals
    ``MetricStatus``         ok | not_applicable | insufficient_data | invalid_input |
                             unsupported_dependency | failed | cancelled (``StrEnum``).
    ``ObservationKind``, ``ReferenceKind``, ``ProfileKind``, ``JobState``, ``AnalysisSpace``.

Models (pydantic v2, ``extra="forbid"``)
    ``SeedTree(root)``  with ``seed_for(stream, *path) -> int``,
                        ``generator(stream, *path) -> numpy.random.Generator``,
                        ``stream_seeds() -> dict[str, int]``.
    ``InputNoiseSpec``, ``JRSimulationSpec`` (``monitor_period_ms``, ``steps_per_monitor``,
                        ``decimation`` properties), ``ObservationSpec``, ``MetricSpec``,
                        ``MetricResult`` (+ classmethod ``MetricResult.from_status``),
                        ``BudgetSpec``, ``BenchmarkSpec``, ``ArtifactManifest``,
                        ``ContrastDefinition``, ``PerSeedValue``, ``ComparisonResult``,
                        ``TaskCounts``, ``JobFailure``, ``JobManifest``.

Coupling orientation: ``JRSimulationSpec.C[target][source]`` is the weight of the
connection *from* ``source`` *to* ``target`` (row = receiver, column = sender). ``D`` uses
the same orientation and is in milliseconds. Simulator adapters convert to their own
convention; the external contract never changes.

A metric that did not produce a value is a status (never ``0`` and never an empty success
matrix): ``MetricResult`` with a non-``ok`` status must carry a ``reason_code`` and no values.
"""

from __future__ import annotations

import hashlib
import math
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

IN_SCOPE_METRIC_IDS: tuple[str, ...] = tuple(
    [f"M{i:02d}" for i in range(1, 7)] + [f"M{i:02d}" for i in range(11, 34)]
)

SEED_STREAMS: tuple[str, ...] = (
    "initial_state",
    "input",
    "sensor_noise",
    "artifact",
    "surrogate",
    "bootstrap",
)

ObservationKind = Literal["source_native", "identity_probe", "schematic_mixed", "eeg_forward"]
ReferenceKind = Literal["none", "average"]
ProfileKind = Literal["preview", "core-comparison", "full-metrics", "sensitivity"]
JobState = Literal["queued", "running", "completed", "failed", "cancelled", "interrupted"]
AnalysisSpace = Literal["source", "sensor", "connectivity"]

_REL_TOL = 1e-9


class MetricStatus(StrEnum):
    OK = "ok"
    NOT_APPLICABLE = "not_applicable"
    INSUFFICIENT_DATA = "insufficient_data"
    INVALID_INPUT = "invalid_input"
    UNSUPPORTED_DEPENDENCY = "unsupported_dependency"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _is_integer_ratio(numerator: float, denominator: float) -> bool:
    ratio = numerator / denominator
    return ratio >= 1 and math.isclose(ratio, round(ratio), rel_tol=_REL_TOL, abs_tol=_REL_TOL)


def _check_square(name: str, matrix: list[list[float]], n: int) -> None:
    if len(matrix) != n or any(len(row) != n for row in matrix):
        raise ValueError(f"{name} must be an n_nodes x n_nodes matrix ({n}x{n}), [target][source]")
    if any(not math.isfinite(value) for row in matrix for value in row):
        raise ValueError(f"{name} must contain only finite values")


# --------------------------------------------------------------------------- seeds


class SeedTree(ContractModel):
    """Root seed from which every named random stream is derived deterministically.

    ``seed_for(stream, *path)`` depends only on ``root``, the stream name and the optional
    path (e.g. ``("node", 3)``); it never depends on call order or worker scheduling, and
    one stream's seed does not change when another stream is used or added.
    """

    root: int = Field(default=0, ge=0, le=2**63 - 1)

    def _seed_sequence(self, stream: str, *path: str | int) -> np.random.SeedSequence:
        if stream not in SEED_STREAMS:
            raise ValueError(f"unknown seed stream {stream!r}; expected one of {SEED_STREAMS}")
        key = "/".join([stream, *(str(part) for part in path)])
        digest = hashlib.sha256(key.encode("utf-8")).digest()
        words = tuple(int.from_bytes(digest[i : i + 4], "little") for i in range(0, 32, 4))
        return np.random.SeedSequence(entropy=self.root, spawn_key=words)

    def seed_for(self, stream: str, *path: str | int) -> int:
        """Return a non-negative 63-bit integer seed for ``stream`` (and optional path)."""
        state = self._seed_sequence(stream, *path).generate_state(1, dtype=np.uint64)[0]
        return int(state) >> 1

    def generator(self, stream: str, *path: str | int) -> np.random.Generator:
        return np.random.default_rng(self._seed_sequence(stream, *path))

    def stream_seeds(self) -> dict[str, int]:
        return {stream: self.seed_for(stream) for stream in SEED_STREAMS}


# --------------------------------------------------------------------------- simulation


class InputNoiseSpec(ContractModel):
    """Stochastic external input to each JR population (independent across nodes).

    Starting values from plan §2.4 are proposals, not validated physiology.
    """

    kind: Literal["gaussian_white"] = "gaussian_white"
    mean: float = 0.22
    std: float = Field(default=0.022, ge=0)
    units: str = "1/ms"
    independent_per_node: bool = True


class JRSimulationSpec(ContractModel):
    """Jansen-Rit network specification.

    ``C[target][source]``: coupling weight from ``source`` to ``target``. ``D`` (ms) uses the
    same orientation. When omitted, ``C`` and ``D`` default to zero matrices (no coupling).
    """

    schema_version: Literal["1.0"] = "1.0"
    preset: str = Field(default="jr-alpha-default", min_length=1)
    version: str = Field(default="0.1", min_length=1)
    n_nodes: int = Field(default=32, ge=1, le=512)
    node_params: dict[str, float] = Field(default_factory=dict)
    C: list[list[float]] = Field(default_factory=list)
    D: list[list[float]] = Field(default_factory=list)
    G: float = Field(default=0.0, ge=0)
    input_noise: InputNoiseSpec = Field(default_factory=InputNoiseSpec)
    dt_ms: float = Field(default=0.1220703125, gt=0)
    monitor_hz: int = Field(default=1024, gt=0)
    output_fs: int = Field(default=256, gt=0)
    burn_in_s: float = Field(default=10.0, ge=0)
    duration_s: float = Field(default=120.0, gt=0)
    seeds: SeedTree = Field(default_factory=SeedTree)

    @model_validator(mode="before")
    @classmethod
    def default_zero_matrices(cls, data: Any) -> Any:
        if isinstance(data, dict):
            n = data.get("n_nodes", 32)
            if isinstance(n, int) and n > 0:
                data = dict(data)
                for key in ("C", "D"):
                    if key not in data or data[key] is None:
                        data[key] = [[0.0] * n for _ in range(n)]
        return data

    @model_validator(mode="after")
    def check_consistency(self) -> JRSimulationSpec:
        _check_square("C", self.C, self.n_nodes)
        _check_square("D", self.D, self.n_nodes)
        if any(value < 0 for row in self.D for value in row):
            raise ValueError("D (delays, ms) must be non-negative")
        if any(not math.isfinite(value) for value in self.node_params.values()):
            raise ValueError("node_params must be finite")
        if self.monitor_hz % self.output_fs != 0:
            raise ValueError("output_fs must divide monitor_hz exactly")
        if not _is_integer_ratio(self.monitor_period_ms, self.dt_ms):
            raise ValueError("dt_ms must give an integer number of steps per monitor period")
        return self

    @property
    def monitor_period_ms(self) -> float:
        return 1000.0 / self.monitor_hz

    @property
    def steps_per_monitor(self) -> int:
        return round(self.monitor_period_ms / self.dt_ms)

    @property
    def decimation(self) -> int:
        """Monitor-to-output rate ratio; resampling must anti-alias, not pick every N-th."""
        return self.monitor_hz // self.output_fs


class ObservationSpec(ContractModel):
    """Observation operator: q = gain * (v - baseline); y = R (L q + sensor noise).

    ``sensor_noise_std`` is absolute (in ``sensor_noise_units``), never rescaled to the
    per-condition signal RMS. ``mixing`` is [sensor][source] and required for
    ``schematic_mixed``; it is not accepted for ``source_native``/``identity_probe``.
    """

    schema_version: Literal["1.0"] = "1.0"
    kind: ObservationKind = "identity_probe"
    n_sensors: int = Field(default=32, ge=1, le=512)
    gain: float = 1.0
    gain_units: str = "A·m/mV"
    baseline: float = 0.0
    baseline_units: str = "mV"
    reference: ReferenceKind = "none"
    sensor_noise_std: float = Field(default=0.0, ge=0)
    sensor_noise_units: str = "V"
    mixing: list[list[float]] | None = None

    @model_validator(mode="after")
    def check_consistency(self) -> ObservationSpec:
        if not math.isfinite(self.gain) or self.gain == 0:
            raise ValueError("gain must be finite and non-zero")
        if not math.isfinite(self.baseline):
            raise ValueError("baseline must be finite")
        if self.kind == "schematic_mixed" and self.mixing is None:
            raise ValueError("schematic_mixed requires an explicit mixing matrix")
        if self.kind in ("source_native", "identity_probe") and self.mixing is not None:
            raise ValueError(f"{self.kind} does not take a mixing matrix")
        if self.mixing is not None:
            if len(self.mixing) != self.n_sensors:
                raise ValueError("mixing must have n_sensors rows ([sensor][source])")
            widths = {len(row) for row in self.mixing}
            if len(widths) != 1 or 0 in widths:
                raise ValueError("mixing rows must be non-empty and of equal length")
            if any(not math.isfinite(v) for row in self.mixing for v in row):
                raise ValueError("mixing must contain only finite values")
        return self


# --------------------------------------------------------------------------- metrics


class MetricSpec(ContractModel):
    id: str
    variant: str = Field(default="default", min_length=1)
    backend: str | None = None
    input_spaces: list[AnalysisSpace] = Field(default_factory=lambda: ["source", "sensor"])
    params: dict[str, Any] = Field(default_factory=dict)
    required: bool = True

    @field_validator("id")
    @classmethod
    def in_scope(cls, value: str) -> str:
        if value not in IN_SCOPE_METRIC_IDS:
            raise ValueError(f"metric id {value!r} is not one of the 29 in-scope IDs")
        return value

    @field_validator("input_spaces")
    @classmethod
    def non_empty_unique(cls, value: list[str]) -> list[str]:
        if not value or len(value) != len(set(value)):
            raise ValueError("input_spaces must be non-empty and unique")
        return value


def _coerce_values(value: Any) -> Any:
    """Validate a float64-compatible scalar or nested list; ``None`` marks a null entry."""
    if isinstance(value, np.ndarray):
        if value.dtype.kind not in "fiu":
            raise ValueError("values array must be real numeric (float64-compatible)")
        return value.astype(np.float64).tolist()
    if value is None:
        return None
    if isinstance(value, bool | np.bool_):
        raise ValueError("boolean is not a metric value")
    if isinstance(value, int | float | np.integer | np.floating):
        return float(value)
    if isinstance(value, list | tuple):
        return [_coerce_values(item) for item in value]
    raise ValueError(f"unsupported metric value type {type(value).__name__}")


class MetricResult(ContractModel):
    """One metric computation outcome (plan §3.5)."""

    schema_version: Literal["1.0"] = "1.0"
    metric_id: str
    status: MetricStatus
    reason_code: str | None = None
    message: str | None = None
    variant: str = "default"
    analysis_space: str | None = None
    units: str | None = None
    axes: list[str] = Field(default_factory=list)
    parameters: dict[str, Any] = Field(default_factory=dict)
    input_artifact_id: str | None = None
    backend: str | None = None
    backend_version: str | None = None
    n_samples: int | None = Field(default=None, ge=0)
    n_epochs: int | None = Field(default=None, ge=0)
    validity_flags: list[str] = Field(default_factory=list)
    values: Any = None
    artifact_ref: str | None = None
    diagnostics: dict[str, Any] = Field(default_factory=dict)

    @field_validator("values", mode="before")
    @classmethod
    def float64_compatible(cls, value: Any) -> Any:
        return _coerce_values(value)

    @model_validator(mode="after")
    def status_consistency(self) -> MetricResult:
        if self.status is MetricStatus.OK:
            if self.values is None and self.artifact_ref is None:
                raise ValueError("an ok result needs values or an artifact_ref")
        else:
            if not self.reason_code:
                raise ValueError("a non-ok result needs a reason_code")
            if self.values is not None or self.artifact_ref is not None:
                raise ValueError("a non-ok result must not carry values (no 0/empty stand-ins)")
        return self

    @classmethod
    def from_status(
        cls,
        metric_id: str,
        status: MetricStatus | str,
        reason_code: str,
        *,
        variant: str = "default",
        message: str | None = None,
        **fields: Any,
    ) -> MetricResult:
        """Build a value-less non-ok result."""
        return cls(
            metric_id=metric_id,
            status=MetricStatus(status),
            reason_code=reason_code,
            variant=variant,
            message=message,
            **fields,
        )


# --------------------------------------------------------------------------- benchmark


class BudgetSpec(ContractModel):
    max_tasks: int | None = Field(default=None, ge=1)
    max_runtime_s: float | None = Field(default=None, gt=0)
    max_disk_bytes: int | None = Field(default=None, ge=1)
    n_surrogates: int = Field(default=49, ge=0)
    n_bootstrap: int = Field(default=999, ge=0)


class BenchmarkSpec(ContractModel):
    schema_version: Literal["1.0"] = "1.0"
    question_preset: str = Field(min_length=1)
    factors: dict[str, list[Any]] = Field(default_factory=dict)
    held_fixed: dict[str, Any] = Field(default_factory=dict)
    seeds: list[int] = Field(min_length=1)
    metrics: list[MetricSpec] = Field(min_length=1)
    profile: ProfileKind = "core-comparison"
    budget: BudgetSpec = Field(default_factory=BudgetSpec)

    @model_validator(mode="after")
    def check_consistency(self) -> BenchmarkSpec:
        if any(seed < 0 for seed in self.seeds):
            raise ValueError("seeds must be non-negative")
        if len(set(self.seeds)) != len(self.seeds):
            raise ValueError("seeds must be unique")
        keys = [(m.id, m.variant) for m in self.metrics]
        if len(set(keys)) != len(keys):
            raise ValueError("metric (id, variant) pairs must be unique")
        for name, levels in self.factors.items():
            if not levels:
                raise ValueError(f"factor {name!r} needs at least one level")
            if name in self.held_fixed:
                raise ValueError(f"{name!r} cannot be both a factor and held fixed")
        return self


class ArtifactManifest(ContractModel):
    schema_version: Literal["1.0"] = "1.0"
    artifact_id: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    shape: list[int]
    dtype: str = "float64"
    units: str | None = None
    axes: list[str] = Field(default_factory=list)
    checksum: str = Field(pattern=r"^[0-9a-f]{64}$", description="sha256 hex digest")
    parents: list[str] = Field(default_factory=list)
    versions: dict[str, str] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @model_validator(mode="after")
    def check_consistency(self) -> ArtifactManifest:
        if any(dim < 0 for dim in self.shape):
            raise ValueError("shape dimensions must be non-negative")
        if self.axes and len(self.axes) != len(self.shape):
            raise ValueError("axes must name every dimension of shape")
        if self.artifact_id in self.parents:
            raise ValueError("an artifact cannot be its own parent")
        return self


class ContrastDefinition(ContractModel):
    metric_id: str
    variant: str = "default"
    analysis_space: str
    condition_a: str = Field(min_length=1)
    condition_b: str = Field(min_length=1)
    estimand: str = "paired_mean_difference"
    direction: Literal["b_minus_a"] = "b_minus_a"
    pairing: Literal["seed_paired", "independent"] = "seed_paired"
    feature: str | None = None

    @model_validator(mode="after")
    def distinct_conditions(self) -> ContrastDefinition:
        if self.condition_a == self.condition_b:
            raise ValueError("a contrast needs two different conditions")
        return self


class PerSeedValue(ContractModel):
    seed: int = Field(ge=0)
    value_a: float | None = None
    value_b: float | None = None
    difference: float | None = None


class ComparisonResult(ContractModel):
    """Effect between two conditions; the independent unit is the simulation seed."""

    schema_version: Literal["1.0"] = "1.0"
    contrast: ContrastDefinition
    status: MetricStatus = MetricStatus.OK
    reason_code: str | None = None
    independent_n: int = Field(ge=0)
    estimate: float | None = None
    ci_low: float | None = None
    ci_high: float | None = None
    ci_level: float = Field(default=0.95, gt=0, lt=1)
    null_family: str | None = None
    test_family: str | None = None
    p_value: float | None = Field(default=None, ge=0, le=1)
    per_seed_values: list[PerSeedValue] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_consistency(self) -> ComparisonResult:
        if self.status is MetricStatus.OK and self.estimate is None:
            raise ValueError("an ok comparison needs an estimate")
        if self.status is not MetricStatus.OK:
            if not self.reason_code:
                raise ValueError("a non-ok comparison needs a reason_code")
            if self.estimate is not None:
                raise ValueError("a non-ok comparison must not carry an estimate")
        if (self.ci_low is None) != (self.ci_high is None):
            raise ValueError("ci_low and ci_high must be given together")
        if self.ci_low is not None and self.ci_high is not None and self.ci_low > self.ci_high:
            raise ValueError("ci_low must not exceed ci_high")
        seeds = [item.seed for item in self.per_seed_values]
        if len(set(seeds)) != len(seeds):
            raise ValueError("per_seed_values must have unique seeds")
        if self.per_seed_values and self.independent_n > len(self.per_seed_values):
            raise ValueError("independent_n cannot exceed the number of per-seed values")
        return self


# --------------------------------------------------------------------------- jobs


class TaskCounts(ContractModel):
    total: int = Field(default=0, ge=0)
    completed: int = Field(default=0, ge=0)
    failed: int = Field(default=0, ge=0)
    skipped: int = Field(default=0, ge=0)
    reused: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def bounded(self) -> TaskCounts:
        if self.completed + self.failed + self.skipped + self.reused > self.total:
            raise ValueError("completed + failed + skipped + reused cannot exceed total")
        return self


class JobFailure(ContractModel):
    task_id: str
    reason_code: str = Field(min_length=1)
    message: str | None = None


class JobManifest(ContractModel):
    schema_version: Literal["1.0"] = "1.0"
    job_id: str = Field(min_length=1)
    experiment_id: str = Field(min_length=1)
    state: JobState = "queued"
    stage: str | None = None
    tasks: TaskCounts = Field(default_factory=TaskCounts)
    completed_artifact_ids: list[str] = Field(default_factory=list)
    failures: list[JobFailure] = Field(default_factory=list)
    cancel_requested: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @model_validator(mode="after")
    def check_consistency(self) -> JobManifest:
        if self.state == "completed" and self.tasks.failed:
            raise ValueError("a job with failed tasks cannot be 'completed'")
        return self
