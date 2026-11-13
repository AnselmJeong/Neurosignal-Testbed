"""Partial information decomposition (PID) for two sources and one target.

Two estimators, one explicit redundancy definition each:

* **Gaussian PID with MMI redundancy** (Barrett 2015, *Phys. Rev. E* 91, 052802).
  Mutual informations come in closed form from covariance matrices,
  ``I(S;T) = 1/2 [log det Σ_T - log det Σ_{T|S}]`` with
  ``Σ_{T|S} = Σ_T - Σ_TS Σ_S^+ Σ_ST`` (the pseudo-inverse keeps duplicated/collinear
  sources finite). Redundancy is the *minimum mutual information*
  ``R = min(I(S1;T), I(S2;T))``; then ``U1 = I1 - R``, ``U2 = I2 - R`` and
  ``S = I12 - I1 - I2 + R``, so ``R + U1 + U2 + S = I12`` exactly.
* **Discrete Williams-Beer PID** (Williams & Beer 2010, ``I_min``) on a probability
  table ``p[x1, x2, t]`` — numpy only, for teaching (XOR, AND, COPY, ...).

PID results are measure-dependent: ``I_min``, MMI, BROJA (Bertschinger et al. 2014),
``I_ccs`` (Ince 2017) and others can split the *same* ``I(S1,S2;T)`` differently. The
textbook example is the two-bit COPY ``T = (X1, X2)``: ``I_min`` reports R = 1 bit and
S = 1 bit (U1 = U2 = 0), while BROJA/``I_ccs`` report U1 = U2 = 1 bit (Harder et al.
2013 critique). For jointly Gaussian variables with a *univariate* target, Barrett
(2015) showed that every PID whose unique information depends only on the pairwise
(S_i, T) marginals (BROJA included) reduces to MMI; for multivariate targets they differ.

A failed or ineligible computation is returned as a status with a reason code, never as
zeros; values are never ``abs()``-ed or clipped (tiny negative round-off stays visible).
"""

from __future__ import annotations

from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator

from neurobridge.benchmarks.contracts import MetricStatus

LN2 = float(np.log(2.0))
_REL_TOL = 1e-10

PIDMeasure = Literal["mmi", "williams_beer_imin"]

GAUSSIAN_NOTES: tuple[str, ...] = (
    "중복정보(redundancy)는 MMI 정의 R = min(I(S1;T), I(S2;T))로 계산했습니다 (Barrett 2015).",
    "PID 분할은 중복정보 측도에 따라 달라집니다: Williams-Beer I_min, BROJA, CCS 등은 같은 "
    "데이터에서도 다른 R/U/S를 줄 수 있으므로 결과에는 항상 측도 이름이 함께 보고되어야 합니다.",
    "가우시안 변수에 목표가 1차원일 때는 쌍별 주변분포에만 의존하는 측도들(BROJA 포함)이 MMI와 "
    "일치하지만, 목표가 다차원이면 일치하지 않습니다.",
    "표본 공분산 기반 플러그인 추정치는 양(+)의 편향(독립일 때 약 d_S·d_T/(2N) nats)을 가집니다.",
)

TIME_LAGGED_NOTES: tuple[str, ...] = (
    "시간지연 PID는 '과거 소스가 목표의 미래를 얼마나 예측하는가'의 분해이며 인과의 증명이 "
    "아닙니다.",
    "목표 채널 자신의 과거는 조건화하지 않았습니다: 목표의 자기상관과 공통 입력이 소스와 "
    "공유되면 중복정보로 나타날 수 있습니다.",
    "센서(EEG) 공간에서는 용적전도와 공통 기준전극이 채널 간 공유 정보를 만들어 중복정보를 "
    "부풀릴 수 있습니다.",
)

DISCRETE_NOTES: tuple[str, ...] = (
    "중복정보는 Williams-Beer I_min (특정정보의 최소값의 기대값)으로 정의했습니다 "
    "(Williams & Beer 2010).",
    "I_min은 2비트 COPY(T=(X1,X2))에 R=1, S=1 비트(U1=U2=0)를 줍니다; 직관적 답 U1=U2=1 "
    "비트는 BROJA나 I_ccs 측도의 값입니다 (Harder et al. 2013). PID는 측도 의존적입니다.",
)


class PIDTerms(BaseModel):
    """PID atoms and the mutual informations they decompose, in one unit."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    units: Literal["nats", "bits"]
    i_s1_t: float = Field(description="I(S1;T)")
    i_s2_t: float = Field(description="I(S2;T)")
    i_s12_t: float = Field(description="I(S1,S2;T)")
    redundancy: float
    unique_s1: float
    unique_s2: float
    synergy: float
    co_information: float = Field(
        description="I(S1;S2;T) = I1 + I2 - I12 = R - S (positive: redundancy-dominated)"
    )
    interaction_information: float = Field(
        description="I12 - I1 - I2 = S - R (positive: synergy-dominated; sign convention of "
        "the 'whole-minus-sum' interaction information)"
    )

    def scaled(self, factor: float, units: Literal["nats", "bits"]) -> PIDTerms:
        data = self.model_dump()
        data.pop("units")
        return PIDTerms(units=units, **{key: value * factor for key, value in data.items()})


class PIDResult(BaseModel):
    """Outcome of one PID computation. Non-ok results carry a reason and no values."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    status: MetricStatus
    reason_code: str | None = None
    message: str | None = None
    measure: PIDMeasure
    estimator: str
    nats: PIDTerms | None = None
    bits: PIDTerms | None = None
    diagnostics: dict[str, Any] = Field(default_factory=dict)
    notes: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def status_consistency(self) -> PIDResult:
        if self.status is MetricStatus.OK:
            if self.nats is None or self.bits is None:
                raise ValueError("an ok PID result needs values in nats and bits")
        else:
            if not self.reason_code:
                raise ValueError("a non-ok PID result needs a reason_code")
            if self.nats is not None or self.bits is not None:
                raise ValueError("a non-ok PID result must not carry values")
        return self


class _Ineligible(Exception):
    def __init__(self, status: MetricStatus, reason_code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.reason_code = reason_code
        self.message = message


def _status_result(
    exc: _Ineligible,
    *,
    measure: PIDMeasure,
    estimator: str,
    diagnostics: dict[str, Any],
    notes: tuple[str, ...],
) -> PIDResult:
    return PIDResult(
        status=exc.status,
        reason_code=exc.reason_code,
        message=exc.message,
        measure=measure,
        estimator=estimator,
        diagnostics=diagnostics,
        notes=list(notes),
    )


def _terms_from_mi(i1: float, i2: float, i12: float, redundancy: float, units) -> PIDTerms:
    return PIDTerms(
        units=units,
        i_s1_t=i1,
        i_s2_t=i2,
        i_s12_t=i12,
        redundancy=redundancy,
        unique_s1=i1 - redundancy,
        unique_s2=i2 - redundancy,
        synergy=i12 - i1 - i2 + redundancy,
        co_information=i1 + i2 - i12,
        interaction_information=i12 - i1 - i2,
    )


# --------------------------------------------------------------------------- Gaussian


def _psd_inverse(matrix: np.ndarray) -> tuple[np.ndarray, int]:
    """Pseudo-inverse of a symmetric PSD matrix with a relative eigenvalue cutoff."""
    w, v = np.linalg.eigh(matrix)
    scale = float(w.max()) if w.size else 0.0
    if scale <= 0.0:
        return np.zeros_like(matrix), 0
    keep = w > _REL_TOL * scale
    return (v[:, keep] / w[keep]) @ v[:, keep].T, int(keep.sum())


def _gaussian_mi(cov: np.ndarray, s_idx: list[int], t_idx: list[int]) -> tuple[float, int]:
    """Closed-form I(S;T) in nats and the numerical rank of Σ_S."""
    cov_t = cov[np.ix_(t_idx, t_idx)]
    cov_s = cov[np.ix_(s_idx, s_idx)]
    cov_ts = cov[np.ix_(t_idx, s_idx)]
    inv_s, rank_s = _psd_inverse(cov_s)
    cond = cov_t - cov_ts @ inv_s @ cov_ts.T
    cond = 0.5 * (cond + cond.T)
    w_t = np.linalg.eigvalsh(cov_t)
    w_c = np.linalg.eigvalsh(cond)
    if w_c.min() <= _REL_TOL * w_t.max():
        raise _Ineligible(
            MetricStatus.INVALID_INPUT,
            "target_determined_by_sources",
            "Σ_{T|S} is singular: the target is (numerically) a deterministic linear function "
            "of the sources, so Gaussian I(S;T) diverges. Add observation noise or check the "
            "variable construction.",
        )
    return 0.5 * float(np.sum(np.log(w_t)) - np.sum(np.log(w_c))), rank_s


def _as_index_list(name: str, idx: Any, n: int) -> list[int]:
    arr = np.atleast_1d(np.asarray(idx))
    if arr.ndim != 1 or arr.size == 0 or not np.issubdtype(arr.dtype, np.integer):
        raise _Ineligible(
            MetricStatus.INVALID_INPUT, "invalid_index", f"{name} must be a non-empty int list"
        )
    if arr.min() < 0 or arr.max() >= n:
        raise _Ineligible(
            MetricStatus.INVALID_INPUT, "invalid_index", f"{name} out of range for {n} variables"
        )
    return [int(i) for i in arr]


def _gaussian_terms(cov: np.ndarray, s1: list[int], s2: list[int], t: list[int]):
    if set(t) & (set(s1) | set(s2)):
        raise _Ineligible(
            MetricStatus.INVALID_INPUT,
            "target_overlaps_sources",
            "target variables must be disjoint from the source variables (I would diverge)",
        )
    t_var = np.diag(cov)[t]
    if np.any(t_var <= 0.0):
        raise _Ineligible(
            MetricStatus.INVALID_INPUT, "zero_variance_target", "target has zero variance"
        )
    i1, rank1 = _gaussian_mi(cov, s1, t)
    i2, rank2 = _gaussian_mi(cov, s2, t)
    s12 = list(dict.fromkeys(s1 + s2))
    i12, rank12 = _gaussian_mi(cov, s12, t)
    nats = _terms_from_mi(i1, i2, i12, min(i1, i2), "nats")
    ranks = {"rank_s1": rank1, "rank_s2": rank2, "rank_s12": rank12}
    return nats, ranks


def gaussian_pid_from_cov(
    cov: np.ndarray,
    s1_idx: Any,
    s2_idx: Any,
    t_idx: Any,
) -> PIDResult:
    """Exact Gaussian MMI-PID from a joint covariance matrix.

    ``s1_idx``/``s2_idx``/``t_idx`` index rows of ``cov``. Source index sets may overlap
    (a shared variable is pure redundancy); the target must be disjoint from both.
    """
    estimator = "gaussian_closed_form_covariance"
    diagnostics: dict[str, Any] = {}
    try:
        cov = np.asarray(cov, dtype=float)
        if cov.ndim != 2 or cov.shape[0] != cov.shape[1] or cov.shape[0] < 2:
            raise _Ineligible(
                MetricStatus.INVALID_INPUT, "invalid_covariance", "cov must be square (n>=2)"
            )
        if not np.all(np.isfinite(cov)):
            raise _Ineligible(MetricStatus.INVALID_INPUT, "non_finite", "cov has NaN/inf")
        scale = max(float(np.max(np.abs(cov))), 1e-300)
        if not np.allclose(cov, cov.T, rtol=0.0, atol=1e-9 * scale):
            raise _Ineligible(
                MetricStatus.INVALID_INPUT, "invalid_covariance", "cov is not symmetric"
            )
        cov = 0.5 * (cov + cov.T)
        if np.linalg.eigvalsh(cov).min() < -1e-9 * scale:
            raise _Ineligible(
                MetricStatus.INVALID_INPUT,
                "invalid_covariance",
                "cov is not positive semi-definite",
            )
        n = cov.shape[0]
        s1 = _as_index_list("s1_idx", s1_idx, n)
        s2 = _as_index_list("s2_idx", s2_idx, n)
        t = _as_index_list("t_idx", t_idx, n)
        diagnostics = {"dims": {"s1": len(s1), "s2": len(s2), "t": len(t)}}
        nats, ranks = _gaussian_terms(cov, s1, s2, t)
    except _Ineligible as exc:
        return _status_result(
            exc,
            measure="mmi",
            estimator=estimator,
            diagnostics=diagnostics,
            notes=GAUSSIAN_NOTES[:3],
        )
    diagnostics.update(ranks)
    return PIDResult(
        status=MetricStatus.OK,
        measure="mmi",
        estimator=estimator,
        nats=nats,
        bits=nats.scaled(1.0 / LN2, "bits"),
        diagnostics=diagnostics,
        notes=list(GAUSSIAN_NOTES[:3]),
    )


def _as_samples(name: str, arr: Any) -> np.ndarray:
    a = np.asarray(arr, dtype=float)
    if a.ndim == 1:
        a = a[:, None]
    if a.ndim != 2 or a.shape[1] == 0:
        raise _Ineligible(
            MetricStatus.INVALID_INPUT,
            "invalid_shape",
            f"{name} must have shape (n_samples,) or (n_samples, n_dims)",
        )
    if not np.all(np.isfinite(a)):
        raise _Ineligible(MetricStatus.INVALID_INPUT, "non_finite", f"{name} has NaN/inf")
    return a


def _gaussian_pid_samples(
    s1: Any,
    s2: Any,
    t: Any,
    min_samples_per_dim: int,
    extra_diagnostics: dict[str, Any],
    notes: tuple[str, ...],
) -> PIDResult:
    estimator = "gaussian_plugin_sample_covariance"
    diagnostics = dict(extra_diagnostics)
    try:
        a1, a2, at = (_as_samples(n, v) for n, v in (("s1", s1), ("s2", s2), ("t", t)))
        n = a1.shape[0]
        if a2.shape[0] != n or at.shape[0] != n:
            raise _Ineligible(
                MetricStatus.INVALID_INPUT,
                "sample_count_mismatch",
                "s1, s2 and t need the same number of samples",
            )
        d1, d2, dt = a1.shape[1], a2.shape[1], at.shape[1]
        d_total = d1 + d2 + dt
        diagnostics.update(n_samples=n, dims={"s1": d1, "s2": d2, "t": dt})
        if n < min_samples_per_dim * d_total:
            raise _Ineligible(
                MetricStatus.INSUFFICIENT_DATA,
                "too_few_samples",
                f"{n} samples < {min_samples_per_dim} x {d_total} variables",
            )
        cov = np.cov(np.hstack([a1, a2, at]), rowvar=False)
        s1_idx = list(range(d1))
        s2_idx = list(range(d1, d1 + d2))
        t_idx = list(range(d1 + d2, d_total))
        nats, ranks = _gaussian_terms(cov, s1_idx, s2_idx, t_idx)
    except _Ineligible as exc:
        return _status_result(
            exc, measure="mmi", estimator=estimator, diagnostics=diagnostics, notes=notes
        )
    diagnostics.update(ranks)
    diagnostics["approx_plugin_bias_nats"] = {
        "i_s1_t": d1 * dt / (2.0 * n),
        "i_s2_t": d2 * dt / (2.0 * n),
        "i_s12_t": (d1 + d2) * dt / (2.0 * n),
    }
    return PIDResult(
        status=MetricStatus.OK,
        measure="mmi",
        estimator=estimator,
        nats=nats,
        bits=nats.scaled(1.0 / LN2, "bits"),
        diagnostics=diagnostics,
        notes=list(notes),
    )


def gaussian_pid(s1: Any, s2: Any, t: Any, *, min_samples_per_dim: int = 10) -> PIDResult:
    """Gaussian MMI-PID from samples (rows = samples; 1-D arrays are single variables)."""
    return _gaussian_pid_samples(s1, s2, t, min_samples_per_dim, {}, GAUSSIAN_NOTES)


def time_lagged_pid(
    x: Any,
    source_a: int,
    source_b: int,
    target: int,
    *,
    lag: int = 1,
    history: int = 1,
    min_samples_per_dim: int = 10,
) -> PIDResult:
    """PID of the target's future given the two sources' pasts.

    ``x`` is ``(n_channels, n_times)``. For every ``t`` with a full history:
    ``S1 = [x[a, t-lag], ..., x[a, t-lag-history+1]]``, ``S2`` likewise for ``b`` and
    ``T = x[target, t]``. The question answered: does the target *integrate* the two
    sources (synergy), receive the same information from both (redundancy) or from one
    only (unique)? This is a predictive decomposition, not a causal proof.
    """
    params = {
        "source_a": source_a,
        "source_b": source_b,
        "target": target,
        "lag": lag,
        "history": history,
        "variables": "S1=past(source_a), S2=past(source_b), T=future(target)",
    }
    notes = GAUSSIAN_NOTES + TIME_LAGGED_NOTES
    try:
        arr = np.asarray(x, dtype=float)
        if arr.ndim != 2:
            raise _Ineligible(
                MetricStatus.INVALID_INPUT, "invalid_shape", "x must be (n_channels, n_times)"
            )
        if not np.all(np.isfinite(arr)):
            raise _Ineligible(MetricStatus.INVALID_INPUT, "non_finite", "x has NaN/inf")
        n_ch, n_times = arr.shape
        for name, ch in (("source_a", source_a), ("source_b", source_b), ("target", target)):
            if not isinstance(ch, int | np.integer) or not 0 <= int(ch) < n_ch:
                raise _Ineligible(
                    MetricStatus.INVALID_INPUT,
                    "invalid_channel",
                    f"{name}={ch!r} is not a channel index in [0, {n_ch})",
                )
        if not isinstance(lag, int | np.integer) or lag < 1:
            raise _Ineligible(MetricStatus.INVALID_INPUT, "invalid_lag", "lag must be an int >= 1")
        if not isinstance(history, int | np.integer) or history < 1:
            raise _Ineligible(
                MetricStatus.INVALID_INPUT, "invalid_history", "history must be an int >= 1"
            )
        start = lag + history - 1
        if n_times - start < 2:
            raise _Ineligible(
                MetricStatus.INSUFFICIENT_DATA,
                "too_few_samples",
                f"{n_times} time points cannot hold lag={lag} + history={history}",
            )
    except _Ineligible as exc:
        return _status_result(
            exc,
            measure="mmi",
            estimator="gaussian_plugin_sample_covariance",
            diagnostics=params,
            notes=notes,
        )
    t_idx = np.arange(start, n_times)

    def past(ch: int) -> np.ndarray:
        return np.column_stack([arr[ch, t_idx - lag - k] for k in range(history)])

    return _gaussian_pid_samples(
        past(int(source_a)),
        past(int(source_b)),
        arr[int(target), t_idx],
        min_samples_per_dim,
        params,
        notes,
    )


def integration_demo(
    *,
    n_times: int = 20_000,
    coupling: float = 0.6,
    ar: float = 0.5,
    noise: float = 0.5,
    seed: int = 0,
) -> dict[str, PIDResult]:
    """Teaching example: does channel C integrate channels A and B?

    A and B are independent AR(1) processes. Scenario ``integrates_a_and_b``:
    ``C_t = coupling*(A_{t-1} + B_{t-1}) + noise`` — MMI synergy > 0 because knowing
    both pasts predicts C better than either alone beyond their overlap.
    Scenario ``a_only``: ``C_t = coupling*A_{t-1} + noise`` — unique information from A,
    synergy ~ 0. Returns ``time_lagged_pid(..., 0, 1, 2, lag=1, history=1)`` per scenario.
    """
    rng = np.random.default_rng(seed)
    src = np.zeros((2, n_times))
    innovations = rng.standard_normal((2, n_times))
    for i in range(1, n_times):
        src[:, i] = ar * src[:, i - 1] + innovations[:, i]
    out: dict[str, PIDResult] = {}
    for name, w_b in (("integrates_a_and_b", coupling), ("a_only", 0.0)):
        c = np.zeros(n_times)
        c[1:] = coupling * src[0, :-1] + w_b * src[1, :-1]
        c += noise * rng.standard_normal(n_times)
        out[name] = time_lagged_pid(np.vstack([src, c]), 0, 1, 2, lag=1, history=1)
    return out


# --------------------------------------------------------------------------- discrete


def _specific_information(p_xt: np.ndarray, p_t: np.ndarray) -> np.ndarray:
    """I_spec(T=t; X) in bits for each t, from the joint table p[x, t]."""
    p_x = p_xt.sum(axis=1)
    out = np.zeros(p_t.shape[0])
    for t in np.flatnonzero(p_t > 0):
        mask = p_xt[:, t] > 0
        p_x_given_t = p_xt[mask, t] / p_t[t]
        p_t_given_x = p_xt[mask, t] / p_x[mask]
        out[t] = float(np.sum(p_x_given_t * (np.log2(p_t_given_x) - np.log2(p_t[t]))))
    return out


def _discrete_mi_bits(p_xt: np.ndarray) -> float:
    p_x = p_xt.sum(axis=1, keepdims=True)
    p_t = p_xt.sum(axis=0, keepdims=True)
    mask = p_xt > 0
    ratio = p_xt[mask] / (p_x @ p_t)[mask]
    return float(np.sum(p_xt[mask] * np.log2(ratio)))


def discrete_pid_williams_beer(p: Any, *, atol: float = 1e-9) -> PIDResult:
    """Williams-Beer ``I_min`` PID of a joint table ``p[x1, x2, t]`` (bits and nats)."""
    estimator = "discrete_probability_table"
    diagnostics: dict[str, Any] = {}
    try:
        table = np.asarray(p, dtype=float)
        if table.ndim != 3 or min(table.shape) < 1:
            raise _Ineligible(
                MetricStatus.INVALID_INPUT, "invalid_shape", "p must be a 3-D table p[x1, x2, t]"
            )
        if not np.all(np.isfinite(table)) or np.any(table < 0):
            raise _Ineligible(
                MetricStatus.INVALID_INPUT,
                "invalid_probability",
                "p must be finite and non-negative",
            )
        total = float(table.sum())
        if abs(total - 1.0) > atol:
            raise _Ineligible(
                MetricStatus.INVALID_INPUT,
                "invalid_probability",
                f"p must sum to 1 (sums to {total!r})",
            )
        diagnostics = {"shape": list(table.shape)}
    except _Ineligible as exc:
        return _status_result(
            exc,
            measure="williams_beer_imin",
            estimator=estimator,
            diagnostics=diagnostics,
            notes=DISCRETE_NOTES,
        )
    n1, n2, nt = table.shape
    p_x1t = table.sum(axis=1)
    p_x2t = table.sum(axis=0)
    p_x12t = table.reshape(n1 * n2, nt)
    p_t = table.sum(axis=(0, 1))
    i1 = _discrete_mi_bits(p_x1t)
    i2 = _discrete_mi_bits(p_x2t)
    i12 = _discrete_mi_bits(p_x12t)
    spec = np.vstack([_specific_information(p_x1t, p_t), _specific_information(p_x2t, p_t)])
    redundancy = float(np.sum(p_t * spec.min(axis=0)))
    bits = _terms_from_mi(i1, i2, i12, redundancy, "bits")
    diagnostics["specific_information_bits"] = {
        "s1": spec[0].tolist(),
        "s2": spec[1].tolist(),
        "p_t": p_t.tolist(),
    }
    return PIDResult(
        status=MetricStatus.OK,
        measure="williams_beer_imin",
        estimator=estimator,
        nats=bits.scaled(LN2, "nats"),
        bits=bits,
        diagnostics=diagnostics,
        notes=list(DISCRETE_NOTES),
    )


TEACHING_GATES: dict[str, str] = {
    "xor": "T = X1 XOR X2 — 순수 시너지 (각 입력 단독으로는 정보 0, 함께면 1비트)",
    "and": "T = X1 AND X2 — 중복정보와 시너지가 섞인 고전적 예",
    "copy": "T = (X1, X2) 2비트 COPY — 측도 의존성의 교과서 예 (I_min은 R=S=1)",
    "unique": "T = X1 — X1의 고유정보 1비트, X2는 무관",
    "redundant": "X1 = X2 = T — 순수 중복정보 1비트",
    "independent": "T가 X1, X2와 독립 — 모든 항이 0",
}


def teaching_distribution(name: str) -> np.ndarray:
    """Joint table ``p[x1, x2, t]`` for uniform binary inputs and a named gate."""
    if name not in TEACHING_GATES:
        raise ValueError(f"unknown teaching gate {name!r}; choose from {sorted(TEACHING_GATES)}")
    if name == "redundant":
        p = np.zeros((2, 2, 2))
        p[0, 0, 0] = p[1, 1, 1] = 0.5
        return p
    if name == "independent":
        return np.full((2, 2, 2), 1.0 / 8.0)
    nt = 4 if name == "copy" else 2
    p = np.zeros((2, 2, nt))
    for x1 in (0, 1):
        for x2 in (0, 1):
            t = {"xor": x1 ^ x2, "and": x1 & x2, "copy": 2 * x1 + x2, "unique": x1}[name]
            p[x1, x2, t] = 0.25
    return p


def teaching_examples() -> dict[str, PIDResult]:
    """Williams-Beer PID of every teaching gate."""
    return {
        name: discrete_pid_williams_beer(teaching_distribution(name)) for name in TEACHING_GATES
    }


__all__ = [
    "DISCRETE_NOTES",
    "GAUSSIAN_NOTES",
    "LN2",
    "PIDResult",
    "PIDTerms",
    "TEACHING_GATES",
    "TIME_LAGGED_NOTES",
    "discrete_pid_williams_beer",
    "gaussian_pid",
    "gaussian_pid_from_cov",
    "integration_demo",
    "teaching_distribution",
    "teaching_examples",
    "time_lagged_pid",
]
