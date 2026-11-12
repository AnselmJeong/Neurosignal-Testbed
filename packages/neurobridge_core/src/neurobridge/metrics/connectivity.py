"""Correlation, phase and amplitude connectivity adapters M11-M20 (plan §3.2, §3.5, §5.3).

Every adapter has the registry signature ``fn(data, ctx) -> MetricResult`` and is registered
as variant ``"default"`` on import.

Input
-----
``data``: array ``(n_epochs, n_channels, n_times)`` (a 2D ``(n_channels, n_times)`` array is
one epoch), or a mapping with key ``"data"`` plus any context keys below.
``ctx``: mapping or attribute object with ``sfreq`` (Hz, required) and optionally
``channel_names``, ``analysis_space``, ``input_artifact_id``, ``units`` and ``params``
(metric parameters, e.g. ``bands``, ``mode``, ``min_epochs``). Generation truth is never read.

Output conventions
------------------
* ``values`` are float64 full matrices: ``(n_channels, n_channels)`` for M11 and
  ``(n_bands, n_channels, n_channels)`` for M12-M20, axes ``["band", "channel_row",
  "channel_col"]``; rows/cols follow the input channel order (names in ``parameters``).
* MNE-Connectivity returns one triangle. The adapters request explicit pair indices and fill
  the other triangle explicitly: mirror for symmetric measures, ``M[j, i] = -M[i, j]`` for the
  antisymmetric imaginary coherency (M13). No ``A + A.T`` and no symmetrisation is applied.
  For M13, ``M[i, j]`` is MNE's estimate with seed ``i`` and target ``j``.
* The diagonal (self-connectivity) is undefined for these pairwise measures and is NaN.
* Raw estimator values are kept: no ``abs()``, no clipping (PPC and debiased wPLI² can be
  negative; AEC keeps its sign, ``absolute=False``).
* Too few epochs -> ``insufficient_data``; malformed input -> ``invalid_input``.
"""

from __future__ import annotations

import warnings
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from neurobridge.benchmarks.contracts import MetricResult, MetricStatus
from neurobridge.metrics import registry

DEFAULT_BANDS: dict[str, tuple[float, float]] = {
    "delta": (1.0, 4.0),
    "theta": (4.0, 8.0),
    "alpha": (8.0, 13.0),
    "beta": (13.0, 30.0),
    "gamma": (30.0, 45.0),
}
DIAGONAL_POLICY = "nan: self-connectivity undefined for pairwise measures"
SPECTRAL_METHODS: dict[str, str] = {
    "M12": "coh",
    "M13": "imcoh",
    "M14": "plv",
    "M15": "ppc",
    "M16": "pli",
    "M17": "wpli",
    "M18": "wpli2_debiased",
}
ANTISYMMETRIC_METHODS = frozenset({"imcoh"})
DEFAULT_MIN_EPOCHS = {"spectral": 5, "pearson": 1, "aec": 1}
MATRIX_AXES = ["channel_row", "channel_col"]
BAND_MATRIX_AXES = ["band", *MATRIX_AXES]


class MetricInputError(Exception):
    """Input problem that maps to a non-ok status (never to a fabricated value)."""

    def __init__(self, status: MetricStatus, reason_code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.reason_code = reason_code


@dataclass
class EpochInput:
    """Validated epoched input shared by the connectivity and information adapters."""

    epochs: np.ndarray  # float64 (n_epochs, n_channels, n_times)
    sfreq: float
    channel_names: list[str]
    params: dict[str, Any] = field(default_factory=dict)
    analysis_space: str | None = None
    input_artifact_id: str | None = None
    units: str | None = None

    @property
    def n_epochs(self) -> int:
        return int(self.epochs.shape[0])

    @property
    def n_channels(self) -> int:
        return int(self.epochs.shape[1])

    @property
    def n_times(self) -> int:
        return int(self.epochs.shape[2])


def _ctx_get(ctx: Any, key: str, default: Any = None) -> Any:
    if ctx is None:
        return default
    if isinstance(ctx, Mapping):
        return ctx.get(key, default)
    return getattr(ctx, key, default)


def prepare_epochs(data: Any, ctx: Any, *, min_epochs: int, min_channels: int = 2) -> EpochInput:
    """Validate ``data``/``ctx`` into an :class:`EpochInput` or raise MetricInputError."""
    merged: dict[str, Any] = {}
    if isinstance(data, Mapping):
        merged.update({k: v for k, v in data.items() if k != "data"})
        data = data.get("data")
    for key in ("sfreq", "channel_names", "analysis_space", "input_artifact_id", "units"):
        value = _ctx_get(ctx, key)
        if value is not None:
            merged[key] = value
    params = dict(merged.get("params") or {})
    params.update(dict(_ctx_get(ctx, "params") or {}))
    invalid = MetricStatus.INVALID_INPUT
    if data is None:
        raise MetricInputError(invalid, "missing_data", "no time-series data supplied")
    arr = np.asarray(data)
    if arr.dtype.kind not in "fiu":
        raise MetricInputError(invalid, "non_numeric_data", f"data dtype {arr.dtype} is not real")
    arr = arr.astype(np.float64)
    if arr.ndim == 2:
        arr = arr[np.newaxis]
    if arr.ndim != 3:
        raise MetricInputError(
            invalid, "bad_shape", f"expected (n_epochs, n_channels, n_times), got {arr.shape}"
        )
    if not np.all(np.isfinite(arr)):
        raise MetricInputError(invalid, "non_finite_data", "data contains NaN or inf")
    sfreq = merged.get("sfreq")
    if sfreq is None or not np.isfinite(float(sfreq)) or float(sfreq) <= 0:
        raise MetricInputError(invalid, "missing_sfreq", "a positive sfreq (Hz) is required")
    n_epochs, n_channels, _ = arr.shape
    names = merged.get("channel_names")
    names = [str(n) for n in names] if names is not None else [f"ch{i}" for i in range(n_channels)]
    if len(names) != n_channels:
        raise MetricInputError(
            invalid, "channel_names_mismatch", f"{len(names)} names for {n_channels} channels"
        )
    if n_channels < min_channels:
        raise MetricInputError(
            MetricStatus.INSUFFICIENT_DATA,
            "too_few_channels",
            f"{n_channels} channel(s); at least {min_channels} needed",
        )
    min_epochs = int(params.get("min_epochs", min_epochs))
    if n_epochs < min_epochs:
        raise MetricInputError(
            MetricStatus.INSUFFICIENT_DATA,
            "too_few_epochs",
            f"{n_epochs} epoch(s); at least {min_epochs} required",
        )
    return EpochInput(
        epochs=arr,
        sfreq=float(sfreq),
        channel_names=names,
        params=params,
        analysis_space=merged.get("analysis_space"),
        input_artifact_id=merged.get("input_artifact_id"),
        units=merged.get("units"),
    )


def resolve_bands(params: Mapping[str, Any], sfreq: float) -> dict[str, tuple[float, float]]:
    bands_raw = params.get("bands") or DEFAULT_BANDS
    bands: dict[str, tuple[float, float]] = {}
    for name, edges in dict(bands_raw).items():
        lo, hi = (float(edges[0]), float(edges[1]))
        if not (0 < lo < hi < sfreq / 2.0):
            raise MetricInputError(
                MetricStatus.INVALID_INPUT,
                "invalid_band",
                f"band {name}=({lo}, {hi}) must satisfy 0 < fmin < fmax < Nyquist {sfreq / 2}",
            )
        bands[str(name)] = (lo, hi)
    return bands


def fill_from_pairs(
    n: int, rows: np.ndarray, cols: np.ndarray, values: np.ndarray, *, antisymmetric: bool
) -> np.ndarray:
    """Full ``(..., n, n)`` matrix from one-triangle pair values (last axis of ``values``
    indexes the pairs). The other triangle is filled explicitly; the diagonal is NaN."""
    values = np.asarray(values, dtype=np.float64)
    out = np.full((*values.shape[:-1], n, n), np.nan, dtype=np.float64)
    out[..., rows, cols] = values
    out[..., cols, rows] = -values if antisymmetric else values
    return out


def _version(module_name: str) -> str | None:
    try:
        module = __import__(module_name)
    except ImportError:  # pragma: no cover - dependency group checked by the registry
        return None
    return str(getattr(module, "__version__", None))


def _ok_result(
    metric_id: str,
    inp: EpochInput,
    values: np.ndarray,
    *,
    axes: list[str],
    units: str,
    parameters: dict[str, Any],
    backend: str,
    backend_version: str | None,
    validity_flags: list[str] | None = None,
    diagnostics: dict[str, Any] | None = None,
) -> MetricResult:
    return MetricResult(
        metric_id=metric_id,
        status=MetricStatus.OK,
        variant="default",
        analysis_space=inp.analysis_space,
        units=units,
        axes=axes,
        parameters={
            "channel_names": inp.channel_names,
            "sfreq": inp.sfreq,
            "diagonal": DIAGONAL_POLICY,
            **parameters,
        },
        input_artifact_id=inp.input_artifact_id,
        backend=backend,
        backend_version=backend_version,
        n_samples=inp.n_epochs * inp.n_times,
        n_epochs=inp.n_epochs,
        validity_flags=sorted(set(validity_flags or [])),
        values=values,
        diagnostics={"value_shape": list(values.shape), **(diagnostics or {})},
    )


def _guard(metric_id: str, fn: Callable[[Any, Any], MetricResult]) -> Callable:
    def adapter(data: Any, ctx: Any) -> MetricResult:
        try:
            return fn(data, ctx)
        except MetricInputError as exc:
            return MetricResult.from_status(
                metric_id, exc.status, exc.reason_code, message=str(exc)
            )

    adapter.__name__ = f"{metric_id.lower()}_adapter"
    adapter.__doc__ = fn.__doc__
    return adapter


def _warning_flags(caught: list[warnings.WarningMessage]) -> tuple[list[str], list[str]]:
    flags, messages = [], []
    for w in caught:
        text = str(w.message)
        messages.append(text[:300])
        if "cycles" in text:
            flags.append("fmin_below_5_cycles_per_epoch")
        else:
            flags.append("backend_warning")
    return flags, messages


# --------------------------------------------------------------------------- M11 Pearson


def pearson(data: Any, ctx: Any) -> MetricResult:
    """M11: signed zero-lag Pearson correlation over all samples (epochs concatenated)."""
    inp = prepare_epochs(data, ctx, min_epochs=DEFAULT_MIN_EPOCHS["pearson"])
    if inp.n_epochs * inp.n_times < 3:
        raise MetricInputError(MetricStatus.INSUFFICIENT_DATA, "too_few_samples", "need >= 3")
    x = np.concatenate(list(inp.epochs), axis=-1)  # (n_channels, n_epochs * n_times)
    x = x - x.mean(axis=-1, keepdims=True)
    norms = np.linalg.norm(x, axis=-1)
    flags = []
    with np.errstate(invalid="ignore", divide="ignore"):
        corr = (x @ x.T) / np.outer(norms, norms)
    if np.any(norms == 0):
        flags.append("zero_variance_channel")  # affected entries stay NaN
        corr[norms == 0, :] = np.nan
        corr[:, norms == 0] = np.nan
    np.fill_diagonal(corr, np.nan)
    return _ok_result(
        "M11",
        inp,
        corr,
        axes=MATRIX_AXES,
        units="dimensionless (r)",
        parameters={"epoch_handling": "concatenated samples", "lag": 0},
        backend="numpy",
        backend_version=np.__version__,
        validity_flags=flags,
    )


# --------------------------------------------------------------------------- M12-M18


def spectral_matrix(inp: EpochInput, method: str) -> tuple[np.ndarray, dict[str, Any], list[str]]:
    """Band-averaged ``(n_bands, n, n)`` matrix from ``spectral_connectivity_epochs``."""
    from mne_connectivity import spectral_connectivity_epochs

    bands = resolve_bands(inp.params, inp.sfreq)
    mode = str(inp.params.get("mode", "multitaper"))
    mt_bandwidth = inp.params.get("mt_bandwidth")
    freqs = np.fft.rfftfreq(inp.n_times, 1.0 / inp.sfreq)
    for name, (lo, hi) in bands.items():
        if not np.any((freqs >= lo) & (freqs <= hi)):
            raise MetricInputError(
                MetricStatus.INSUFFICIENT_DATA,
                "band_has_no_frequency_bins",
                f"epoch length {inp.n_times / inp.sfreq:.3f} s gives no bin in {name}",
            )
    n = inp.n_channels
    rows, cols = np.tril_indices(n, k=-1)  # seed = row, target = col
    kwargs: dict[str, Any] = {}
    if mt_bandwidth is not None:
        kwargs["mt_bandwidth"] = float(mt_bandwidth)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        con = spectral_connectivity_epochs(
            inp.epochs,
            method=method,
            indices=(rows, cols),
            sfreq=inp.sfreq,
            mode=mode,
            fmin=tuple(b[0] for b in bands.values()),
            fmax=tuple(b[1] for b in bands.values()),
            faverage=True,
            verbose=False,
            **kwargs,
        )
    raveled = np.asarray(con.get_data(output="raveled"), dtype=np.float64)  # (n_pairs, n_bands)
    if raveled.shape != (rows.size, len(bands)):
        raise RuntimeError(f"unexpected backend output shape {raveled.shape}")
    full = fill_from_pairs(n, rows, cols, raveled.T, antisymmetric=method in ANTISYMMETRIC_METHODS)
    flags, messages = _warning_flags(caught)
    freqs_used = con.attrs.get("freqs_used")
    info = {
        "method": method,
        "bands": {k: list(v) for k, v in bands.items()},
        "band_order": list(bands),
        "band_edges": "inclusive both ends (MNE freq mask)",
        "mode": mode,
        "mt_bandwidth": mt_bandwidth,
        "faverage": True,
        "epoch_aggregation": "estimated across epochs (spectral_connectivity_epochs)",
        "pair_convention": "lower-triangle indices; M[i, j] = estimate(seed=i, target=j)",
        "other_triangle": "antisymmetric fill" if method in ANTISYMMETRIC_METHODS else "mirror",
        "n_tapers": con.attrs.get("n_tapers"),
        "freqs_used": [np.asarray(f, dtype=float).tolist() for f in freqs_used]
        if freqs_used is not None
        else None,
        "backend_warnings": messages,
    }
    return full, info, flags


def _spectral_adapter(metric_id: str, method: str) -> Callable[[Any, Any], MetricResult]:
    def compute(data: Any, ctx: Any) -> MetricResult:
        inp = prepare_epochs(data, ctx, min_epochs=DEFAULT_MIN_EPOCHS["spectral"])
        full, info, flags = spectral_matrix(inp, method)
        diagnostics = {
            "freqs_used": info.pop("freqs_used"),
            "backend_warnings": info.pop("backend_warnings"),
            "n_tapers": info.pop("n_tapers"),
        }
        return _ok_result(
            metric_id,
            inp,
            full,
            axes=BAND_MATRIX_AXES,
            units="dimensionless",
            parameters=info,
            backend="mne_connectivity.spectral_connectivity_epochs",
            backend_version=_version("mne_connectivity"),
            validity_flags=flags,
            diagnostics=diagnostics,
        )

    compute.__doc__ = f"{metric_id}: MNE-Connectivity '{method}' across epochs, per band."
    return compute


# --------------------------------------------------------------------------- M19/M20 AEC


def aec_matrix(inp: EpochInput, orthogonalize: bool) -> tuple[np.ndarray, dict[str, Any]]:
    from mne.filter import filter_data
    from mne_connectivity import envelope_correlation

    prefiltered = bool(inp.params.get("prefiltered", False))
    bands = {"input": None} if prefiltered else resolve_bands(inp.params, inp.sfreq)
    n = inp.n_channels
    rows, cols = np.triu_indices(n, k=0)  # MNE stores the upper triangle incl. diagonal
    mats = []
    for edges in bands.values():
        if edges is None:
            x = inp.epochs
        else:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                x = filter_data(inp.epochs, inp.sfreq, edges[0], edges[1], verbose=False)
        con = envelope_correlation(
            x, orthogonalize="pairwise" if orthogonalize else False, absolute=False, verbose=False
        )
        raveled = np.asarray(con.get_data(output="raveled"), dtype=np.float64)[..., 0]
        if raveled.shape != (inp.n_epochs, rows.size):
            raise RuntimeError(f"unexpected backend output shape {raveled.shape}")
        mats.append(fill_from_pairs(n, rows, cols, raveled.mean(axis=0), antisymmetric=False))
    full = np.stack(mats)
    for mat in full:
        np.fill_diagonal(mat, np.nan)
    info = {
        "bands": {k: (list(v) if v is not None else None) for k, v in bands.items()},
        "band_order": list(bands),
        "band_limiting": "input declared band-limited"
        if prefiltered
        else "mne.filter.filter_data FIR zero-phase per epoch (default design)",
        "envelope": "abs(hilbert)",
        "orthogonalize": "pairwise" if orthogonalize else False,
        "absolute": False,
        "log": False,
        "epoch_aggregation": "mean of per-epoch correlations",
        "orth_symmetrisation": "MNE (C + C.T) / 2 of the directional pairwise estimates"
        if orthogonalize
        else None,
    }
    return full, info


def _aec_adapter(metric_id: str, orthogonalize: bool) -> Callable[[Any, Any], MetricResult]:
    def compute(data: Any, ctx: Any) -> MetricResult:
        inp = prepare_epochs(data, ctx, min_epochs=DEFAULT_MIN_EPOCHS["aec"])
        full, info = aec_matrix(inp, orthogonalize)
        return _ok_result(
            metric_id,
            inp,
            full,
            axes=BAND_MATRIX_AXES,
            units="dimensionless (r)",
            parameters=info,
            backend="mne_connectivity.envelope_correlation",
            backend_version=_version("mne_connectivity"),
            diagnostics={"mne_version": _version("mne")},
        )

    kind = "pairwise-orthogonalized" if orthogonalize else "non-orthogonalized"
    compute.__doc__ = f"{metric_id}: signed {kind} amplitude envelope correlation per band."
    return compute


# --------------------------------------------------------------------------- registration

ADAPTERS: dict[str, Callable[[Any, Any], MetricResult]] = {
    "M11": _guard("M11", pearson),
    **{mid: _guard(mid, _spectral_adapter(mid, m)) for mid, m in SPECTRAL_METHODS.items()},
    "M19": _guard("M19", _aec_adapter("M19", orthogonalize=False)),
    "M20": _guard("M20", _aec_adapter("M20", orthogonalize=True)),
}

for _metric_id, _fn in ADAPTERS.items():
    registry.register(_metric_id, "default", _fn, default=True, replace=True)
