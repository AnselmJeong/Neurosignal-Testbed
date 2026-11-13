"""Educational information-flow pipeline on simulated 32-channel resting EEG.

Steps (one call of :func:`run_flow_pipeline`)::

    recipe ──► simulate (TVB Jansen-Rit, known directed motif graph, coupled G>0 + G=0 control)
           ──► observe (source_native, and 32-channel eeg_forward per reference)
           ──► preprocess (linear detrend, light high-pass, optional anti-aliased decimation)
           ──► analyse each dataset (GC pairwise/conditional/time-reversed, Gaussian TE,
               KSG TE on declared pairs, linear effective model + model comparison,
               activity flow mapping, time-lagged PID, Level-2 status)
           ──► freeze analysis results (sha256)  ──► truth-aware evaluation (source space only)
           ──► atomic JSON (+ arrays in the ArtifactStore when ``root`` is given)

Truth isolation: :func:`analyze_dataset` receives data, a sampling rate, channel names and a
truth-free :class:`AnalysisPlan` (node groups and hypotheses named in the recipe). The
generating coupling matrix ``C`` is used only by :func:`simulate_conditions` and, after the
analysis payload is frozen, by :func:`neurobridge.flow.evaluation.evaluate_flow`.

Preprocessing note: GC/TE are distorted by strong band-pass filtering, so only a linear
detrend, a 2nd-order zero-phase high-pass (default 0.5 Hz) and an anti-aliased decimation
(default 256 → 128 Hz, so the 8 ms coupling delay is ~1 sample and VAR orders stay short)
are applied. Activity flow computes its own band envelope (see ``flow.activity_flow``).
"""

from __future__ import annotations

import copy
import hashlib
import json
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator
from scipy import signal

from neurobridge.benchmarks.contracts import JRSimulationSpec, MetricStatus, ObservationSpec
from neurobridge.benchmarks.contracts import SeedTree as _SeedTree
from neurobridge.flow import activity_flow as af_mod
from neurobridge.flow import concepts as concepts_mod
from neurobridge.flow import effective as eff_mod
from neurobridge.flow import granger
from neurobridge.flow import pid as pid_mod
from neurobridge.flow import transfer_entropy as te_mod
from neurobridge.forward import observation as obs_mod
from neurobridge.simulation import tvb_jr

RESULT_SCHEMA_VERSION = "1.0"
RESULT_FILENAME = "flow_result.json"
EXAMPLE_TRACE_S = 4.0

# --------------------------------------------------------------------------- recipe


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FlowNode(_Model):
    id: str = Field(min_length=1, max_length=16)
    label: str = ""
    role: str = ""


class FlowGraph(_Model):
    """Ground-truth directed graph. ``edges`` are ``(source, target)`` node ids."""

    nodes: list[FlowNode] = Field(min_length=2, max_length=16)
    edges: list[tuple[str, str]] = Field(default_factory=list)
    weight: float = Field(default=1.0, gt=0)
    delay_ms: float = Field(default=8.0, ge=0)
    normalize_rows: bool = Field(
        default=True, description="each node's total incoming weight is 1 (rows with no input 0)"
    )

    @model_validator(mode="after")
    def check(self) -> FlowGraph:
        ids = [n.id for n in self.nodes]
        if len(set(ids)) != len(ids):
            raise ValueError("node ids must be unique")
        if len(set(self.edges)) != len(self.edges):
            raise ValueError("duplicate edge")
        for s, t in self.edges:
            if s not in ids or t not in ids:
                raise ValueError(f"edge {s}->{t} references an unknown node")
            if s == t:
                raise ValueError("self loops are not allowed")
        return self

    @property
    def node_names(self) -> list[str]:
        return [n.id for n in self.nodes]

    def coupling_matrix(self) -> np.ndarray:
        """``C[target, source]`` (row-normalised when ``normalize_rows``)."""
        index = {name: i for i, name in enumerate(self.node_names)}
        n = len(index)
        C = np.zeros((n, n))
        for s, t in self.edges:
            C[index[t], index[s]] = self.weight
        if self.normalize_rows:
            sums = C.sum(axis=1, keepdims=True)
            np.divide(C, sums, out=C, where=sums > 0)
        return C

    def delay_matrix(self) -> np.ndarray:
        return np.where(self.coupling_matrix() > 0, self.delay_ms, 0.0)


class SimulationSettings(_Model):
    G: float = Field(default=10.0, gt=0, description="coupled condition")
    control_G: float = Field(default=0.0, ge=0, description="control condition (0 = no coupling)")
    duration_s: float = Field(default=60.0, gt=0)
    burn_in_s: float = Field(default=5.0, ge=0)
    seed: int = Field(default=7, ge=0)
    output_fs: int = Field(default=256, gt=0)


class ObservationSettings(_Model):
    n_sensors: int = Field(default=32, ge=2, le=128)
    references: list[Literal["none", "average"]] = Field(default_factory=lambda: ["none"])
    sensor_noise_std: float = Field(
        default=25.0,
        ge=0,
        description="absolute white sensor noise [V]; >0 keeps the 32-channel data full rank",
    )
    gain: float = 1.0
    include_source_native: bool = True


class PreprocessSettings(_Model):
    detrend: bool = True
    highpass_hz: float | None = Field(default=0.5, gt=0)
    highpass_order: int = Field(default=2, ge=1, le=4)
    highpass_phase: Literal["causal", "zero_phase"] = Field(
        default="causal",
        description="'causal' = one forward pass (sosfilt); 'zero_phase' = sosfiltfilt, kept "
        "as an option because it inflated G=0 GC false positives in this preset",
    )
    highpass_settle_s: float = Field(
        default=2.0, ge=0, description="samples discarded after a causal high-pass (transient)"
    )
    decimate: int = Field(default=2, ge=1, le=8)


class GCSettings(_Model):
    criterion: Literal["bic", "aic"] = "bic"
    max_order: int = Field(default=12, ge=1, le=40)
    min_obs_per_param: float = Field(default=10.0, gt=0)
    pairwise_order: Literal["conditional", "per_pair"] = Field(
        default="conditional",
        description="'conditional': reuse the order selected on the full VAR (fast, common "
        "order); 'per_pair': select an order per unordered pair",
    )
    time_reversed: bool = True


class TESettings(_Model):
    k_hist: int = Field(default=2, ge=1, le=10)
    l_hist: int = Field(default=2, ge=1, le=10)
    lag: int = Field(default=1, ge=1, le=20)
    ksg: bool = True
    k_neighbors: int = Field(default=4, ge=1, le=20)
    theiler: int = Field(default=0, ge=0)
    n_surrogates: int = Field(default=0, ge=0, le=999)
    seed: int = Field(default=0, ge=0)


class EffectiveSettings(_Model):
    lowpass_hz: float | None = Field(default=None, gt=0)
    # VAR lag order of the candidate models. ``None`` = choose by BIC on each motif
    # (oscillating JR nodes need several lags; a VAR(1) favours spurious edges).
    order: int | None = Field(default=None, ge=1, le=30)
    max_order: int = Field(default=20, ge=1, le=40)
    whiteness_lags: int = Field(default=20, ge=2)


class ActivityFlowSettings(_Model):
    activity: Literal["envelope", "raw"] = "envelope"
    band: tuple[float, float] = (5.0, 13.0)
    train_fraction: float = Field(default=0.6, gt=0, lt=1)
    gap_s: float = Field(default=1.0, ge=0)
    ridge_alpha: float = Field(default=1.0, gt=0)
    neighbor_radius_m: float = Field(default=0.05, gt=0)


class PIDSettings(_Model):
    lag: int = Field(default=1, ge=1)
    history: int = Field(default=2, ge=1, le=10)
    teaching_examples: bool = True


class MethodSettings(_Model):
    alpha: float = Field(default=0.05, gt=0, lt=1)
    gc: GCSettings = Field(default_factory=GCSettings)
    te: TESettings = Field(default_factory=TESettings)
    effective: EffectiveSettings = Field(default_factory=EffectiveSettings)
    activity_flow: ActivityFlowSettings = Field(default_factory=ActivityFlowSettings)
    pid: PIDSettings = Field(default_factory=PIDSettings)


class ModelComparisonSpec(_Model):
    """Hypothesis set for one node pair; 'forward' means ``nodes[0] -> nodes[1]``."""

    name: str
    nodes: tuple[str, str]
    driver: str | None = None


class PIDTripletSpec(_Model):
    name: str
    sources: tuple[str, str]
    target: str


class AnalysisPlanSpec(_Model):
    """Analyst's hypotheses: node groups and tests. Never contains the edge list / C."""

    motifs: dict[str, list[str]] = Field(default_factory=dict)
    control_pairs: list[tuple[str, str]] = Field(default_factory=list)
    model_comparisons: list[ModelComparisonSpec] = Field(default_factory=list)
    pid_triplets: list[PIDTripletSpec] = Field(default_factory=list)

    def referenced_nodes(self) -> set[str]:
        names = {n for group in self.motifs.values() for n in group}
        names |= {n for pair in self.control_pairs for n in pair}
        for mc in self.model_comparisons:
            names |= set(mc.nodes) | ({mc.driver} if mc.driver else set())
        for tr in self.pid_triplets:
            names |= set(tr.sources) | {tr.target}
        return names


class FlowRecipe(_Model):
    recipe_version: Literal["1.0"] = "1.0"
    kind: Literal["flow-pipeline"] = "flow-pipeline"
    title: str = "information-flow pipeline"
    profile: Literal["preview", "full"] = "preview"
    status: str = "unvalidated_starting_values"
    notes: list[str] = Field(default_factory=list)
    graph: FlowGraph
    simulation: SimulationSettings = Field(default_factory=SimulationSettings)
    observation: ObservationSettings = Field(default_factory=ObservationSettings)
    preprocessing: PreprocessSettings = Field(default_factory=PreprocessSettings)
    methods: MethodSettings = Field(default_factory=MethodSettings)
    analysis: AnalysisPlanSpec = Field(default_factory=AnalysisPlanSpec)

    @model_validator(mode="after")
    def check_plan_nodes(self) -> FlowRecipe:
        unknown = self.analysis.referenced_nodes() - set(self.graph.node_names)
        if unknown:
            raise ValueError(f"analysis references unknown nodes: {sorted(unknown)}")
        for mc in self.analysis.model_comparisons:
            if mc.nodes[0] == mc.nodes[1] or mc.driver in mc.nodes:
                raise ValueError(f"model comparison {mc.name!r} needs distinct nodes")
        for tr in self.analysis.pid_triplets:
            if len({*tr.sources, tr.target}) != 3:
                raise ValueError(f"PID triplet {tr.name!r} needs three distinct nodes")
        return self


def load_recipe(recipe: FlowRecipe | Mapping[str, Any] | str | Path) -> FlowRecipe:
    if isinstance(recipe, FlowRecipe):
        return recipe
    if isinstance(recipe, str | Path):
        return FlowRecipe.model_validate_json(Path(recipe).read_text(encoding="utf-8"))
    return FlowRecipe.model_validate(recipe)


# --------------------------------------------------------------------------- JSON helpers


def to_jsonable(obj: Any) -> Any:
    """Numpy/pydantic -> plain JSON values; NaN/inf -> None (never 0)."""
    if isinstance(obj, BaseModel):
        return to_jsonable(obj.model_dump())
    if isinstance(obj, Mapping):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, np.ndarray):
        return to_jsonable(obj.tolist())
    if isinstance(obj, list | tuple | set | frozenset):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, np.bool_ | bool):
        return bool(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, float | np.floating):
        value = float(obj)
        return value if np.isfinite(value) else None
    if isinstance(obj, MetricStatus):
        return obj.value
    return obj


def payload_sha256(payload: Any) -> str:
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- simulation


@dataclass
class ConditionData:
    name: str
    G: float
    v: np.ndarray  # (n_nodes, n_times) mV
    fs: float
    metadata: dict[str, Any] = field(default_factory=dict)


def simulate_conditions(recipe: FlowRecipe) -> list[ConditionData]:
    """Coupled (G>0) and control (G=control_G) runs sharing seeds and input noise."""
    sim = recipe.simulation
    C = recipe.graph.coupling_matrix()
    base = JRSimulationSpec(
        preset="flow-motif",
        n_nodes=C.shape[0],
        C=C.tolist(),
        D=recipe.graph.delay_matrix().tolist(),
        G=sim.G,
        duration_s=sim.duration_s,
        burn_in_s=sim.burn_in_s,
        output_fs=sim.output_fs,
        seeds=_SeedTree(root=sim.seed),
    )
    out = []
    for name, G in (("coupled", sim.G), ("control", sim.control_G)):
        res = tvb_jr.simulate_jr(tvb_jr.with_coupling(base, G))
        meta = {
            "G": G,
            "integration_wall_s": res.metadata.get("integration_wall_s"),
            "tvb_version": res.metadata.get("tvb_version"),
            "psd_peak_hz": tvb_jr.psd_peak_hz(res.v, res.fs).tolist(),
            "std_mV": res.v.std(axis=1).tolist(),
            "mean_mV": res.v.mean(axis=1).tolist(),
        }
        out.append(ConditionData(name=name, G=G, v=res.v, fs=res.fs, metadata=meta))
    return out


# --------------------------------------------------------------------------- preprocessing


def preprocess(
    x: np.ndarray, fs: float, settings: PreprocessSettings
) -> tuple[np.ndarray, float, dict[str, Any]]:
    data = np.array(x, dtype=np.float64, copy=True)
    steps: list[str] = []
    if settings.detrend:
        data = signal.detrend(data, axis=1, type="linear")
        steps.append("linear detrend per channel (scipy.signal.detrend)")
    if settings.highpass_hz is not None:
        sos = signal.butter(
            settings.highpass_order, settings.highpass_hz, btype="highpass", fs=fs, output="sos"
        )
        label = f"Butterworth high-pass {settings.highpass_hz} Hz, order {settings.highpass_order}"
        if settings.highpass_phase == "zero_phase":
            data = signal.sosfiltfilt(sos, data, axis=1)
            steps.append(
                f"{label}, zero-phase (sosfiltfilt). WARNING: non-causal filtering mixes the "
                "future into the past; in the preview preset it raised source-space G=0 "
                "conditional-GC false positives from 3/56 to 35/56"
            )
        else:
            zi = signal.sosfilt_zi(sos)[:, None, :] * data[None, :, :1]
            data, _ = signal.sosfilt(sos, data, axis=1, zi=zi)
            settle = int(round(settings.highpass_settle_s * fs))
            data = data[:, settle:]
            steps.append(
                f"{label}, causal (sosfilt, one forward pass), first "
                f"{settings.highpass_settle_s:g} s discarded as filter transient"
            )
        steps.append("no band-pass: GC/TE are distorted by strong or non-causal filtering")
    fs_out = float(fs)
    if settings.decimate > 1:
        data = signal.decimate(data, settings.decimate, axis=1, zero_phase=True)
        fs_out = fs / settings.decimate
        steps.append(
            f"anti-aliased decimation x{settings.decimate} (scipy.signal.decimate, IIR order 8, "
            f"zero-phase): {fs:g} -> {fs_out:g} Hz"
        )
    data = data - data.mean(axis=1, keepdims=True)
    steps.append("per-channel demean (no z-scoring; KSG standardises internally)")
    return np.ascontiguousarray(data), fs_out, {"steps": steps, "sfreq_out": fs_out}


# --------------------------------------------------------------------------- plan / display


@dataclass(frozen=True)
class AnalysisPlan:
    """Truth-free analysis plan: which channels play which hypothesised node roles."""

    spec: AnalysisPlanSpec
    methods: MethodSettings
    node_channels: dict[str, int]  # node name -> channel index in this dataset

    def ksg_pairs(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Both directions of every within-motif pair plus control pairs (direction-agnostic)."""
        wanted: list[tuple[str, str]] = []
        for group in self.spec.motifs.values():
            for a in group:
                for b in group:
                    if a != b and (a, b) not in wanted:
                        wanted.append((a, b))
        for a, b in self.spec.control_pairs:
            for pair in ((a, b), (b, a)):
                if pair not in wanted:
                    wanted.append(pair)
        pairs, skipped = [], []
        seen: set[tuple[int, int]] = set()
        for a, b in wanted:
            s, t = self.node_channels[a], self.node_channels[b]
            item = {"source_node": a, "target_node": b, "source": s, "target": t}
            if s == t:
                skipped.append({**item, "reason_code": "same_display_channel"})
            elif (s, t) in seen:
                skipped.append({**item, "reason_code": "duplicate_channel_pair"})
            else:
                seen.add((s, t))
                pairs.append(item)
        return pairs, skipped


def display_channels(
    node_names: list[str],
    source_positions: np.ndarray,
    sensor_positions: np.ndarray,
    channel_names: tuple[str, ...] | list[str],
) -> dict[str, Any]:
    """Nearest sensor per source (forward-model geometry; display only, never truth)."""
    dist = np.linalg.norm(source_positions[:, None, :] - sensor_positions[None, :, :], axis=-1)
    nearest = np.argmin(dist, axis=1)
    mapping = {
        name: {
            "channel_index": int(nearest[i]),
            "channel": str(channel_names[nearest[i]]),
            "distance_m": float(dist[i, nearest[i]]),
        }
        for i, name in enumerate(node_names)
    }
    duplicates = len(set(nearest.tolist())) < len(node_names)
    return {
        "mapping": mapping,
        "has_duplicate_channels": duplicates,
        "note": (
            "센서 채널은 소스가 아닙니다. 각 소스에 가장 가까운 전극은 표시·가설 검정 위치로만 "
            "쓰이며 "
            "정답(precision/recall)으로 쓰이지 않습니다."
        ),
    }


# --------------------------------------------------------------------------- method results


def _status_value(status: str | MetricStatus) -> str:
    value = status.value if isinstance(status, MetricStatus) else str(status)
    return value if value in {s.value for s in MetricStatus} else MetricStatus.INVALID_INPUT.value


def method_result(
    method_id: str,
    status: str | MetricStatus,
    *,
    reason_code: str | None = None,
    message: str | None = None,
    **fields: Any,
) -> dict[str, Any]:
    concept = concepts_mod.concept_for_method(method_id)
    status_value = _status_value(status)
    if status_value != "ok" and not reason_code:
        reason_code = "unspecified"
    out = {
        "method_id": method_id,
        "concept_id": concept.id,
        "flow_id": concept.flow_id,
        "related_metric_id": concept.related_metric_id,
        "status": status_value,
        "reason_code": reason_code,
        "message": message,
    }
    if status_value != "ok":
        fields = {k: v for k, v in fields.items() if k not in ("values", "p_values")}
    out.update(fields)
    return out


def _guarded(method_id: str, fn: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        result = fn()
    except Exception as exc:  # noqa: BLE001 - every failure becomes an explained status
        result = method_result(
            method_id, MetricStatus.FAILED, reason_code=type(exc).__name__, message=str(exc)
        )
    result["wall_s"] = time.perf_counter() - started
    return result


def _n_sig(p: np.ndarray | None, alpha: float) -> dict[str, Any]:
    if p is None:
        return {}
    finite = p[np.isfinite(p)]
    m = int(finite.size)
    if m == 0:
        return {"n_tested": 0}
    threshold = alpha / m
    return {
        "n_tested": m,
        "alpha": alpha,
        "bonferroni_threshold": threshold,
        "n_significant_bonferroni": int(np.sum(finite <= threshold)),
        "n_significant_uncorrected": int(np.sum(finite <= alpha)),
    }


def _gc_payload(method_id: str, res: granger.GrangerResult, alpha: float, **extra) -> dict:
    if not res.ok:
        return method_result(
            method_id,
            res.status,
            reason_code=res.reason_code,
            message=res.message,
            diagnostics=res.diagnostics,
        )
    diag = dict(res.diagnostics)
    var = diag.get("var")
    if isinstance(var, Mapping):
        white = var.get("whiteness") or {}
        diag["var"] = {k: v for k, v in var.items() if k != "whiteness"}
        diag["var"]["whiteness_summary"] = {
            k: v for k, v in white.items() if not isinstance(v, list | np.ndarray)
        }
    return method_result(
        method_id,
        "ok",
        units=res.units,
        axes=["target", "source"],
        values=res.gc,
        p_values=res.p_values,
        order=res.order,
        order_matrix=res.order_matrix,
        significance=_n_sig(res.p_values, alpha),
        diagnostics=diag,
        **extra,
    )


def _run_gc(x: np.ndarray, settings: MethodSettings) -> dict[str, dict[str, Any]]:
    gc = settings.gc
    out: dict[str, dict[str, Any]] = {}
    cond_holder: dict[str, granger.GrangerResult] = {}

    def conditional() -> dict[str, Any]:
        res = granger.conditional_gc(
            x, gc.criterion, max_order=gc.max_order, min_obs_per_param=gc.min_obs_per_param
        )
        cond_holder["res"] = res
        return _gc_payload(
            "gc_conditional", res, settings.alpha, conditioning="all other observed channels"
        )

    out["gc_conditional"] = _guarded("gc_conditional", conditional)
    cond = cond_holder.get("res")
    common_order = cond.order if cond is not None and cond.ok else None

    def pairwise() -> dict[str, Any]:
        use_common = gc.pairwise_order == "conditional" and common_order is not None
        order: Any = common_order if use_common else gc.criterion
        res = granger.pairwise_gc(
            x, order, max_order=gc.max_order, min_obs_per_param=gc.min_obs_per_param
        )
        note = (
            f"common order {common_order} selected by {gc.criterion.upper()} on the full VAR"
            if use_common
            else f"order selected per unordered pair by {gc.criterion.upper()}"
        )
        return _gc_payload("gc_pairwise", res, settings.alpha, order_policy=note)

    out["gc_pairwise"] = _guarded("gc_pairwise", pairwise)

    def reversed_() -> dict[str, Any]:
        if not gc.time_reversed:
            return method_result(
                "gc_time_reversed",
                MetricStatus.NOT_APPLICABLE,
                reason_code="disabled_in_recipe",
                message="methods.gc.time_reversed is false",
            )
        if common_order is None:
            return method_result(
                "gc_time_reversed",
                cond.status if cond is not None else MetricStatus.FAILED,
                reason_code="conditional_gc_unavailable",
                message="time reversal reuses the conditional GC order, which is unavailable"
                + (f" ({cond.reason_code}: {cond.message})" if cond is not None else ""),
            )
        res = granger.time_reversed_gc(x, common_order, mode="conditional")
        if res.status != "ok":
            return method_result(
                "gc_time_reversed", res.status, reason_code=res.reason_code, message=res.message
            )
        assert res.reversed is not None and res.reversed.gc is not None
        return method_result(
            "gc_time_reversed",
            "ok",
            units=granger.GC_UNITS,
            axes=["target", "source"],
            values=res.net,
            reversed_gc=res.reversed.gc,
            dominance_forward=res.dominance_forward,
            dominance_reversed=res.dominance_reversed,
            order=common_order,
            mode="conditional",
            reading=(
                "net = GC(forward) - GC(time-reversed). 진짜 지연 상호작용은 시간 역전 시 우세 "
                "방향 "
                "D = G - G^T의 부호가 바뀌고, 순간 혼합(볼륨 전도)은 순·역방향 GC가 비슷해 "
                "net≈0입니다."
            ),
        )

    out["gc_time_reversed"] = _guarded("gc_time_reversed", reversed_)
    out["_common_order"] = {"order": common_order}  # internal, popped by caller
    return out


def _run_te_gaussian(x: np.ndarray, settings: MethodSettings, gc_order: int | None) -> dict:
    te = settings.te
    res = te_mod.te_matrix(x, estimator="gaussian", k_hist=te.k_hist, l_hist=te.l_hist, lag=te.lag)
    failures = res["failures"]
    n = x.shape[0]
    if len(failures) == n * (n - 1):
        first = next(iter(failures.values()))
        return method_result(
            "te_gaussian",
            first["status"],
            reason_code=first["reason_code"],
            message=first["message"],
            failures=failures,
        )
    identity: dict[str, Any] = {"status": "not_applicable", "reason": "no common GC order"}
    if gc_order is not None:
        te_k = te_mod.gaussian_te(x, 0, 1, k_hist=gc_order, l_hist=gc_order, lag=1)
        gc_pair = granger.pairwise_gc(x, gc_order, pairs=[(0, 1)])
        if te_k.ok and gc_pair.ok and gc_pair.gc is not None:
            identity = {
                "status": "ok",
                "pair": "channel 0 -> channel 1",
                "order": gc_order,
                "gaussian_te_k_eq_l_eq_order": te_k.te,
                "half_pairwise_gc": 0.5 * float(gc_pair.gc[1, 0]),
                "note": "선형 Gaussian 과정에서 TE = GC/2 (같은 차수, lag 1).",
            }
    return method_result(
        "te_gaussian",
        "ok",
        units=te_mod.TE_UNITS,
        axes=["target", "source"],
        values=res["te"],
        values_bits=res["te"] * te_mod.NATS_TO_BITS,
        p_values=res["p_values"],
        p_value_method=res["p_value_method"],
        significance=_n_sig(res["p_values"], settings.alpha),
        parameters={"k_hist": te.k_hist, "l_hist": te.l_hist, "lag": te.lag},
        failures=failures,
        n_samples=res["n_samples"],
        gc_te_identity=identity,
    )


def _run_te_ksg(x: np.ndarray, plan: AnalysisPlan) -> dict:
    te = plan.methods.te
    if not te.ksg:
        return method_result(
            "te_ksg",
            MetricStatus.NOT_APPLICABLE,
            reason_code="disabled_in_recipe",
            message="methods.te.ksg is false",
        )
    pairs, skipped = plan.ksg_pairs()
    if not pairs:
        return method_result(
            "te_ksg",
            MetricStatus.NOT_APPLICABLE,
            reason_code="no_declared_pairs",
            message="no distinct channel pairs in the analysis plan",
            skipped_pairs=skipped,
        )
    res = te_mod.te_matrix(
        x,
        [(p["source"], p["target"]) for p in pairs],
        estimator="ksg",
        k_hist=te.k_hist,
        l_hist=te.l_hist,
        lag=te.lag,
        n_surrogates=te.n_surrogates,
        k_neighbors=te.k_neighbors,
        theiler=te.theiler,
        seed=te.seed,
    )
    if len(res["failures"]) == len(pairs):
        first = next(iter(res["failures"].values()))
        return method_result(
            "te_ksg",
            first["status"],
            reason_code=first["reason_code"],
            message=first["message"],
            failures=res["failures"],
        )
    tested = []
    for p in pairs:
        s, t = p["source"], p["target"]
        tested.append(
            {
                **p,
                "te": res["te"][t, s],
                "p_value": res["p_values"][t, s],
                "null_mean": res["null_mean"][t, s],
            }
        )
    flags = ["ksg_finite_sample_bias_uncorrected"]
    if te.n_surrogates == 0:
        flags.append("no_surrogate_test")
    return method_result(
        "te_ksg",
        "ok",
        units=te_mod.TE_UNITS,
        axes=["target", "source"],
        values=res["te"],
        p_values=res["p_values"],
        p_value_method=res["p_value_method"],
        pairs=tested,
        skipped_pairs=skipped,
        failures=res["failures"],
        parameters={
            "k_hist": te.k_hist,
            "l_hist": te.l_hist,
            "lag": te.lag,
            "k_neighbors": te.k_neighbors,
            "theiler": te.theiler,
            "n_surrogates": te.n_surrogates,
        },
        flags=flags,
        bias_note=te_mod.KSG_BIAS_NOTE,
        pair_selection=(
            "모티프 노드 그룹 안의 모든 순서쌍(양방향) + 대조 쌍. 방향 정답을 쓰지 않고 "
            "선택했습니다."
        ),
    )


def _run_effective(x: np.ndarray, sfreq: float, plan: AnalysisPlan) -> dict:
    eff = plan.methods.effective
    dt = 1.0 / sfreq
    fit = eff_mod.fit_linear_state_space(x, dt, lowpass_hz=eff.lowpass_hz)
    comparisons = []
    for mc in plan.spec.model_comparisons:
        a, b = (plan.node_channels[n] for n in mc.nodes)
        driver = plan.node_channels[mc.driver] if mc.driver else None
        entry: dict[str, Any] = {
            "name": mc.name,
            "nodes": list(mc.nodes),
            "driver_node": mc.driver,
            "channels": [a, b],
            "driver_channel": driver,
            "hypothesis_labels": {
                "forward": f"{mc.nodes[0]} -> {mc.nodes[1]}",
                "backward": f"{mc.nodes[1]} -> {mc.nodes[0]}",
                "bidirectional": "both directions",
                "none": "no directed edge",
                "common_input": (
                    f"{mc.driver} -> {{{mc.nodes[0]}, {mc.nodes[1]}}}"
                    if mc.driver
                    else "correlated innovations (unobserved common input)"
                ),
            },
        }
        sub = [a, b] if driver is None else [driver, a, b]
        if len(set(sub)) != len(sub):
            entry.update(
                status=MetricStatus.NOT_APPLICABLE.value,
                reason_code="same_display_channel",
                message="two hypothesised nodes map to the same channel",
            )
            comparisons.append(entry)
            continue
        offset = 0 if driver is None else 1
        cands = eff_mod.standard_candidates(
            len(sub), offset, offset + 1, driver=None if driver is None else 0
        )
        order = eff.order
        order_info: dict[str, Any] = {"source": "recipe"} if order else {}
        if order is None:
            sel = granger.select_order(x[sub], max_order=eff.max_order, criterion="bic")
            order = sel.order if sel.status == "ok" and sel.order else 1
            order_info = {"source": "bic", "selection_status": sel.status}
        mcmp = eff_mod.compare_linear_models(
            x[sub], dt, cands, lowpass_hz=eff.lowpass_hz, order=order
        )
        entry["var_order"] = order
        entry["var_order_selection"] = order_info
        whiteness: dict[str, Any] = {}
        try:
            var1 = granger.fit_var(x[sub], order, whiteness_lags=eff.whiteness_lags)
            whiteness = {
                k: v for k, v in var1.whiteness.items() if not isinstance(v, list | np.ndarray)
            }
        except ValueError as exc:
            whiteness = {"status": "failed", "reason": str(exc)}
        entry.update(
            status=_status_value("ok" if mcmp.status == "ok" else "invalid_input"),
            reason_code=None if mcmp.status == "ok" else "ineligible",
            message=mcmp.reason,
            best_model=mcmp.best_model,
            question=mcmp.question,
            models=[
                {
                    "name": m.name,
                    "status": m.status,
                    "reason": m.reason,
                    "posterior": m.posterior,
                    "bic": m.bic,
                    "aic": m.aic,
                    "log_likelihood": m.log_likelihood,
                    "n_params": m.n_params,
                    "shared_noise": m.shared_noise,
                    "A_discrete": m.A_discrete,
                }
                for m in mcmp.models
            ],
            var1_residual_whiteness=whiteness,
        )
        comparisons.append(entry)
    misspec = [
        c["name"]
        for c in comparisons
        if (c.get("var1_residual_whiteness", {}).get("fraction_rejected_at_0.05") or 0) > 0
    ]
    if fit.status != "ok":
        return method_result(
            "effective_model",
            MetricStatus.INSUFFICIENT_DATA
            if "too few samples" in (fit.reason or "")
            else MetricStatus.INVALID_INPUT,
            reason_code="ineligible",
            message=fit.reason,
            comparisons=comparisons,
            method_note=fit.method_note,
        )
    return method_result(
        "effective_model",
        "ok",
        units="1/s",
        axes=["target", "source"],
        values=fit.A,
        A_discrete=fit.A_discrete,
        conversion=fit.conversion,
        conversion_reason=fit.conversion_reason,
        stable=fit.stable,
        discrete_spectral_radius=fit.discrete_spectral_radius,
        preprocessing=fit.preprocessing,
        comparisons=comparisons,
        # Flag name kept for API compatibility; it also covers VAR(p) comparisons.
        flags=(["var1_residuals_not_white"] if misspec else []),
        misspecified_comparisons=misspec,
        method_note=fit.method_note,
    )


def _af_summary(res: af_mod.ActivityFlowResult, sfreq: float) -> dict[str, Any]:
    n_ex = int(EXAMPLE_TRACE_S * sfreq)
    return {
        "best_method": res.best_method,
        "comparison": res.comparison,
        "predictions": {
            name: {
                "mean_r": p.mean_r,
                "mean_r2": p.mean_r2,
                "r": p.r,
                "r2": p.r2,
                "channel_status": p.channel_status,
                "fc": p.fc,
            }
            for name, p in res.predictions.items()
        },
        "train_samples": res.train_samples,
        "test_samples": res.test_samples,
        "gap_samples": res.gap_samples,
        "example_channel": res.example_channel,
        "example_actual": None if res.example_actual is None else res.example_actual[:n_ex],
        "example_predicted": {k: v[:n_ex] for k, v in res.example_predicted.items()},
        "n_excluded_predictors": None
        if res.predictor_mask is None
        else int((~res.predictor_mask).sum() - res.predictor_mask.shape[0]),
    }


def _run_activity_flow(
    x: np.ndarray, sfreq: float, plan: AnalysisPlan, sensor_positions: np.ndarray | None
) -> dict:
    s = plan.methods.activity_flow
    kwargs = dict(
        activity=s.activity,
        band=tuple(s.band),
        train_fraction=s.train_fraction,
        gap_s=s.gap_s,
        ridge_alpha=s.ridge_alpha,
    )
    neighbors = None
    if sensor_positions is not None:
        neighbors = af_mod.neighbors_within_radius(sensor_positions, s.neighbor_radius_m)
    main = af_mod.run_activity_flow(x, sfreq, neighbors=neighbors, **kwargs)  # type: ignore[arg-type]
    if main.status != "ok":
        return method_result(
            "activity_flow",
            MetricStatus.INVALID_INPUT,
            reason_code="ineligible",
            message=main.reason,
            method_note=main.method_note,
        )
    extra: dict[str, Any] = {}
    if neighbors is not None:
        plain = af_mod.run_activity_flow(x, sfreq, **kwargs)  # type: ignore[arg-type]
        extra["without_neighbor_exclusion"] = (
            {"comparison": plain.comparison, "best_method": plain.best_method}
            if plain.status == "ok"
            else {"status": "invalid_input", "reason": plain.reason}
        )
    pearson = main.comparison.get("pearson", {})
    return method_result(
        "activity_flow",
        "ok",
        units="dimensionless (r, R²)",
        axes=["target", "source"],
        values=main.predictions["regression"].fc if "regression" in main.predictions else None,
        activity=main.activity,
        band=main.band,
        neighbor_exclusion=(
            {"radius_m": s.neighbor_radius_m, "excluded_matrix": neighbors}
            if neighbors is not None
            else None
        ),
        summary=_af_summary(main, sfreq),
        primary_score="r",
        score_note=(
            "Pearson FC 예측은 상관을 단순 합산해 크기가 어긋나므로 R²가 크게 음수일 수 있습니다; "
            f"r로 판단하세요 (이 데이터 Pearson mean R² = {pearson.get('mean_r2')})."
        ),
        method_note=main.method_note,
        **extra,
    )


def _run_pid(x: np.ndarray, plan: AnalysisPlan) -> dict:
    p = plan.methods.pid
    triplets = []
    for tr in plan.spec.pid_triplets:
        a, b = (plan.node_channels[n] for n in tr.sources)
        t = plan.node_channels[tr.target]
        entry: dict[str, Any] = {
            "name": tr.name,
            "source_nodes": list(tr.sources),
            "target_node": tr.target,
            "channels": {"source_a": a, "source_b": b, "target": t},
        }
        if len({a, b, t}) < 3:
            entry.update(
                status=MetricStatus.NOT_APPLICABLE.value,
                reason_code="same_display_channel",
                message="two PID variables map to the same channel",
            )
        else:
            res = pid_mod.time_lagged_pid(x, a, b, t, lag=p.lag, history=p.history)
            entry.update(res.model_dump())
        triplets.append(entry)
    if not triplets:
        return method_result(
            "pid",
            MetricStatus.NOT_APPLICABLE,
            reason_code="no_declared_triplets",
            message="analysis.pid_triplets is empty",
        )
    statuses = {_status_value(t["status"]) for t in triplets}
    if "ok" not in statuses:
        first = triplets[0]
        return method_result(
            "pid",
            first["status"],
            reason_code=first.get("reason_code") or "no_triplet_ok",
            message=first.get("message"),
            triplets=triplets,
        )
    return method_result(
        "pid",
        "ok",
        units="nats (bits alongside)",
        measure="mmi",
        parameters={"lag": p.lag, "history": p.history},
        triplets=triplets,
    )


def level2_status() -> dict[str, Any]:
    return method_result(
        "level2_content_decoding",
        MetricStatus.NOT_APPLICABLE,
        reason_code="no_stimulus_labels",
        message=(
            "Level 2(내용)는 자극/과제 라벨로 표현을 디코딩해야 측정됩니다. 휴지기 시뮬레이션에는 "
            "자극이 없으므로 계산하지 않습니다 (0이 아니라 '해당 없음')."
        ),
    )


def analyze_dataset(
    x: np.ndarray,
    sfreq: float,
    channel_names: list[str],
    plan: AnalysisPlan,
    *,
    sensor_positions: np.ndarray | None = None,
) -> dict[str, dict[str, Any]]:
    """Run every method on one preprocessed dataset. Never receives generation truth."""
    data = np.asarray(x, dtype=np.float64)
    methods: dict[str, dict[str, Any]] = {}
    gc = _run_gc(data, plan.methods)
    common_order = gc.pop("_common_order")["order"]
    methods.update(gc)
    methods["te_gaussian"] = _guarded(
        "te_gaussian", lambda: _run_te_gaussian(data, plan.methods, common_order)
    )
    methods["te_ksg"] = _guarded("te_ksg", lambda: _run_te_ksg(data, plan))
    methods["effective_model"] = _guarded(
        "effective_model", lambda: _run_effective(data, sfreq, plan)
    )
    methods["activity_flow"] = _guarded(
        "activity_flow", lambda: _run_activity_flow(data, sfreq, plan, sensor_positions)
    )
    methods["pid"] = _guarded("pid", lambda: _run_pid(data, plan))
    methods["level2_content_decoding"] = level2_status()
    return methods


# --------------------------------------------------------------------------- orchestration


def _artifact_slug(*parts: str) -> str:
    return "-".join(p.replace("/", "-").replace("_", "-") for p in parts)


def run_flow_pipeline(
    recipe: FlowRecipe | Mapping[str, Any] | str | Path,
    root: str | Path | None = None,
    *,
    run_id: str | None = None,
    progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Simulate → observe → preprocess → analyse → freeze → evaluate → save (if ``root``)."""
    from neurobridge.flow import evaluation  # local: evaluation imports this module

    rec = load_recipe(recipe)
    say = progress or (lambda _msg: None)
    timings: dict[str, float] = {}
    t0 = time.perf_counter()
    recipe_hash = payload_sha256(rec.model_dump(mode="json"))
    run_id = run_id or f"flow-{recipe_hash[:10]}-{uuid.uuid4().hex[:6]}"
    store = None
    if root is not None:
        from neurobridge.artifacts.store import ArtifactStore

        store = ArtifactStore(root)

    def put(artifact_id: str, array: Any, **kw: Any) -> str | None:
        if store is None:
            return None
        store.put_array(run_id, artifact_id, array, **kw)
        return artifact_id

    # 1. simulate (the only step besides evaluation that reads the graph / C)
    say("simulate: TVB Jansen-Rit coupled + control")
    conditions = simulate_conditions(rec)
    timings["simulate_s"] = time.perf_counter() - t0
    node_names = rec.graph.node_names
    for cond in conditions:
        put(f"{cond.name}-source-v", cond.v, kind="jr_source_v", units="mV", axes=["node", "time"])

    # 2. observe + 3. preprocess + 4. analyse
    seeds = _SeedTree(root=rec.simulation.seed)
    datasets: list[dict[str, Any]] = []
    sources_plan = AnalysisPlan(
        spec=rec.analysis,
        methods=rec.methods,
        node_channels={name: i for i, name in enumerate(node_names)},
    )
    display_info: dict[str, Any] | None = None
    preprocessing_record: dict[str, Any] | None = None
    t_an = time.perf_counter()
    for cond in conditions:
        views: list[tuple[str, str, obs_mod.ObservationResult]] = []
        if rec.observation.include_source_native:
            spec = ObservationSpec(kind="source_native", n_sensors=len(node_names))
            views.append(
                ("source", "not applicable (source space)", obs_mod.observe(cond.v, spec, seeds))
            )
        for ref in rec.observation.references:
            spec = ObservationSpec(
                kind="eeg_forward",
                n_sensors=rec.observation.n_sensors,
                gain=rec.observation.gain,
                reference=ref,
                sensor_noise_std=rec.observation.sensor_noise_std,
            )
            obs = obs_mod.observe(cond.v, spec, seeds, seed_path=("flow",))
            views.append((f"sensor-{ref}", ref, obs))
        for space_key, ref, obs in views:
            dataset_id = f"{space_key}/{cond.name}"
            say(f"analyse {dataset_id} ({obs.data.shape[0]} channels)")
            x, sfreq, record = preprocess(obs.data, cond.fs, rec.preprocessing)
            preprocessing_record = record
            channel_names = list(obs.channel_names)
            sensor_positions = None
            display = None
            if obs.analysis_space == "sensor":
                assert obs.source_positions is not None and obs.sensor_positions is not None
                display = display_channels(
                    node_names, obs.source_positions, obs.sensor_positions, channel_names
                )
                display_info = display
                plan = AnalysisPlan(
                    spec=rec.analysis,
                    methods=rec.methods,
                    node_channels={n: display["mapping"][n]["channel_index"] for n in node_names},
                )
                sensor_positions = obs.sensor_positions
                put(
                    _artifact_slug(cond.name, space_key, "observed"),
                    obs.data,
                    kind="flow_observed",
                    units=obs.units,
                    axes=["channel", "time"],
                )
                if obs.leadfield is not None:
                    put(
                        "leadfield",
                        obs.leadfield,
                        kind="leadfield",
                        units=obs.transfer_units,
                        axes=["sensor", "source"],
                    )
            else:
                plan = sources_plan
            started = time.perf_counter()
            methods = analyze_dataset(
                x, sfreq, channel_names, plan, sensor_positions=sensor_positions
            )
            for method_id, res in methods.items():
                if res.get("status") == "ok" and res.get("values") is not None:
                    res["artifact_ref"] = put(
                        _artifact_slug(cond.name, space_key, method_id),
                        np.asarray(res["values"], dtype=float),
                        kind=f"flow_{method_id}",
                        units=res.get("units"),
                        axes=res.get("axes", []),
                    )
            datasets.append(
                {
                    "dataset_id": dataset_id,
                    "space": obs.analysis_space,
                    "condition": cond.name,
                    "G": cond.G,
                    "observation": obs.kind,
                    "reference": ref,
                    "reference_label": obs.reference_label,
                    "units": obs.units,
                    "channel_names": channel_names,
                    "node_channels": plan.node_channels,
                    "sfreq": sfreq,
                    "n_samples": int(x.shape[1]),
                    "display": display,
                    "wall_s": time.perf_counter() - started,
                    "methods": methods,
                }
            )
    timings["analyse_s"] = time.perf_counter() - t_an

    teaching: dict[str, Any] = {}
    if rec.methods.pid.teaching_examples:
        teaching = {
            "discrete_williams_beer": {
                name: {"description": pid_mod.TEACHING_GATES[name], **res.model_dump()}
                for name, res in pid_mod.teaching_examples().items()
            },
            "integration_demo": {k: v.model_dump() for k, v in pid_mod.integration_demo().items()},
            "lesson": (
                "PID는 측도 의존적입니다: Williams-Beer I_min은 COPY(T=(X1,X2))에 R=1, S=1 비트를, "
                "BROJA/I_ccs는 U1=U2=1 비트를 줍니다 (Harder et al. 2013)."
            ),
        }

    # 5. freeze the analysis payload
    analysis_payload = to_jsonable(
        {
            "datasets": datasets,
            "pid_teaching": teaching,
            "simulation": {
                "node_names": node_names,
                "conditions": {c.name: c.metadata for c in conditions},
                "fs": conditions[0].fs,
            },
            "preprocessing": preprocessing_record,
        }
    )
    frozen_sha = payload_sha256(analysis_payload)

    # 6. truth-aware evaluation on a copy of the frozen payload
    say("evaluate (source space only)")
    t_ev = time.perf_counter()
    truth = evaluation.ground_truth_from_recipe(rec)
    report = evaluation.evaluate_flow(
        copy.deepcopy(analysis_payload), truth, alpha=rec.methods.alpha
    )
    if payload_sha256(analysis_payload) != frozen_sha:  # pragma: no cover - defensive
        raise RuntimeError("analysis results changed during evaluation")
    timings["evaluate_s"] = time.perf_counter() - t_ev
    timings["total_s"] = time.perf_counter() - t0

    method_ids = sorted({m for d in datasets for m in d["methods"]})
    result: dict[str, Any] = {
        "schema_version": RESULT_SCHEMA_VERSION,
        "kind": "flow-pipeline-result",
        "run_id": run_id,
        "title": rec.title,
        "profile": rec.profile,
        "recipe_sha256": recipe_hash,
        "recipe": rec.model_dump(mode="json"),
        "concepts": {
            "catalog_version": concepts_mod.CATALOG_VERSION,
            "source_document": concepts_mod.SOURCE_DOCUMENT,
            "method_concepts": {m: concepts_mod.METHOD_CONCEPTS[m] for m in method_ids},
        },
        "truth_isolation": {
            "analysis_inputs": "data, sfreq, channel_names, AnalysisPlan (node groups/hypotheses)",
            "truth_used_by": ["simulate_conditions", "evaluation.evaluate_flow"],
            "frozen_analysis_sha256": frozen_sha,
            "evaluation_space": "source only; sensor channels are not sources",
        },
        "display_channels": display_info,
        **analysis_payload,
        "evaluation": to_jsonable(report),
        "timings_s": timings,
    }
    if store is not None:
        from neurobridge.benchmarks.tasks import write_json_atomic

        path = store.experiment_dir(run_id, create=True) / RESULT_FILENAME
        result["paths"] = {"result_json": str(path), "artifact_dir": str(path.parent)}
        write_json_atomic(path, result)
    return result


__all__ = [
    "AnalysisPlan",
    "AnalysisPlanSpec",
    "ConditionData",
    "FlowGraph",
    "FlowRecipe",
    "MethodSettings",
    "ModelComparisonSpec",
    "PIDTripletSpec",
    "RESULT_FILENAME",
    "analyze_dataset",
    "display_channels",
    "level2_status",
    "load_recipe",
    "method_result",
    "payload_sha256",
    "preprocess",
    "run_flow_pipeline",
    "simulate_conditions",
    "to_jsonable",
]
