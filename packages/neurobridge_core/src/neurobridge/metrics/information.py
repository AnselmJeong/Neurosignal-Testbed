"""Symbolic mutual information adapters M22 (SMI) and M23 (wSMI) (plan §3.3, §3.5).

Backend: ``mne_connectivity.wsmi`` (0.8.x signature ``wsmi(data, kernel, tau, indices=None,
sfreq=None, names=None, tmin=None, tmax=None, anti_aliasing='auto', weighted=True,
average=False, verbose=None)``). M22 calls it with ``weighted=False``, M23 with
``weighted=True``.

``tau`` is a lag in samples, not a frequency band. The pre-declared scales are
``tau in {2, 4, 8}`` with ``kernel=3``; the backend's anti-aliasing low-pass cutoff is
``sfreq / kernel / tau`` (≈42.7/21.3/10.7 Hz at 256 Hz) and is recorded per tau.

Values: ``(n_tau, n_channels, n_channels)`` float64, axes ``["tau", "channel_row",
"channel_col"]``, epoch-averaged (``average=True``), symmetric with an explicit mirror fill
from lower-triangle pair indices, NaN diagonal. Raw backend values are kept (no clipping).
Input/ctx conventions are those of :mod:`neurobridge.metrics.connectivity`.
"""

from __future__ import annotations

import math
import warnings
from collections.abc import Callable
from typing import Any

import numpy as np

from neurobridge.benchmarks.contracts import MetricResult, MetricStatus
from neurobridge.metrics import registry
from neurobridge.metrics.connectivity import (
    EpochInput,
    MetricInputError,
    _guard,
    _ok_result,
    _version,
    fill_from_pairs,
    prepare_epochs,
)

DEFAULT_KERNEL = 3
DEFAULT_TAUS: tuple[int, ...] = (2, 4, 8)
DEFAULT_MIN_EPOCHS = 1
TAU_AXES = ["tau", "channel_row", "channel_col"]


def anti_alias_cutoff_hz(sfreq: float, kernel: int, tau: int) -> float:
    """Low-pass cutoff the backend uses before symbolisation: ``sfreq / kernel / tau``."""
    return float(sfreq) / kernel / tau


def _anti_alias_applied(anti_aliasing: bool | str, sfreq: float, cutoff: float) -> bool:
    # Mirrors mne_connectivity.wsmi._apply_anti_aliasing for array input: 'auto' and True
    # filter unless the cutoff is within 1% of Nyquist; False never filters.
    if anti_aliasing is False:
        return False
    return cutoff < (sfreq / 2.0) * 0.99


def wsmi_matrix(inp: EpochInput, *, weighted: bool) -> tuple[np.ndarray, dict[str, Any]]:
    from mne_connectivity import wsmi

    kernel = int(inp.params.get("kernel", DEFAULT_KERNEL))
    taus = tuple(int(t) for t in inp.params.get("taus", DEFAULT_TAUS))
    anti_aliasing = inp.params.get("anti_aliasing", "auto")
    if kernel < 2 or not taus or min(taus) < 1:
        raise MetricInputError(
            MetricStatus.INVALID_INPUT, "invalid_symbolisation", "need kernel >= 2 and tau >= 1"
        )
    needed = max(taus) * (kernel - 1) + 1
    if inp.n_times < needed:
        raise MetricInputError(
            MetricStatus.INSUFFICIENT_DATA,
            "too_few_samples_for_symbols",
            f"{inp.n_times} samples per epoch; tau={max(taus)}, kernel={kernel} need {needed}",
        )
    n = inp.n_channels
    rows, cols = np.tril_indices(n, k=-1)
    mats, cutoffs, applied, symbols_per_epoch = [], {}, {}, {}
    warning_messages: list[str] = []
    for tau in taus:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            con = wsmi(
                inp.epochs,
                kernel,
                tau,
                indices=(rows, cols),
                sfreq=inp.sfreq,
                names=inp.channel_names,
                anti_aliasing=anti_aliasing,
                weighted=weighted,
                average=True,
                verbose=False,
            )
        warning_messages.extend(str(w.message)[:300] for w in caught)
        raveled = np.asarray(con.get_data(output="raveled"), dtype=np.float64).reshape(-1)
        if raveled.shape != (rows.size,):
            raise RuntimeError(f"unexpected backend output shape {raveled.shape}")
        mats.append(fill_from_pairs(n, rows, cols, raveled, antisymmetric=False))
        cutoff = anti_alias_cutoff_hz(inp.sfreq, kernel, tau)
        cutoffs[str(tau)] = cutoff
        applied[str(tau)] = _anti_alias_applied(anti_aliasing, inp.sfreq, cutoff)
        symbols_per_epoch[str(tau)] = inp.n_times - tau * (kernel - 1)
    info = {
        "kernel": kernel,
        "taus_samples": list(taus),
        "taus_ms": [1000.0 * t / inp.sfreq for t in taus],
        "weighted": weighted,
        "anti_aliasing": anti_aliasing,
        "effective_lowpass_hz": cutoffs,
        "anti_alias_filter_applied": applied,
        "anti_alias_filter": "butter(6) lowpass, filtfilt over concatenated epochs (backend)",
        "n_symbols": math.factorial(kernel),
        "normalisation": "MI / log(kernel!) (nats ratio)",
        "tie_handling": "numpy argsort order (stable index order for ties)",
        "epoch_aggregation": "mean over epochs (average=True)",
        "pair_convention": "lower-triangle indices, mirrored; tau is a lag, not a band",
    }
    diagnostics = {"symbols_per_epoch": symbols_per_epoch, "backend_warnings": warning_messages}
    flags = ["anti_aliasing_disabled"] if anti_aliasing is False else []
    if warning_messages and anti_aliasing is not False:
        flags.append("backend_warning")
    return np.stack(mats), {"parameters": info, "diagnostics": diagnostics, "flags": flags}


def _wsmi_adapter(metric_id: str, *, weighted: bool) -> Callable[[Any, Any], MetricResult]:
    def compute(data: Any, ctx: Any) -> MetricResult:
        inp = prepare_epochs(data, ctx, min_epochs=DEFAULT_MIN_EPOCHS)
        full, info = wsmi_matrix(inp, weighted=weighted)
        return _ok_result(
            metric_id,
            inp,
            full,
            axes=TAU_AXES,
            units="normalised (MI / log n_symbols)",
            parameters=info["parameters"],
            backend="mne_connectivity.wsmi",
            backend_version=_version("mne_connectivity"),
            validity_flags=info["flags"],
            diagnostics=info["diagnostics"],
        )

    name = "wSMI" if weighted else "SMI"
    compute.__doc__ = f"{metric_id}: {name} via mne_connectivity.wsmi(weighted={weighted})."
    return compute


ADAPTERS: dict[str, Callable[[Any, Any], MetricResult]] = {
    "M22": _guard("M22", _wsmi_adapter("M22", weighted=False)),
    "M23": _guard("M23", _wsmi_adapter("M23", weighted=True)),
}

for _metric_id, _fn in ADAPTERS.items():
    registry.register(_metric_id, "default", _fn, default=True, replace=True)
