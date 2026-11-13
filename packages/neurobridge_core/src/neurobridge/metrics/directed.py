"""Directed-connectivity adapters M27 (Granger causality) and M28 (transfer entropy).

Registered on import with :mod:`neurobridge.metrics.registry`:

* ``M27`` variants ``pairwise`` (default) and ``conditional`` ->
  :func:`neurobridge.flow.granger.pairwise_gc` / :func:`~neurobridge.flow.granger.conditional_gc`.
* ``M28`` variants ``gaussian`` (default) and ``ksg`` ->
  :func:`neurobridge.flow.transfer_entropy.te_matrix`.

Input/ctx conventions are those of :mod:`neurobridge.metrics.connectivity` (``data`` is
``(n_epochs, n_channels, n_times)`` or ``(n_channels, n_times)``; ``ctx`` has ``sfreq`` and
optional ``channel_names``, ``analysis_space``, ``params``). Generation truth is never read.

``values`` is a float64 ``(n_channels, n_channels)`` matrix with axes ``["target",
"source"]``: ``values[t, s]`` is the flow ``s -> t``. The diagonal and undeclared or
ineligible pairs are NaN. Units are nats. Estimates are kept raw (KSG TE can be slightly
negative under independence; no ``abs``/clip).

Parameters (``ctx["params"]``)
------------------------------
M27: ``order`` (int or ``"aic"``/``"bic"``, default ``"bic"``), ``max_order`` (10),
``min_obs_per_param`` (10), ``pairs`` (pairwise only; list of ``[source, target]`` as indices
or channel names, default all ordered pairs), ``time_reversed`` (bool, default False: adds
the time-reversal diagnostic, separate from ``values``).
M28: ``k_hist`` / ``l_hist`` / ``lag`` (1/1/1), ``pairs`` (required for ``ksg`` unless the
number of ordered pairs <= ``max_auto_pairs`` = 12), ``n_surrogates`` (0 = no surrogate test;
``gaussian`` then reports the analytic chi2 p-value), ``k_neighbors`` (4), ``theiler`` (0),
``seed`` (0).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

import numpy as np

from neurobridge.benchmarks.contracts import MetricResult, MetricStatus
from neurobridge.flow import granger
from neurobridge.flow import transfer_entropy as te
from neurobridge.metrics import registry
from neurobridge.metrics.connectivity import EpochInput, MetricInputError, prepare_epochs

DIRECTED_AXES = ["target", "source"]
DIAGONAL_POLICY = "nan: self-flow undefined; undeclared or ineligible pairs are also nan"
MATRIX_CONVENTION = "values[target, source] = flow source -> target"
DEFAULT_MAX_AUTO_PAIRS = 12


def _jsonable(arr: np.ndarray | None) -> list | None:
    """Nested lists with NaN/inf -> None (JSON-safe diagnostics)."""
    if arr is None:
        return None
    return [[float(v) if np.isfinite(v) else None for v in row] for row in np.atleast_2d(arr)]


def _resolve_pairs(raw: Any, inp: EpochInput) -> list[tuple[int, int]] | None:
    if raw is None:
        return None
    names = inp.channel_names
    n = inp.n_channels

    def index(item: Any) -> int:
        if isinstance(item, str):
            if item not in names:
                raise MetricInputError(
                    MetricStatus.INVALID_INPUT, "unknown_channel", f"channel {item!r} not found"
                )
            return names.index(item)
        return int(item)

    pairs: list[tuple[int, int]] = []
    for pair in raw:
        if not isinstance(pair, Sequence) or isinstance(pair, str) or len(pair) != 2:
            raise MetricInputError(
                MetricStatus.INVALID_INPUT, "invalid_pair", f"pair {pair!r} is not [source, target]"
            )
        s, t = index(pair[0]), index(pair[1])
        if not (0 <= s < n and 0 <= t < n) or s == t:
            raise MetricInputError(
                MetricStatus.INVALID_INPUT, "invalid_pair", f"pair {pair!r} out of range or self"
            )
        pairs.append((s, t))
    if not pairs:
        raise MetricInputError(MetricStatus.INVALID_INPUT, "invalid_pair", "pairs is empty")
    return pairs


def _result(
    metric_id: str,
    variant: str,
    inp: EpochInput,
    values: np.ndarray,
    *,
    parameters: dict[str, Any],
    backend: str,
    validity_flags: list[str],
    diagnostics: dict[str, Any],
) -> MetricResult:
    values = np.array(values, dtype=np.float64)
    np.fill_diagonal(values, np.nan)
    return MetricResult(
        metric_id=metric_id,
        status=MetricStatus.OK,
        variant=variant,
        analysis_space=inp.analysis_space,
        units="nats",
        axes=DIRECTED_AXES,
        parameters={
            "channel_names": inp.channel_names,
            "sfreq": inp.sfreq,
            "diagonal": DIAGONAL_POLICY,
            "matrix_convention": MATRIX_CONVENTION,
            **parameters,
        },
        input_artifact_id=inp.input_artifact_id,
        backend=backend,
        backend_version=np.__version__,
        n_samples=inp.n_epochs * inp.n_times,
        n_epochs=inp.n_epochs,
        validity_flags=sorted(set(validity_flags)),
        values=values,
        diagnostics={"value_shape": list(values.shape), **diagnostics},
    )


def _refused(
    metric_id: str,
    variant: str,
    status: str,
    reason: str | None,
    message: str | None,
    diagnostics: dict[str, Any] | None = None,
) -> MetricResult:
    return MetricResult.from_status(
        metric_id,
        MetricStatus(status),
        reason or "ineligible",
        variant=variant,
        message=message,
        diagnostics=diagnostics or {},
    )


def _guard(metric_id: str, variant: str, fn: Callable[[Any, Any], MetricResult]) -> Callable:
    def adapter(data: Any, ctx: Any) -> MetricResult:
        try:
            return fn(data, ctx)
        except MetricInputError as exc:
            return MetricResult.from_status(
                metric_id, exc.status, exc.reason_code, variant=variant, message=str(exc)
            )

    adapter.__name__ = f"{metric_id.lower()}_{variant}_adapter"
    adapter.__doc__ = fn.__doc__
    return adapter


# --------------------------------------------------------------------------- M27


def _order_spec(params: dict[str, Any]) -> int | str:
    order = params.get("order", "bic")
    if isinstance(order, str):
        if order not in ("aic", "bic"):
            raise MetricInputError(
                MetricStatus.INVALID_INPUT, "invalid_order", "order must be int, 'aic' or 'bic'"
            )
        return order
    if int(order) < 1:
        raise MetricInputError(MetricStatus.INVALID_INPUT, "invalid_order", "order must be >= 1")
    return int(order)


def _gc_adapter(variant: str) -> Callable[[Any, Any], MetricResult]:
    def compute(data: Any, ctx: Any) -> MetricResult:
        inp = prepare_epochs(data, ctx, min_epochs=1)
        params = inp.params
        order = _order_spec(params)
        kwargs: dict[str, Any] = {
            "max_order": int(params.get("max_order", granger.DEFAULT_MAX_ORDER)),
            "min_obs_per_param": float(
                params.get("min_obs_per_param", granger.DEFAULT_MIN_OBS_PER_PARAM)
            ),
        }
        if variant == "pairwise":
            pairs = _resolve_pairs(params.get("pairs"), inp)
            kwargs["pairs"] = pairs
            res = granger.pairwise_gc(inp.epochs, order, **kwargs)
        else:
            if params.get("pairs") is not None:
                raise MetricInputError(
                    MetricStatus.INVALID_INPUT,
                    "pairs_not_supported",
                    "conditional GC conditions on all channels; select channels upstream",
                )
            res = granger.conditional_gc(inp.epochs, order, **kwargs)
        if not res.ok or res.gc is None:
            return _refused(
                "M27",
                variant,
                res.status,
                res.reason_code,
                res.message,
                _diag_clean(res.diagnostics),
            )
        flags: list[str] = []
        diag: dict[str, Any] = {
            "p_values": _jsonable(res.p_values),
            "f_stat": _jsonable(res.f_stat),
            "df_num": _jsonable(res.df_num),
            "df_den": _jsonable(res.df_den),
            **_diag_clean(res.diagnostics),
        }
        if variant == "pairwise":
            flags.append("pairwise_common_input_not_removed")
            diag["order_matrix"] = _jsonable(res.order_matrix)
            if res.diagnostics.get("unstable_pair_models"):
                flags.append("var_unstable")
            frac = res.diagnostics.get("fraction_pair_models_nonwhite_at_0.05")
            if frac:
                flags.append("residuals_not_white")
            if res.diagnostics.get("ineligible_pairs"):
                flags.append("some_pairs_ineligible")
        else:
            var = res.diagnostics["var"]
            if not var["stable"]:
                flags.append("var_unstable")
            if var["whiteness"]["fraction_rejected_at_0.05"]:
                flags.append("residuals_not_white")
        if params.get("time_reversed"):
            tr = granger.time_reversed_gc(inp.epochs, res.order or order, mode=variant, **kwargs)
            diag["time_reversed"] = {
                "status": tr.status,
                "reason_code": tr.reason_code,
                "gc_reversed": _jsonable(tr.reversed.gc if tr.reversed else None),
                "net_forward_minus_reversed": _jsonable(tr.net),
                "dominance_forward": _jsonable(tr.dominance_forward),
                "dominance_reversed": _jsonable(tr.dominance_reversed),
                "reading": "a lagged interaction flips dominance sign; mixing does not",
            }
        parameters = {
            "mode": variant,
            "order": res.diagnostics.get("order_spec"),
            "selected_order": res.order,
            "max_order": kwargs["max_order"],
            "min_obs_per_param": kwargs["min_obs_per_param"],
            "definition": "ln(RSS_restricted / RSS_full), OLS VAR with intercept",
            "test": "F test on the source's lag coefficients",
            "epoch_handling": "per-epoch demeaning; lags never cross epoch boundaries",
            "declared_pairs": [list(p) for p in kwargs["pairs"]] if kwargs.get("pairs") else None,
        }
        return _result(
            "M27",
            variant,
            inp,
            res.gc,
            parameters=parameters,
            backend="neurobridge.flow.granger (numpy/scipy OLS)",
            validity_flags=flags,
            diagnostics=diag,
        )

    return compute


def _diag_clean(diag: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in diag.items():
        if isinstance(value, np.ndarray):
            out[key] = _jsonable(value)
        elif isinstance(value, float) and not np.isfinite(value):
            out[key] = None
        else:
            out[key] = value
    return out


# --------------------------------------------------------------------------- M28


def _te_adapter(variant: str) -> Callable[[Any, Any], MetricResult]:
    def compute(data: Any, ctx: Any) -> MetricResult:
        inp = prepare_epochs(data, ctx, min_epochs=1)
        params = inp.params
        k_hist = int(params.get("k_hist", 1))
        l_hist = int(params.get("l_hist", 1))
        lag = int(params.get("lag", 1))
        if min(k_hist, l_hist, lag) < 1:
            raise MetricInputError(
                MetricStatus.INVALID_INPUT, "invalid_embedding", "k_hist, l_hist, lag >= 1"
            )
        pairs = _resolve_pairs(params.get("pairs"), inp)
        n = inp.n_channels
        max_auto = int(params.get("max_auto_pairs", DEFAULT_MAX_AUTO_PAIRS))
        if variant == "ksg" and pairs is None and n * (n - 1) > max_auto:
            raise MetricInputError(
                MetricStatus.INVALID_INPUT,
                "pairs_required",
                f"KSG over all {n * (n - 1)} ordered pairs is expensive; declare 'pairs' "
                f"(auto-all only up to {max_auto} pairs)",
            )
        n_surrogates = int(params.get("n_surrogates", 0))
        kwargs: dict[str, Any] = {}
        if variant == "ksg":
            kwargs = {
                "k_neighbors": int(params.get("k_neighbors", te.DEFAULT_K_NEIGHBORS)),
                "theiler": int(params.get("theiler", 0)),
                "seed": int(params.get("seed", 0)),
            }
        if n_surrogates > 0:
            kwargs["seed"] = int(params.get("seed", 0))
        out = te.te_matrix(
            inp.epochs,
            pairs,
            estimator=variant,
            k_hist=k_hist,
            l_hist=l_hist,
            lag=lag,
            n_surrogates=n_surrogates,
            **kwargs,
        )
        if out["n_samples"] is None:
            first = next(iter(out["failures"].values()))
            return _refused(
                "M28",
                variant,
                first["status"],
                first["reason_code"],
                first["message"],
                {"failures": out["failures"]},
            )
        flags = ["pairwise_common_input_not_removed"]
        if n_surrogates == 0 and variant == "ksg":
            flags.append("no_surrogate_test")
        if variant == "ksg":
            flags.append("ksg_finite_sample_bias_uncorrected")
        if out["failures"]:
            flags.append("some_pairs_ineligible")
        parameters = {
            "estimator": variant,
            "k_hist": k_hist,
            "l_hist": l_hist,
            "lag": lag,
            "n_surrogates": n_surrogates,
            "bits_per_nat": float(te.NATS_TO_BITS),
            "definition": "I(Y_t ; X_past | Y_past)",
            "p_value_method": out["p_value_method"],
            "declared_pairs": [list(p) for p in pairs] if pairs else None,
            **({"bias_note": te.KSG_BIAS_NOTE} if variant == "ksg" else {}),
            **kwargs,
        }
        diag = {
            "p_values": _jsonable(out["p_values"]),
            "surrogate_null_mean": _jsonable(out["null_mean"]) if n_surrogates else None,
            "n_embedded_samples": out["n_samples"],
            "failures": out["failures"],
        }
        backend = (
            "neurobridge.flow.transfer_entropy (Gaussian closed form)"
            if variant == "gaussian"
            else "neurobridge.flow.transfer_entropy (KSG, scipy cKDTree max-norm)"
        )
        return _result(
            "M28",
            variant,
            inp,
            out["te"],
            parameters=parameters,
            backend=backend,
            validity_flags=flags,
            diagnostics=diag,
        )

    return compute


ADAPTERS: dict[tuple[str, str], Callable[[Any, Any], MetricResult]] = {
    ("M27", "pairwise"): _guard("M27", "pairwise", _gc_adapter("pairwise")),
    ("M27", "conditional"): _guard("M27", "conditional", _gc_adapter("conditional")),
    ("M28", "gaussian"): _guard("M28", "gaussian", _te_adapter("gaussian")),
    ("M28", "ksg"): _guard("M28", "ksg", _te_adapter("ksg")),
}
DEFAULT_VARIANTS = {"M27": "pairwise", "M28": "gaussian"}

for (_metric_id, _variant), _fn in ADAPTERS.items():
    registry.register(
        _metric_id, _variant, _fn, default=DEFAULT_VARIANTS[_metric_id] == _variant, replace=True
    )
