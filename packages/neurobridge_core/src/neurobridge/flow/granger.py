"""Time-domain Granger causality from OLS vector autoregression (numpy/scipy only).

Concept (source document §A): A Granger-causes B when A's past improves the prediction of
B's future beyond what B's own past (and, for conditional GC, every other observed channel's
past) already gives. It is a statement about *prediction*, not about mechanism: an
unobserved common driver, volume conduction or a too-short lag can all produce GC without a
causal edge. GC here is::

    G[target, source] = ln(RSS_restricted / RSS_full)   (nats, >= 0 for nested OLS)

where the restricted model drops the source's lags. The F statistic for the dropped
coefficients gives the p-value.

Input layout
------------
``x`` is ``(n_channels, n_times)`` (one segment), ``(n_epochs, n_channels, n_times)``, or a
concatenated ``(n_channels, n_epochs * epoch_length)`` array with ``epoch_length`` given.
Lagged regressors never cross an epoch boundary: each epoch contributes rows
``t = start .. T-1`` with lags taken inside that epoch only. Every channel is demeaned per
epoch (``demean=True``) and the regression keeps an intercept.

Matrices are ``[target, source]`` (row = predicted channel, column = predictor), diagonal
NaN, undeclared / ineligible pairs NaN. Values are never clipped or ``abs``-ed. An
ineligible computation returns ``status`` != ``"ok"`` with a reason and no matrix.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from scipy import linalg, stats

GC_UNITS = "nats (ln residual-variance ratio)"
Criterion = Literal["aic", "bic"]
OrderSpec = int | str
DEFAULT_MAX_ORDER = 10
DEFAULT_MIN_OBS_PER_PARAM = 10
DEFAULT_RANK_TOL = 1e-8
WHITENESS_ALPHA = 0.05


# --------------------------------------------------------------------------- input helpers


def as_epochs(x: Any, epoch_length: int | None = None) -> np.ndarray:
    """Return a float64 ``(n_epochs, n_channels, n_times)`` copy of ``x``.

    Raises ``ValueError`` for malformed input (wrong ndim, non-finite values, a concatenated
    array whose length is not a multiple of ``epoch_length``).
    """
    arr = np.array(x, dtype=np.float64)
    if arr.ndim == 2:
        if epoch_length is not None:
            n_ch, n_t = arr.shape
            if epoch_length <= 0 or n_t % epoch_length:
                raise ValueError(f"{n_t} samples are not a multiple of epoch_length={epoch_length}")
            arr = arr.reshape(n_ch, n_t // epoch_length, epoch_length).transpose(1, 0, 2)
        else:
            arr = arr[np.newaxis]
    if arr.ndim != 3:
        raise ValueError(
            f"expected (channels, times) or (epochs, channels, times), got {arr.shape}"
        )
    if not np.all(np.isfinite(arr)):
        raise ValueError("data contains NaN or inf")
    return np.ascontiguousarray(arr)


def _demean(epochs: np.ndarray) -> np.ndarray:
    return epochs - epochs.mean(axis=-1, keepdims=True)


@dataclass
class _Design:
    y: np.ndarray  # (N, n) targets
    z: np.ndarray  # (N, 1 + n * order) [intercept, lag1 ch0..ch(n-1), lag2 ..., ...]
    sizes: list[int]  # rows contributed per epoch (residual whiteness is computed per epoch)
    order: int
    n_vars: int


def lagged_design(epochs: np.ndarray, order: int, start: int | None = None) -> _Design:
    """Lag-major design: column ``1 + (k - 1) * n + c`` holds channel ``c`` at lag ``k``.

    ``start`` (>= ``order``) is the first predicted sample of every epoch; order selection
    uses a common ``start = max_order`` so that all candidate orders see the same rows.
    """
    start = order if start is None else int(start)
    if order < 1 or start < order:
        raise ValueError("need order >= 1 and start >= order")
    n_vars = epochs.shape[1]
    ys, zs, sizes = [], [], []
    for ep in epochs:
        n_t = ep.shape[1]
        if n_t <= start:
            continue
        lags = [ep[:, start - k : n_t - k].T for k in range(1, order + 1)]
        ys.append(ep[:, start:].T)
        zs.append(np.concatenate(lags, axis=1))
        sizes.append(n_t - start)
    if not ys:
        empty = np.empty((0, n_vars))
        return _Design(empty, np.empty((0, 1 + n_vars * order)), [], order, n_vars)
    y = np.concatenate(ys, axis=0)
    z = np.concatenate(zs, axis=0)
    z = np.column_stack([np.ones(z.shape[0]), z])
    return _Design(y, z, sizes, order, n_vars)


def _columns(n_vars: int, order: int, keep: Sequence[int]) -> list[int]:
    return [0] + [1 + (k - 1) * n_vars + c for k in range(1, order + 1) for c in keep]


def _ols(z: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    coef, *_ = linalg.lstsq(z, y, lapack_driver="gelsy", check_finite=False)
    resid = y - z @ coef
    return coef, resid, np.einsum("ij,ij->j", resid, resid)


# --------------------------------------------------------------------------- eligibility


def check_eligibility(
    epochs: np.ndarray,
    order: int,
    *,
    min_obs_per_param: float = DEFAULT_MIN_OBS_PER_PARAM,
    rank_tol: float = DEFAULT_RANK_TOL,
) -> dict[str, Any]:
    """Sample-size and rank check for a VAR on all channels of ``epochs``.

    ``ok`` needs ``n_obs >= min_obs_per_param * (n_channels * order + 1)`` and a full-rank
    channel covariance. Average-referenced EEG has rank ``n - 1`` and is refused for a
    model on *all* channels (``invalid_input`` / ``rank_deficient``), never silently fitted.
    """
    _, n_vars, n_t = epochs.shape
    n_obs = int(epochs.shape[0] * max(n_t - order, 0))
    n_params = n_vars * order + 1
    flat = _demean(epochs).transpose(1, 0, 2).reshape(n_vars, -1)
    sv = linalg.svdvals(flat, check_finite=False)
    rank = int(np.sum(sv > rank_tol * sv[0])) if sv.size and sv[0] > 0 else 0
    info: dict[str, Any] = {
        "n_obs": n_obs,
        "n_channels": n_vars,
        "order": order,
        "n_params_per_equation": n_params,
        "min_obs_per_param": min_obs_per_param,
        "data_rank": rank,
        "rank_tol": rank_tol,
    }
    if n_obs < min_obs_per_param * n_params:
        return {
            **info,
            "status": "insufficient_data",
            "reason_code": "too_few_samples_for_var",
            "message": (
                f"{n_obs} usable samples < {min_obs_per_param} x {n_params} parameters per "
                f"equation (n_channels={n_vars}, order={order})"
            ),
        }
    if rank < n_vars:
        return {
            **info,
            "status": "invalid_input",
            "reason_code": "rank_deficient",
            "message": (
                f"data rank {rank} < {n_vars} channels (e.g. average reference removes one "
                "dimension); drop a channel or use pairwise GC"
            ),
        }
    return {**info, "status": "ok", "reason_code": None, "message": None}


# --------------------------------------------------------------------------- VAR fit


def ljung_box(
    residuals: np.ndarray, sizes: Sequence[int], *, lags: int, fitted_order: int
) -> dict[str, Any]:
    """Per-channel Ljung-Box portmanteau test of residual whiteness.

    Autocorrelations are pooled over epochs without crossing epoch boundaries;
    ``df = max(lags - fitted_order, 1)`` (heuristic for a VAR's univariate residual series).
    """
    n_vars = residuals.shape[1]
    num = np.zeros((lags, n_vars))
    denom = np.zeros(n_vars)
    pos = 0
    for size in sizes:
        r = residuals[pos : pos + size]
        pos += size
        denom += np.einsum("ij,ij->j", r, r)
        for h in range(1, min(lags, size - 1) + 1):
            num[h - 1] += np.einsum("ij,ij->j", r[h:], r[:-h])
    n_total = residuals.shape[0]
    with np.errstate(invalid="ignore", divide="ignore"):
        rho = num / denom
    h_idx = np.arange(1, lags + 1)[:, None]
    q = n_total * (n_total + 2) * np.sum(rho**2 / (n_total - h_idx), axis=0)
    df = max(lags - fitted_order, 1)
    p = stats.chi2.sf(q, df)
    return {
        "test": "Ljung-Box per channel (pooled within epochs)",
        "lags": lags,
        "df": df,
        "q": q.tolist(),
        "p_values": p.tolist(),
        "min_p": float(np.min(p)) if p.size else None,
        "fraction_rejected_at_0.05": float(np.mean(p < WHITENESS_ALPHA)) if p.size else None,
    }


@dataclass
class VARFit:
    """OLS VAR(p) fit. ``coefs[k - 1][target, source]`` is the lag-``k`` coefficient."""

    order: int
    coefs: np.ndarray  # (order, n, n)
    intercept: np.ndarray  # (n,)
    residuals: np.ndarray  # (N, n)
    sigma: np.ndarray  # unbiased residual covariance RSS / (N - K)
    sigma_ml: np.ndarray  # ML residual covariance RSS / N
    rss: np.ndarray  # (n,)
    n_obs: int
    n_channels: int
    n_params_per_equation: int
    log_likelihood: float
    aic: float
    bic: float
    stable: bool
    max_eigenvalue_modulus: float
    whiteness: dict[str, Any]

    def diagnostics(self) -> dict[str, Any]:
        return {
            "order": self.order,
            "n_obs": self.n_obs,
            "n_params_per_equation": self.n_params_per_equation,
            "log_likelihood": self.log_likelihood,
            "aic": self.aic,
            "bic": self.bic,
            "stable": self.stable,
            "max_companion_eigenvalue_modulus": self.max_eigenvalue_modulus,
            "whiteness": self.whiteness,
        }


def _info_criteria(sigma_ml: np.ndarray, n_obs: int, n_vars: int, order: int) -> tuple[float, ...]:
    sign, logdet = np.linalg.slogdet(sigma_ml)
    logdet = logdet if sign > 0 else float("nan")
    k = n_vars * n_vars * order
    aic = logdet + 2.0 * k / n_obs
    bic = logdet + k * np.log(n_obs) / n_obs
    loglik = -0.5 * n_obs * (n_vars * np.log(2 * np.pi) + logdet + n_vars)
    return float(aic), float(bic), float(loglik)


def companion_max_modulus(coefs: np.ndarray) -> float:
    order, n, _ = coefs.shape
    comp = np.zeros((n * order, n * order))
    comp[:n, :] = np.concatenate(list(coefs), axis=1)
    if order > 1:
        comp[n:, :-n] = np.eye(n * (order - 1))
    return float(np.max(np.abs(np.linalg.eigvals(comp))))


def _fit_design(design: _Design, whiteness_lags: int | None) -> VARFit:
    n, p = design.n_vars, design.order
    coef, resid, rss = _ols(design.z, design.y)
    n_obs, k_params = design.z.shape
    coefs = coef[1:].reshape(p, n, n).transpose(0, 2, 1)
    sigma_ml = resid.T @ resid / n_obs
    sigma = resid.T @ resid / max(n_obs - k_params, 1)
    aic, bic, loglik = _info_criteria(sigma_ml, n_obs, n, p)
    modulus = companion_max_modulus(coefs)
    lags = whiteness_lags if whiteness_lags is not None else max(p + 10, 20)
    return VARFit(
        order=p,
        coefs=coefs,
        intercept=coef[0].copy(),
        residuals=resid,
        sigma=sigma,
        sigma_ml=sigma_ml,
        rss=rss,
        n_obs=int(n_obs),
        n_channels=n,
        n_params_per_equation=int(k_params),
        log_likelihood=loglik,
        aic=aic,
        bic=bic,
        stable=bool(modulus < 1.0),
        max_eigenvalue_modulus=modulus,
        whiteness=ljung_box(resid, design.sizes, lags=lags, fitted_order=p),
    )


def fit_var(
    x: Any,
    order: int,
    *,
    epoch_length: int | None = None,
    demean: bool = True,
    whiteness_lags: int | None = None,
) -> VARFit:
    """OLS VAR(``order``) on all channels with an intercept, epochs never crossed."""
    epochs = as_epochs(x, epoch_length)
    if demean:
        epochs = _demean(epochs)
    design = lagged_design(epochs, int(order))
    if design.y.shape[0] <= design.z.shape[1]:
        raise ValueError("not enough samples for this VAR order")
    return _fit_design(design, whiteness_lags)


@dataclass
class OrderSelection:
    status: str
    criterion: str
    order: int | None
    orders: list[int] = field(default_factory=list)
    aic: list[float] = field(default_factory=list)
    bic: list[float] = field(default_factory=list)
    common_start: int | None = None
    reason_code: str | None = None
    message: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "criterion": self.criterion,
            "selected_order": self.order,
            "orders": self.orders,
            "aic": self.aic,
            "bic": self.bic,
            "common_start": self.common_start,
            "reason_code": self.reason_code,
        }


def _select_on_epochs(
    epochs: np.ndarray, max_order: int, criterion: str, min_obs_per_param: float
) -> OrderSelection:
    if criterion not in ("aic", "bic"):
        raise ValueError(f"criterion must be 'aic' or 'bic', got {criterion!r}")
    n_vars = epochs.shape[1]
    design = lagged_design(epochs, max_order)
    n_obs = design.y.shape[0]
    candidates = [
        p for p in range(1, max_order + 1) if n_obs >= min_obs_per_param * (n_vars * p + 1)
    ]
    if not candidates:
        return OrderSelection(
            "insufficient_data",
            criterion,
            None,
            common_start=max_order,
            reason_code="too_few_samples_for_var",
            message=f"{n_obs} samples are too few for any order 1..{max_order}",
        )
    aics, bics = [], []
    for p in candidates:
        _, resid, _ = _ols(design.z[:, : 1 + n_vars * p], design.y)
        aic, bic, _ = _info_criteria(resid.T @ resid / n_obs, n_obs, n_vars, p)
        aics.append(aic)
        bics.append(bic)
    scores = np.asarray(aics if criterion == "aic" else bics)
    if not np.any(np.isfinite(scores)):
        return OrderSelection(
            "invalid_input",
            criterion,
            None,
            candidates,
            aics,
            bics,
            max_order,
            "singular_residual_covariance",
            "residual covariance is singular for every order",
        )
    best = candidates[int(np.nanargmin(scores))]
    return OrderSelection("ok", criterion, best, candidates, aics, bics, max_order)


def select_order(
    x: Any,
    max_order: int = DEFAULT_MAX_ORDER,
    criterion: Criterion = "bic",
    *,
    epoch_length: int | None = None,
    demean: bool = True,
    min_obs_per_param: float = DEFAULT_MIN_OBS_PER_PARAM,
) -> OrderSelection:
    """Pick the VAR order in ``1..max_order`` minimising AIC or BIC on a common sample."""
    epochs = as_epochs(x, epoch_length)
    if demean:
        epochs = _demean(epochs)
    return _select_on_epochs(epochs, int(max_order), criterion, min_obs_per_param)


# --------------------------------------------------------------------------- GC


@dataclass
class GrangerResult:
    """GC matrices are ``[target, source]``; ``None`` unless ``status == "ok"``."""

    status: str
    mode: str
    reason_code: str | None = None
    message: str | None = None
    gc: np.ndarray | None = None
    f_stat: np.ndarray | None = None
    p_values: np.ndarray | None = None
    df_num: np.ndarray | None = None
    df_den: np.ndarray | None = None
    order: int | None = None  # common order (conditional) / None if pair-specific
    order_matrix: np.ndarray | None = None  # per-pair order (pairwise)
    n_obs: int | None = None
    units: str = GC_UNITS
    diagnostics: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def _refuse(mode: str, status: str, reason: str, message: str, **diag: Any) -> GrangerResult:
    return GrangerResult(status, mode, reason, message, diagnostics=diag)


def _f_test(rss_r: float, rss_f: float, q: int, df_den: int) -> tuple[float, float]:
    f = ((rss_r - rss_f) / q) / (rss_f / df_den)
    return float(f), float(stats.f.sf(f, q, df_den))


def _normalise_pairs(pairs: Iterable[Sequence[int]] | None, n: int) -> list[tuple[int, int]]:
    if pairs is None:
        return [(s, t) for t in range(n) for s in range(n) if s != t]
    out = []
    for pair in pairs:
        s, t = (int(pair[0]), int(pair[1]))
        if not (0 <= s < n and 0 <= t < n) or s == t:
            raise ValueError(f"invalid (source, target) pair {pair!r} for {n} channels")
        out.append((s, t))
    return out


def _pairwise_core(
    epochs: np.ndarray,
    pairs: list[tuple[int, int]],
    pair_orders: dict[tuple[int, int], int],
    *,
    min_obs_per_param: float,
    rank_tol: float,
    whiteness_lags: int | None,
) -> GrangerResult:
    n = epochs.shape[1]
    gc, f_mat, p_mat, d1, d2, o_mat = (np.full((n, n), np.nan) for _ in range(6))
    ineligible: dict[str, dict[str, Any]] = {}
    unstable, nonwhite_min_p, n_models = [], [], 0
    fits: dict[tuple[int, int], tuple[np.ndarray, np.ndarray, int, int]] = {}
    for s, t in pairs:
        key = (min(s, t), max(s, t))
        if key in ineligible:
            continue
        if key not in fits:
            p = pair_orders[key]
            sub = epochs[:, list(key)]
            check = check_eligibility(
                sub, p, min_obs_per_param=min_obs_per_param, rank_tol=rank_tol
            )
            if check["status"] != "ok":
                ineligible[f"{key[0]}-{key[1]}"] = {
                    k: check[k] for k in ("status", "reason_code", "message")
                }
                continue
            design = lagged_design(sub, p)
            fit = _fit_design(design, whiteness_lags)
            n_models += 1
            if not fit.stable:
                unstable.append([key[0], key[1]])
            nonwhite_min_p.append(fit.whiteness["min_p"])
            rss_r = np.array(
                [_ols(design.z[:, _columns(2, p, [c])], design.y[:, [c]])[2][0] for c in (0, 1)]
            )
            fits[key] = (fit.rss, rss_r, p, fit.n_obs)
        rss_f, rss_r, p, n_obs = fits[key]
        c = 0 if t == key[0] else 1
        df_den = n_obs - (2 * p + 1)
        gc[t, s] = np.log(rss_r[c] / rss_f[c])
        f_mat[t, s], p_mat[t, s] = _f_test(rss_r[c], rss_f[c], p, df_den)
        d1[t, s], d2[t, s], o_mat[t, s] = p, df_den, p
    if not fits:
        first = next(iter(ineligible.values()))
        return _refuse(
            "pairwise",
            first["status"],
            first["reason_code"],
            first["message"],
            ineligible_pairs=ineligible,
        )
    whites = [v for v in nonwhite_min_p if v is not None]
    diagnostics = {
        "n_pair_models": n_models,
        "unstable_pair_models": unstable,
        "min_whiteness_p": float(min(whites)) if whites else None,
        "fraction_pair_models_nonwhite_at_0.05": (
            float(np.mean(np.asarray(whites) < WHITENESS_ALPHA)) if whites else None
        ),
        "ineligible_pairs": ineligible,
        "caveat": "pairwise GC does not remove unobserved or unmodelled common input",
    }
    return GrangerResult(
        "ok",
        "pairwise",
        gc=gc,
        f_stat=f_mat,
        p_values=p_mat,
        df_num=d1,
        df_den=d2,
        order_matrix=o_mat,
        n_obs=None,
        diagnostics=diagnostics,
    )


def pairwise_gc(
    x: Any,
    order: OrderSpec = "bic",
    *,
    pairs: Iterable[Sequence[int]] | None = None,
    max_order: int = DEFAULT_MAX_ORDER,
    epoch_length: int | None = None,
    demean: bool = True,
    min_obs_per_param: float = DEFAULT_MIN_OBS_PER_PARAM,
    rank_tol: float = DEFAULT_RANK_TOL,
    whiteness_lags: int | None = None,
) -> GrangerResult:
    """Bivariate GC for each declared ``(source, target)`` pair (default: all ordered pairs).

    Full model: VAR of ``[target, source]``; restricted: AR of ``target`` alone. With
    ``order='aic'|'bic'`` the order is selected per unordered pair on the bivariate model.
    """
    epochs = as_epochs(x, epoch_length)
    if demean:
        epochs = _demean(epochs)
    n = epochs.shape[1]
    if n < 2:
        return _refuse("pairwise", "insufficient_data", "too_few_channels", "need >= 2 channels")
    pair_list = _normalise_pairs(pairs, n)
    pair_orders: dict[tuple[int, int], int] = {}
    selections: dict[str, Any] = {}
    for s, t in pair_list:
        key = (min(s, t), max(s, t))
        if key in pair_orders:
            continue
        if isinstance(order, str):
            sel = _select_on_epochs(epochs[:, list(key)], max_order, order, min_obs_per_param)
            selections[f"{key[0]}-{key[1]}"] = sel.as_dict()
            # an unselectable pair falls through to the eligibility refusal at order 1
            pair_orders[key] = sel.order if sel.order is not None else 1
        else:
            pair_orders[key] = int(order)
    result = _pairwise_core(
        epochs,
        pair_list,
        pair_orders,
        min_obs_per_param=min_obs_per_param,
        rank_tol=rank_tol,
        whiteness_lags=whiteness_lags,
    )
    result.diagnostics["order_spec"] = order if isinstance(order, str) else int(order)
    if selections:
        result.diagnostics["order_selection"] = selections
    if result.ok and not isinstance(order, str):
        result.order = int(order)
    return result


def _conditional_core(epochs: np.ndarray, order: int, whiteness_lags: int | None) -> GrangerResult:
    n = epochs.shape[1]
    design = lagged_design(epochs, order)
    fit = _fit_design(design, whiteness_lags)
    rss_f = fit.rss
    n_obs, k_full = design.z.shape
    df_den = n_obs - k_full
    gc, f_mat, p_mat = (np.full((n, n), np.nan) for _ in range(3))
    for s in range(n):
        keep = [c for c in range(n) if c != s]
        _, _, rss_r = _ols(design.z[:, _columns(n, order, keep)], design.y)
        for t in keep:
            gc[t, s] = np.log(rss_r[t] / rss_f[t])
            f_mat[t, s], p_mat[t, s] = _f_test(rss_r[t], rss_f[t], order, df_den)
    off = ~np.eye(n, dtype=bool)
    d1 = np.where(off, float(order), np.nan)
    d2 = np.where(off, float(df_den), np.nan)
    return GrangerResult(
        "ok",
        "conditional",
        gc=gc,
        f_stat=f_mat,
        p_values=p_mat,
        df_num=d1,
        df_den=d2,
        order=order,
        n_obs=n_obs,
        diagnostics={"var": fit.diagnostics()},
    )


def conditional_gc(
    x: Any,
    order: OrderSpec = "bic",
    *,
    conditioning: str = "all",
    max_order: int = DEFAULT_MAX_ORDER,
    epoch_length: int | None = None,
    demean: bool = True,
    min_obs_per_param: float = DEFAULT_MIN_OBS_PER_PARAM,
    rank_tol: float = DEFAULT_RANK_TOL,
    whiteness_lags: int | None = None,
) -> GrangerResult:
    """Multivariate (conditional) GC: source -> target given the past of all other channels.

    One full VAR on every channel; for each source the restricted model drops only that
    source's lags. Refuses (status, no values) when the sample is too small for
    ``n_channels * order + 1`` parameters per equation or the data are rank-deficient.
    """
    if conditioning != "all":
        raise ValueError("only conditioning='all' (every other observed channel) is supported")
    epochs = as_epochs(x, epoch_length)
    if demean:
        epochs = _demean(epochs)
    n = epochs.shape[1]
    if n < 2:
        return _refuse("conditional", "insufficient_data", "too_few_channels", "need >= 2")
    selection = None
    if isinstance(order, str):
        selection = _select_on_epochs(epochs, max_order, order, min_obs_per_param)
        if selection.order is None:
            return _refuse(
                "conditional",
                selection.status,
                selection.reason_code or "order_selection",
                selection.message or "order selection failed",
                order_selection=selection.as_dict(),
            )
        p = selection.order
    else:
        p = int(order)
    check = check_eligibility(epochs, p, min_obs_per_param=min_obs_per_param, rank_tol=rank_tol)
    if check["status"] != "ok":
        return _refuse(
            "conditional",
            check["status"],
            check["reason_code"],
            check["message"],
            eligibility=check,
        )
    result = _conditional_core(epochs, p, whiteness_lags)
    result.diagnostics["eligibility"] = check
    result.diagnostics["conditioning"] = "all other observed channels"
    result.diagnostics["order_spec"] = order if isinstance(order, str) else int(order)
    if selection is not None:
        result.diagnostics["order_selection"] = selection.as_dict()
    return result


@dataclass
class TimeReversedGC:
    """Forward GC, GC of the time-reversed data and ``net = forward - reversed``.

    Reading (Haufe/Winkler time-reversal test): a genuine lagged interaction makes the
    directional dominance ``D = G - G.T`` change sign under time reversal, whereas
    instantaneous mixing (volume conduction) produces similar GC forward and reversed, so
    ``net`` stays near 0. This is a diagnostic kept separate from the GC values.
    """

    status: str
    forward: GrangerResult
    reversed: GrangerResult | None
    net: np.ndarray | None = None
    dominance_forward: np.ndarray | None = None
    dominance_reversed: np.ndarray | None = None
    reason_code: str | None = None
    message: str | None = None


def time_reversed_gc(
    x: Any,
    order: OrderSpec = "bic",
    *,
    mode: Literal["pairwise", "conditional"] = "pairwise",
    epoch_length: int | None = None,
    **kwargs: Any,
) -> TimeReversedGC:
    """Run GC on ``x`` and on ``x[..., ::-1]`` with the same (forward-selected) orders."""
    epochs = as_epochs(x, epoch_length)
    rev = np.ascontiguousarray(epochs[..., ::-1])
    if mode == "pairwise":
        fwd = pairwise_gc(epochs, order, **kwargs)
        if not fwd.ok:
            return TimeReversedGC(
                fwd.status, fwd, None, reason_code=fwd.reason_code, message=fwd.message
            )
        assert fwd.order_matrix is not None
        n = epochs.shape[1]
        declared = [
            (s, t)
            for t in range(n)
            for s in range(n)
            if s != t and np.isfinite(fwd.order_matrix[t, s])
        ]
        pair_orders = {(min(s, t), max(s, t)): int(fwd.order_matrix[t, s]) for s, t in declared}
        rv_epochs = _demean(rev) if kwargs.get("demean", True) else rev
        rv = _pairwise_core(
            rv_epochs,
            declared,
            pair_orders,
            min_obs_per_param=kwargs.get("min_obs_per_param", DEFAULT_MIN_OBS_PER_PARAM),
            rank_tol=kwargs.get("rank_tol", DEFAULT_RANK_TOL),
            whiteness_lags=kwargs.get("whiteness_lags"),
        )
    elif mode == "conditional":
        fwd = conditional_gc(epochs, order, **kwargs)
        if not fwd.ok:
            return TimeReversedGC(
                fwd.status, fwd, None, reason_code=fwd.reason_code, message=fwd.message
            )
        assert fwd.order is not None
        rv = conditional_gc(rev, fwd.order, **{k: v for k, v in kwargs.items() if k != "max_order"})
    else:
        raise ValueError("mode must be 'pairwise' or 'conditional'")
    if not rv.ok:
        return TimeReversedGC(rv.status, fwd, rv, reason_code=rv.reason_code, message=rv.message)
    assert fwd.gc is not None and rv.gc is not None
    return TimeReversedGC(
        "ok",
        fwd,
        rv,
        net=fwd.gc - rv.gc,
        dominance_forward=fwd.gc - fwd.gc.T,
        dominance_reversed=rv.gc - rv.gc.T,
    )


# --------------------------------------------------------------------------- spectral GC


@dataclass
class SpectralGCResult:
    status: str
    pairs: list[tuple[int, int]]
    freqs: np.ndarray | None = None
    spectra: np.ndarray | None = None  # (n_pairs, n_freqs), source -> target
    reason_code: str | None = None
    message: str | None = None
    backend: str = "mne_connectivity.spectral_connectivity_epochs(method='gc')"
    backend_version: str | None = None
    units: str = "nats per frequency (Geweke spectral GC)"


def spectral_gc(
    x: Any,
    sfreq: float,
    pairs: Iterable[Sequence[int]],
    *,
    fmin: float = 1.0,
    fmax: float | None = None,
    n_lags: int = 20,
    epoch_length: int | None = None,
) -> SpectralGCResult:
    """Optional frequency-resolved view via MNE-Connectivity's state-space GC (0.8.x).

    Each ``(source, target)`` pair is passed as a one-channel seed/target set. Backend
    errors become ``status='unsupported_dependency'`` / ``'failed'`` with the reason.
    """
    epochs = as_epochs(x, epoch_length)
    pair_list = _normalise_pairs(pairs, epochs.shape[1])
    try:
        import mne_connectivity
        from mne_connectivity import spectral_connectivity_epochs
    except ImportError as exc:  # pragma: no cover - core dependency
        return SpectralGCResult(
            "unsupported_dependency", pair_list, reason_code="dependency_missing", message=str(exc)
        )
    seeds = np.array([[s] for s, _ in pair_list])
    targets = np.array([[t] for _, t in pair_list])
    try:
        con = spectral_connectivity_epochs(
            epochs,
            method="gc",
            indices=(seeds, targets),
            sfreq=float(sfreq),
            fmin=fmin,
            fmax=fmax if fmax is not None else float(sfreq) / 2.0 - 1.0,
            gc_n_lags=int(n_lags),
            verbose=False,
        )
    except Exception as exc:  # backend limitations are a status, not a crash
        return SpectralGCResult(
            "failed",
            pair_list,
            reason_code="backend_error",
            message=f"{type(exc).__name__}: {str(exc)[:300]}",
        )
    return SpectralGCResult(
        "ok",
        pair_list,
        freqs=np.asarray(con.freqs, dtype=np.float64),
        spectra=np.asarray(con.get_data(), dtype=np.float64),
        backend_version=str(mne_connectivity.__version__),
    )
