"""Executable registry of the 29 in-scope resting-EEG metric IDs (plan §3, §3.5, §8).

Public API (other modules import these names exactly):

``MetricDefinition``      frozen dataclass: ``id, name, family, plan_section,
                          backend_candidate, dependency_group, dependency_modules,
                          input_requirements, signed, value_domain``.
``MetricAdapter``         ``Callable[[Any, Any], MetricResult]`` - ``fn(data, ctx)``.
``DependencyGroup``       ``Literal["core", "simulation", "metrics", "pac", "information"]``.
``METRIC_DEFINITIONS``    ``dict[str, MetricDefinition]`` with exactly the 29 IDs.
``METRIC_IDS``            ``tuple[str, ...]`` (= ``contracts.IN_SCOPE_METRIC_IDS``).
``DEPENDENCY_GROUP_MODULES`` ``dict[DependencyGroup, tuple[str, ...]]`` import names.
``MetricRegistry``        class with the methods below; ``REGISTRY`` is the process singleton.

Module-level functions (delegate to ``REGISTRY``):

``register(metric_id, variant, fn, *, default=False, replace=False) -> None``
    Attach an adapter. Raises ``ValueError`` for an unknown ID or a duplicate variant
    (developer error at import time). The first registered variant is the default unless
    a later registration passes ``default=True``.
``unregister(metric_id, variant) -> None``
``run(metric_id, data, ctx, variant=None) -> MetricResult``
    Never raises and never fabricates values:
    unknown ID / unknown variant -> ``invalid_input``;
    no adapter + dependency missing -> ``unsupported_dependency`` / ``dependency_missing``;
    no adapter + dependency present -> ``unsupported_dependency`` / ``adapter_not_registered``;
    adapter exception -> ``failed`` / ``adapter_exception``;
    adapter returns a non-``MetricResult`` or a mismatched ID/variant -> ``failed``.
``capabilities() -> dict[str, dict]``
    Per ID: definition fields, ``status`` (``implemented`` if any adapter is registered,
    else ``planned``), ``variants``, ``default_variant``, ``dependency_available``
    (all of the ID's ``dependency_modules`` found by ``importlib.util.find_spec``),
    ``missing_modules``.
``dependency_status() -> dict[DependencyGroup, bool]``
``get_definition(metric_id) -> MetricDefinition``
``implementation_status(metric_id) -> Literal["implemented", "planned"]``
``registered_variants(metric_id) -> tuple[str, ...]``

All 29 IDs start ``planned``. This module does not import adapter modules; adapters call
``register`` when they are imported.
"""

from __future__ import annotations

import importlib.util
from collections.abc import Callable
from dataclasses import asdict, dataclass
from typing import Any, Literal

from neurobridge.benchmarks.contracts import IN_SCOPE_METRIC_IDS, MetricResult, MetricStatus

DependencyGroup = Literal["core", "simulation", "metrics", "pac", "information"]
ImplementationStatus = Literal["implemented", "planned"]
MetricAdapter = Callable[[Any, Any], MetricResult]

DEPENDENCY_GROUP_MODULES: dict[DependencyGroup, tuple[str, ...]] = {
    "core": ("numpy", "scipy", "mne", "mne_connectivity", "specparam"),
    "simulation": ("tvb",),
    "metrics": ("antropy", "bct"),
    "pac": ("tensorpac",),
    "information": ("idtxl", "jpype"),
}


@dataclass(frozen=True)
class MetricDefinition:
    id: str
    name: str
    family: str
    plan_section: str
    backend_candidate: str
    dependency_group: DependencyGroup
    dependency_modules: tuple[str, ...]
    input_requirements: str
    signed: bool
    value_domain: str


def _d(
    metric_id: str,
    name: str,
    family: str,
    section: str,
    backend: str,
    group: DependencyGroup,
    modules: tuple[str, ...],
    inputs: str,
    signed: bool,
    domain: str,
) -> MetricDefinition:
    return MetricDefinition(
        metric_id, name, family, section, backend, group, modules, inputs, signed, domain
    )


_SPEC = "time series (channels x samples), fs, units"
_EPOCHS = "epoched band-limited time series (epochs x channels x samples), fs"
_CONN = "completed connectivity matrix (channels x channels), declared weighting/threshold"
_NP = ("numpy", "scipy")
_MNE = ("mne",)
_SP = ("specparam",)
_MC = ("mne_connectivity",)
_ANT = ("antropy",)
_BCT = ("bct",)
_INFO = ("idtxl", "jpype")

_DEFINITIONS: tuple[MetricDefinition, ...] = (
    _d("M01", "PSD", "spectral", "3.1", "MNE Welch/multitaper", "core", _MNE,
       _SPEC, False, "[0, inf) power density"),
    _d("M02", "Absolute band power", "spectral", "3.1", "numerical integration of PSD",
       "core", _NP, "PSD (channels x freqs) + band edges", False, "[0, inf) power"),
    _d("M03", "Relative band power", "spectral", "3.1", "band power / fixed total-range power",
       "core", _NP, "band power + fixed total range", False, "[0, 1] ratio"),
    _d("M04", "Spectral peak", "spectral", "3.1", "specparam + explicit peak criterion",
       "core", _SP, "PSD + fit range", False, "frequency (Hz), height, width; null if none"),
    _d("M05", "Aperiodic exponent", "spectral", "3.1", "specparam adapter", "core", _SP,
       "PSD + fit range/mode", True, "real"),
    _d("M06", "Aperiodic offset", "spectral", "3.1", "specparam adapter (same fit)", "core",
       _SP, "PSD + fit range/mode", True, "real (log10 input units)"),
    _d("M11", "Pearson correlation", "correlation", "3.2", "NumPy/SciPy", "core", _NP,
       _SPEC, True, "[-1, 1] symmetric"),
    _d("M12", "Coherence", "phase", "3.2", "MNE-Connectivity coh", "core", _MC,
       _EPOCHS, False, "[0, 1] coherency magnitude"),
    _d("M13", "Imaginary coherency", "phase", "3.2", "MNE-Connectivity imcoh", "core", _MC,
       _EPOCHS, True, "[-1, 1] antisymmetric, channel order preserved"),
    _d("M14", "PLV", "phase", "3.2", "MNE-Connectivity plv", "core", _MC,
       _EPOCHS, False, "[0, 1]"),
    _d("M15", "PPC", "phase", "3.2", "MNE-Connectivity ppc", "core", _MC,
       _EPOCHS, True, "real; negative estimates preserved"),
    _d("M16", "PLI", "phase", "3.2", "MNE-Connectivity pli", "core", _MC,
       _EPOCHS, False, "[0, 1]"),
    _d("M17", "wPLI", "phase", "3.2", "MNE-Connectivity wpli", "core", _MC,
       _EPOCHS, False, "[0, 1]"),
    _d("M18", "Debiased squared wPLI", "phase", "3.2", "MNE-Connectivity wpli2_debiased",
       "core", _MC, _EPOCHS, True, "real; negative estimates preserved"),
    _d("M19", "AEC", "amplitude", "3.2", "envelope_correlation(orthogonalize=False)", "core",
       _MC, _EPOCHS, True, "[-1, 1]"),
    _d("M20", "Orthogonalized AEC", "amplitude", "3.2",
       "envelope_correlation(orthogonalize='pairwise')", "core", _MC, _EPOCHS, True,
       "[-1, 1]; distinct measurand from M19"),
    _d("M21", "Continuous mutual information", "information", "3.3",
       "IDTxl/JIDT Kraskov MI", "information", _INFO,
       "zero-lag continuous time series; kNN, Theiler window", False, "[0, inf) nats"),
    _d("M22", "SMI", "information", "3.3", "MNE-Connectivity wsmi(weighted=False)", "core",
       _MC, "epoched time series; kernel, tau (samples)", False, "[0, inf) normalised"),
    _d("M23", "wSMI", "information", "3.3", "MNE-Connectivity wsmi(weighted=True)", "core",
       _MC, "epoched time series; kernel, tau (samples)", False, "[0, inf) normalised"),
    _d("M24", "Permutation entropy", "complexity", "3.3", "AntroPy", "metrics", _ANT,
       "single-channel time series; order, delay", False, "[0, 1] when normalised"),
    _d("M25", "Sample entropy", "complexity", "3.3", "AntroPy", "metrics", _ANT,
       "single-channel time series; m, r", False, "[0, inf); undefined if no matches"),
    _d("M26", "Lempel-Ziv complexity", "complexity", "3.3", "AntroPy", "metrics", _ANT,
       "binarised single-channel sequence", False, "[0, inf) normalised (not capped at 1)"),
    _d("M27", "Granger causality", "directed", "3.3",
       "OLS VAR GC (numpy/scipy, neurobridge.flow.granger)", "core", ("numpy", "scipy"),
       "ordered source->target pairs; VAR order (AIC/BIC), pairwise|conditional", False,
       "[0, inf) directed (log variance ratio)"),
    _d("M28", "Transfer entropy", "directed", "3.3",
       "Gaussian / KSG TE (numpy/scipy, neurobridge.flow.transfer_entropy)", "core",
       ("numpy", "scipy"), "ordered source->target pairs (required for KSG >12); history, lag",
       True, "Gaussian [0, inf) nats; KSG estimate may be slightly negative"),
    _d("M29", "PAC (Tort modulation index)", "cross_frequency", "3.3", "Tensorpac", "pac",
       ("tensorpac",), "phase/amplitude bands; within- or declared cross-channel", False,
       "[0, 1] modulation index"),
    _d("M30", "Clustering coefficient", "graph", "3.4", "bctpy", "metrics", _BCT,
       _CONN, False, "[0, 1] per node"),
    _d("M31", "Modularity", "graph", "3.4", "bctpy", "metrics", _BCT,
       _CONN + "; community method, resolution, seed", True, "[-0.5, 1]"),
    _d("M32", "Global efficiency", "graph", "3.4", "bctpy", "metrics", _BCT,
       _CONN + "; edge->distance transform", False, "[0, inf)"),
    _d("M33", "Characteristic path length", "graph", "3.4", "bctpy", "metrics", _BCT,
       _CONN + "; disconnected-graph policy", False, "(0, inf]; inf if disconnected"),
)  # fmt: skip

METRIC_DEFINITIONS: dict[str, MetricDefinition] = {d.id: d for d in _DEFINITIONS}
METRIC_IDS: tuple[str, ...] = IN_SCOPE_METRIC_IDS

if tuple(METRIC_DEFINITIONS) != IN_SCOPE_METRIC_IDS:  # pragma: no cover - import-time guard
    raise RuntimeError("metric registry must define exactly the 29 in-scope IDs in order")


def _missing_modules(modules: tuple[str, ...]) -> list[str]:
    missing = []
    for module in modules:
        try:
            found = importlib.util.find_spec(module) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            missing.append(module)
    return missing


class MetricRegistry:
    """Holds adapters per (metric ID, variant). Use the module-level ``REGISTRY``."""

    def __init__(self) -> None:
        self._adapters: dict[str, dict[str, MetricAdapter]] = {mid: {} for mid in METRIC_IDS}
        self._defaults: dict[str, str] = {}

    def register(
        self,
        metric_id: str,
        variant: str,
        fn: MetricAdapter,
        *,
        default: bool = False,
        replace: bool = False,
    ) -> None:
        if metric_id not in self._adapters:
            raise ValueError(f"{metric_id!r} is not one of the 29 in-scope metric IDs")
        if not variant:
            raise ValueError("variant must be a non-empty string")
        if not callable(fn):
            raise ValueError("adapter must be callable as fn(data, ctx)")
        variants = self._adapters[metric_id]
        if variant in variants and not replace:
            raise ValueError(f"{metric_id}/{variant} is already registered")
        variants[variant] = fn
        if default or metric_id not in self._defaults:
            self._defaults[metric_id] = variant

    def unregister(self, metric_id: str, variant: str) -> None:
        variants = self._adapters.get(metric_id, {})
        variants.pop(variant, None)
        if self._defaults.get(metric_id) == variant:
            if variants:
                self._defaults[metric_id] = next(iter(variants))
            else:
                self._defaults.pop(metric_id, None)

    def registered_variants(self, metric_id: str) -> tuple[str, ...]:
        return tuple(self._adapters.get(metric_id, {}))

    def implementation_status(self, metric_id: str) -> ImplementationStatus:
        return "implemented" if self._adapters.get(metric_id) else "planned"

    def run(self, metric_id: str, data: Any, ctx: Any, variant: str | None = None) -> MetricResult:
        label = variant or "default"
        if metric_id not in self._adapters:
            return MetricResult.from_status(
                str(metric_id),
                MetricStatus.INVALID_INPUT,
                "unknown_metric_id",
                variant=label,
                message=f"{metric_id!r} is not one of the 29 in-scope metric IDs",
            )
        definition = METRIC_DEFINITIONS[metric_id]
        variants = self._adapters[metric_id]
        if not variants:
            missing = _missing_modules(definition.dependency_modules)
            if missing:
                return MetricResult.from_status(
                    metric_id,
                    MetricStatus.UNSUPPORTED_DEPENDENCY,
                    "dependency_missing",
                    variant=label,
                    message=(
                        f"optional group {definition.dependency_group!r} not installed: "
                        + ", ".join(missing)
                    ),
                    diagnostics={"missing_modules": missing},
                )
            return MetricResult.from_status(
                metric_id,
                MetricStatus.UNSUPPORTED_DEPENDENCY,
                "adapter_not_registered",
                variant=label,
                message=f"{metric_id} ({definition.name}) is planned; no adapter registered",
            )
        chosen = variant if variant is not None else self._defaults[metric_id]
        fn = variants.get(chosen)
        if fn is None:
            return MetricResult.from_status(
                metric_id,
                MetricStatus.INVALID_INPUT,
                "unknown_variant",
                variant=chosen,
                message=f"registered variants: {', '.join(variants)}",
            )
        try:
            result = fn(data, ctx)
        except Exception as exc:  # adapter failures become a status, never a raise
            return MetricResult.from_status(
                metric_id,
                MetricStatus.FAILED,
                "adapter_exception",
                variant=chosen,
                message=str(exc)[:500],
                diagnostics={"exception_type": type(exc).__name__},
            )
        if not isinstance(result, MetricResult):
            return MetricResult.from_status(
                metric_id,
                MetricStatus.FAILED,
                "adapter_returned_invalid_type",
                variant=chosen,
                message=f"adapter returned {type(result).__name__}, expected MetricResult",
            )
        if result.metric_id != metric_id or result.variant != chosen:
            return MetricResult.from_status(
                metric_id,
                MetricStatus.FAILED,
                "adapter_result_mismatch",
                variant=chosen,
                message=(
                    f"adapter returned {result.metric_id}/{result.variant}, "
                    f"expected {metric_id}/{chosen}"
                ),
            )
        return result

    def capabilities(self) -> dict[str, dict[str, Any]]:
        report: dict[str, dict[str, Any]] = {}
        for metric_id, definition in METRIC_DEFINITIONS.items():
            missing = _missing_modules(definition.dependency_modules)
            entry = asdict(definition)
            entry["dependency_modules"] = list(definition.dependency_modules)
            entry.update(
                status=self.implementation_status(metric_id),
                variants=list(self.registered_variants(metric_id)),
                default_variant=self._defaults.get(metric_id),
                dependency_available=not missing,
                missing_modules=missing,
            )
            report[metric_id] = entry
        return report


REGISTRY = MetricRegistry()


def register(
    metric_id: str,
    variant: str,
    fn: MetricAdapter,
    *,
    default: bool = False,
    replace: bool = False,
) -> None:
    REGISTRY.register(metric_id, variant, fn, default=default, replace=replace)


def unregister(metric_id: str, variant: str) -> None:
    REGISTRY.unregister(metric_id, variant)


def run(metric_id: str, data: Any, ctx: Any, variant: str | None = None) -> MetricResult:
    return REGISTRY.run(metric_id, data, ctx, variant=variant)


def capabilities() -> dict[str, dict[str, Any]]:
    return REGISTRY.capabilities()


def registered_variants(metric_id: str) -> tuple[str, ...]:
    return REGISTRY.registered_variants(metric_id)


def implementation_status(metric_id: str) -> ImplementationStatus:
    return REGISTRY.implementation_status(metric_id)


def get_definition(metric_id: str) -> MetricDefinition:
    return METRIC_DEFINITIONS[metric_id]


def dependency_status() -> dict[DependencyGroup, bool]:
    return {
        group: not _missing_modules(modules) for group, modules in DEPENDENCY_GROUP_MODULES.items()
    }
