"""Transfer entropy: Gaussian closed form and KSG nearest-neighbour estimator.

Concept (source document §B): transfer entropy measures how much the source's past reduces
uncertainty about the target's next value beyond the target's own past::

    TE(X -> Y) = I(Y_t ; X_past | Y_past)

with ``Y_past = (y_{t-1}, ..., y_{t-k_hist})`` and
``X_past = (x_{t-lag}, ..., x_{t-lag-l_hist+1})``. For jointly Gaussian (linear) processes
TE equals half the Granger causality with the same embedding (Barnett, Barrett & Seth
2009), so ``gaussian_te`` reproduces ``GC / 2``. The KSG estimator is model-free and can
detect non-linear coupling that linear GC misses, at the cost of bias and variance that
depend on sample size, dimension and ``k_neighbors``. Like GC, pairwise TE does not remove
unobserved common input.

Units are nats (``bits = nats / ln 2``). KSG estimates may be slightly negative under
independence (finite-sample bias); they are reported raw, never clipped. Input layouts are
those of :func:`neurobridge.flow.granger.as_epochs`; embeddings never cross epochs.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from scipy import stats
from scipy.spatial import cKDTree
from scipy.special import digamma

from neurobridge.flow.granger import as_epochs

TE_UNITS = "nats"
NATS_TO_BITS = 1.0 / np.log(2.0)
DEFAULT_K_NEIGHBORS = 4
KSG_BIAS_NOTE = (
    "KSG (algorithm 1, Frenzel-Pompe CMI) is consistent but biased at finite N; the bias "
    "grows with embedding dimension and shrinks with N. Compare against the surrogate null "
    "(null_mean) instead of reading the raw value as an absolute information amount."
)


@dataclass
class _Embedding:
    y_t: np.ndarray  # (N, 1)
    y_past: np.ndarray  # (N, k_hist)
    x_past: np.ndarray  # (N, l_hist)
    epoch: np.ndarray  # (N,) epoch index of each row
    time: np.ndarray  # (N,) sample index of y_t within its epoch


def embed(
    epochs: np.ndarray, source: int, target: int, k_hist: int, l_hist: int, lag: int
) -> _Embedding:
    """Delay embedding per epoch; rows start at ``max(k_hist, lag + l_hist - 1)``."""
    if k_hist < 1 or l_hist < 1 or lag < 1:
        raise ValueError("need k_hist >= 1, l_hist >= 1 and lag >= 1")
    start = max(k_hist, lag + l_hist - 1)
    yt, yp, xp, ep_idx, times = [], [], [], [], []
    for e, ep in enumerate(epochs):
        n_t = ep.shape[1]
        if n_t <= start:
            continue
        x, y = ep[source], ep[target]
        t = np.arange(start, n_t)
        yt.append(y[t][:, None])
        yp.append(np.column_stack([y[t - j] for j in range(1, k_hist + 1)]))
        xp.append(np.column_stack([x[t - lag - j] for j in range(l_hist)]))
        ep_idx.append(np.full(t.size, e))
        times.append(t)
    if not yt:
        raise ValueError("epochs are shorter than the embedding")
    return _Embedding(
        np.concatenate(yt),
        np.concatenate(yp),
        np.concatenate(xp),
        np.concatenate(ep_idx),
        np.concatenate(times),
    )


@dataclass
class SurrogateTest:
    """Circular-shift surrogate test: ``p = (b + 1) / (B + 1)``, ``b = #(null >= observed)``."""

    observed: float
    null: np.ndarray
    p_value: float
    n_surrogates: int
    min_shift: int
    method: str = "circular time-shift of the source within each epoch"

    @property
    def null_mean(self) -> float:
        return float(np.mean(self.null))

    @property
    def null_std(self) -> float:
        return float(np.std(self.null, ddof=1)) if self.null.size > 1 else float("nan")

    def as_dict(self) -> dict[str, Any]:
        return {
            "method": self.method,
            "n_surrogates": self.n_surrogates,
            "min_shift": self.min_shift,
            "p_value": self.p_value,
            "null_mean": self.null_mean,
            "null_std": self.null_std,
            "null_quantile_95": float(np.quantile(self.null, 0.95)),
        }


@dataclass
class TEResult:
    status: str
    estimator: str
    source: int
    target: int
    k_hist: int
    l_hist: int
    lag: int
    te: float | None = None  # nats
    n_samples: int | None = None
    p_value_analytic: float | None = None  # Gaussian likelihood-ratio chi2 test
    surrogate: SurrogateTest | None = None
    reason_code: str | None = None
    message: str | None = None
    units: str = TE_UNITS
    parameters: dict[str, Any] = field(default_factory=dict)

    @property
    def te_bits(self) -> float | None:
        return None if self.te is None else self.te * NATS_TO_BITS

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def _prep(x: Any, epoch_length: int | None, demean: bool) -> np.ndarray:
    epochs = as_epochs(x, epoch_length)
    return epochs - epochs.mean(axis=-1, keepdims=True) if demean else epochs


# --------------------------------------------------------------------------- Gaussian


def _logdet_cov(*blocks: np.ndarray) -> float:
    m = np.column_stack(blocks)
    cov = np.atleast_2d(np.cov(m, rowvar=False))
    sign, logdet = np.linalg.slogdet(cov)
    return float(logdet) if sign > 0 else float("nan")


def _gaussian_value(emb: _Embedding) -> float:
    """Closed-form Gaussian CMI from covariance log-determinants (entropy identity)."""
    return 0.5 * (
        _logdet_cov(emb.y_t, emb.y_past)
        - _logdet_cov(emb.y_past)
        - _logdet_cov(emb.y_t, emb.y_past, emb.x_past)
        + _logdet_cov(emb.y_past, emb.x_past)
    )


def gaussian_te(
    x: Any,
    source: int,
    target: int,
    k_hist: int = 1,
    l_hist: int = 1,
    lag: int = 1,
    *,
    epoch_length: int | None = None,
    demean: bool = True,
) -> TEResult:
    """Linear-Gaussian TE (nats). Equals pairwise GC/2 for ``k_hist = l_hist = order``,
    ``lag = 1``. ``p_value_analytic`` uses ``2 N TE ~ chi2(l_hist)`` under the null."""
    epochs = _prep(x, epoch_length, demean)
    emb = embed(epochs, source, target, k_hist, l_hist, lag)
    base: dict[str, Any] = dict(
        estimator="gaussian", source=source, target=target, k_hist=k_hist, l_hist=l_hist, lag=lag
    )
    n_obs = emb.y_t.shape[0]
    n_dims = 1 + k_hist + l_hist
    if n_obs <= 10 * n_dims:
        return TEResult(
            "insufficient_data",
            **base,
            reason_code="too_few_samples_for_embedding",
            message=f"{n_obs} embedded samples for {n_dims} dimensions",
        )
    value = _gaussian_value(emb)
    if not np.isfinite(value):
        return TEResult(
            "invalid_input",
            **base,
            reason_code="singular_covariance",
            message="embedding covariance is singular (constant or collinear)",
        )
    p = float(stats.chi2.sf(2.0 * n_obs * value, l_hist))
    return TEResult(
        "ok",
        **base,
        te=value,
        n_samples=n_obs,
        p_value_analytic=p,
        parameters={
            "closed_form": "0.5 [ln|S(Yt,Yp)| - ln|S(Yp)| - ln|S(Yt,Yp,Xp)| + ln|S(Yp,Xp)|]"
        },
    )


# --------------------------------------------------------------------------- KSG


def _window_excess(
    points: np.ndarray, radius: np.ndarray, epoch: np.ndarray, time: np.ndarray, theiler: int
) -> np.ndarray:
    """Count, per point, the Theiler-window neighbours (``0 < |dt| <= theiler``, same epoch)
    lying strictly inside ``radius`` in the max norm. Rows are contiguous per epoch."""
    n = points.shape[0]
    excess = np.zeros(n, dtype=np.int64)
    for d in range(1, theiler + 1):
        if d >= n:
            break
        same = (epoch[d:] == epoch[:-d]) & (time[d:] - time[:-d] == d)
        dist = np.max(np.abs(points[d:] - points[:-d]), axis=1)
        excess[:-d] += same & (dist < radius[:-d])
        excess[d:] += same & (dist < radius[d:])
    return excess


def _count_within(
    points: np.ndarray, radius: np.ndarray, epoch: np.ndarray, time: np.ndarray, theiler: int
) -> np.ndarray:
    tree = cKDTree(points)
    counts = tree.query_ball_point(points, r=radius, p=np.inf, return_length=True)
    counts = np.asarray(counts, dtype=np.int64) - 1  # self (distance 0 < radius)
    if theiler > 0:
        counts -= _window_excess(points, radius, epoch, time, theiler)
    return counts


def ksg_cmi(
    a: np.ndarray,
    b: np.ndarray,
    c: np.ndarray,
    *,
    k_neighbors: int = DEFAULT_K_NEIGHBORS,
    theiler: int = 0,
    epoch: np.ndarray | None = None,
    time: np.ndarray | None = None,
    noise_level: float = 1e-10,
    seed: int | None = 0,
) -> float:
    """KSG-type conditional mutual information ``I(A; B | C)`` in nats (max norm).

    ``psi(k) - < psi(n_ac + 1) + psi(n_bc + 1) - psi(n_c + 1) >`` where ``eps_i`` is the
    distance to the k-th joint-space neighbour and ``n_*`` count points strictly closer than
    ``eps_i`` in each marginal space. Neighbours in the same epoch with ``|dt| <= theiler``
    are excluded everywhere (Theiler window against temporal autocorrelation).
    """
    n = a.shape[0]
    epoch = np.zeros(n, dtype=np.int64) if epoch is None else np.asarray(epoch)
    time = np.arange(n) if time is None else np.asarray(time)
    rng = np.random.default_rng(seed)
    blocks = []
    for blk in (a, b, c):
        blk = np.asarray(blk, dtype=np.float64).reshape(n, -1)
        std = blk.std(axis=0)
        std[std == 0] = 1.0
        blk = (blk - blk.mean(axis=0)) / std
        blocks.append(blk + noise_level * rng.standard_normal(blk.shape))  # break ties
    a, b, c = blocks
    joint = np.hstack([a, b, c])
    n_query = k_neighbors + 1 + 2 * theiler
    if n_query > n:
        raise ValueError("too few samples for k_neighbors and the Theiler window")
    dist, idx = cKDTree(joint).query(joint, k=n_query, p=np.inf)
    excluded = (epoch[idx] == epoch[:, None]) & (np.abs(time[idx] - time[:, None]) <= theiler)
    valid_rank = np.cumsum(~excluded, axis=1)
    kth = np.argmax(valid_rank >= k_neighbors, axis=1)
    eps = dist[np.arange(n), kth]
    radius = np.nextafter(eps, 0.0)  # strictly-less-than counting
    n_ac = _count_within(np.hstack([a, c]), radius, epoch, time, theiler)
    n_bc = _count_within(np.hstack([b, c]), radius, epoch, time, theiler)
    n_c = _count_within(c, radius, epoch, time, theiler)
    return float(
        digamma(k_neighbors) - np.mean(digamma(n_ac + 1) + digamma(n_bc + 1) - digamma(n_c + 1))
    )


def _ksg_value(
    emb: _Embedding, k_neighbors: int, theiler: int, noise_level: float, seed: int | None
) -> float:
    return ksg_cmi(
        emb.y_t,
        emb.x_past,
        emb.y_past,
        k_neighbors=k_neighbors,
        theiler=theiler,
        epoch=emb.epoch,
        time=emb.time,
        noise_level=noise_level,
        seed=seed,
    )


def ksg_te(
    x: Any,
    source: int,
    target: int,
    k_hist: int = 1,
    l_hist: int = 1,
    lag: int = 1,
    *,
    k_neighbors: int = DEFAULT_K_NEIGHBORS,
    theiler: int = 0,
    noise_level: float = 1e-10,
    seed: int | None = 0,
    epoch_length: int | None = None,
    demean: bool = True,
) -> TEResult:
    """Model-free TE (nats) via the KSG conditional-MI estimator for one declared pair."""
    epochs = _prep(x, epoch_length, demean)
    emb = embed(epochs, source, target, k_hist, l_hist, lag)
    base: dict[str, Any] = dict(
        estimator="ksg", source=source, target=target, k_hist=k_hist, l_hist=l_hist, lag=lag
    )
    n_obs = emb.y_t.shape[0]
    needed = max(10 * (k_neighbors + 2 * theiler + 1), 100)
    if n_obs < needed:
        return TEResult(
            "insufficient_data",
            **base,
            reason_code="too_few_samples_for_ksg",
            message=f"{n_obs} embedded samples < {needed}",
        )
    value = _ksg_value(emb, k_neighbors, theiler, noise_level, seed)
    params = {
        "k_neighbors": k_neighbors,
        "theiler_window": theiler,
        "noise_level": noise_level,
        "norm": "max",
        "bias_note": KSG_BIAS_NOTE,
    }
    return TEResult("ok", **base, te=value, n_samples=n_obs, parameters=params)


# --------------------------------------------------------------------------- surrogates


def surrogate_test(
    x: Any,
    source: int,
    target: int,
    k_hist: int = 1,
    l_hist: int = 1,
    lag: int = 1,
    *,
    estimator: Literal["gaussian", "ksg"] = "ksg",
    n_surrogates: int = 99,
    min_shift: int | None = None,
    seed: int = 0,
    epoch_length: int | None = None,
    demean: bool = True,
    **ksg_kwargs: Any,
) -> TEResult:
    """TE with a circular time-shift surrogate test of H0 "no transfer X -> Y".

    The source is rotated by a random shift in ``[min_shift, T - min_shift]`` independently
    per epoch, which keeps each signal's autocorrelation but breaks the X->Y timing.
    ``p = (b + 1) / (B + 1)``; the smallest attainable p is ``1 / (B + 1)``.
    """
    epochs = _prep(x, epoch_length, demean)
    n_t = epochs.shape[-1]
    shift_floor = min_shift if min_shift is not None else max(k_hist + l_hist + lag, n_t // 20)
    if estimator == "gaussian":
        result = gaussian_te(epochs, source, target, k_hist, l_hist, lag, demean=False)

        def value_of(ep: np.ndarray) -> float:
            return _gaussian_value(embed(ep, source, target, k_hist, l_hist, lag))
    elif estimator == "ksg":
        result = ksg_te(epochs, source, target, k_hist, l_hist, lag, demean=False, **ksg_kwargs)
        kn = ksg_kwargs.get("k_neighbors", DEFAULT_K_NEIGHBORS)
        th = ksg_kwargs.get("theiler", 0)
        nl = ksg_kwargs.get("noise_level", 1e-10)
        sd = ksg_kwargs.get("seed", 0)

        def value_of(ep: np.ndarray) -> float:
            return _ksg_value(embed(ep, source, target, k_hist, l_hist, lag), kn, th, nl, sd)
    else:
        raise ValueError("estimator must be 'gaussian' or 'ksg'")
    if not result.ok:
        return result
    if n_surrogates < 1 or n_t - 2 * shift_floor < 1:
        result.status = "insufficient_data"
        result.reason_code = "surrogate_shift_range_empty"
        result.message = f"T={n_t} too short for min_shift={shift_floor} (or n_surrogates < 1)"
        result.te = None
        return result
    assert result.te is not None
    null = _null_distribution(epochs, source, value_of, n_surrogates, shift_floor, seed)
    b = int(np.sum(null >= result.te))
    result.surrogate = SurrogateTest(
        observed=result.te,
        null=null,
        p_value=(b + 1) / (n_surrogates + 1),
        n_surrogates=n_surrogates,
        min_shift=shift_floor,
    )
    return result


def _null_distribution(
    epochs: np.ndarray,
    source: int,
    value_of: Callable[[np.ndarray], float],
    n_surrogates: int,
    min_shift: int,
    seed: int,
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n_t = epochs.shape[-1]
    null = np.empty(n_surrogates)
    for i in range(n_surrogates):
        shifted = epochs.copy()
        for e in range(epochs.shape[0]):
            shift = int(rng.integers(min_shift, n_t - min_shift + 1))
            shifted[e, source] = np.roll(epochs[e, source], shift)
        null[i] = value_of(shifted)
    return null


def te_matrix(
    x: Any,
    pairs: list[tuple[int, int]] | None = None,
    *,
    estimator: Literal["gaussian", "ksg"] = "gaussian",
    k_hist: int = 1,
    l_hist: int = 1,
    lag: int = 1,
    n_surrogates: int = 0,
    epoch_length: int | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """TE over declared ``(source, target)`` pairs as ``[target, source]`` matrices.

    ``pairs=None`` means all ordered pairs (cheap for Gaussian, expensive for KSG).
    Returns ``te``, ``p_values`` (surrogate if ``n_surrogates > 0``, else analytic for
    Gaussian / NaN for KSG), ``null_mean`` and per-pair failures; NaN marks pairs not
    computed.
    """
    epochs = as_epochs(x, epoch_length)
    n = epochs.shape[1]
    pair_list = pairs or [(s, t) for t in range(n) for s in range(n) if s != t]
    te, p_mat, null_mean = (np.full((n, n), np.nan) for _ in range(3))
    failures: dict[str, dict[str, Any]] = {}
    n_samples = None
    for s, t in pair_list:
        if n_surrogates > 0:
            res = surrogate_test(
                epochs,
                s,
                t,
                k_hist,
                l_hist,
                lag,
                estimator=estimator,
                n_surrogates=n_surrogates,
                **kwargs,
            )
        elif estimator == "gaussian":
            res = gaussian_te(epochs, s, t, k_hist, l_hist, lag, **kwargs)
        else:
            res = ksg_te(epochs, s, t, k_hist, l_hist, lag, **kwargs)
        if not res.ok or res.te is None:
            failures[f"{s}->{t}"] = {
                "status": res.status,
                "reason_code": res.reason_code,
                "message": res.message,
            }
            continue
        n_samples = res.n_samples
        te[t, s] = res.te
        if res.surrogate is not None:
            p_mat[t, s] = res.surrogate.p_value
            null_mean[t, s] = res.surrogate.null_mean
        elif res.p_value_analytic is not None:
            p_mat[t, s] = res.p_value_analytic
    return {
        "te": te,
        "p_values": p_mat,
        "null_mean": null_mean,
        "failures": failures,
        "n_pairs": len(pair_list),
        "n_samples": n_samples,
        "p_value_method": (
            "circular-shift surrogate"
            if n_surrogates > 0
            else ("analytic chi2 (2 N TE)" if estimator == "gaussian" else "none")
        ),
    }
