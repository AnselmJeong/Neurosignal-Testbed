"""Educational DCM-style linear effective-connectivity model and model comparison.

This module follows the *spirit* of dynamic causal modelling (source document §2.C,
``x' = A x + C u``) with the simplest possible generative model: a linear stochastic
state-space system driven by white noise (resting state, so ``u`` is unknown noise).

It is **NOT SPM DCM**:

* no neural-mass or hemodynamic forward model and no observation model — the observed
  channels are treated directly as the hidden states ``x``;
* no variational Bayes / free-energy model evidence — evidence is approximated with
  BIC (and AIC) from a Gaussian maximum-likelihood fit;
* no bilinear (condition-dependent) or nonlinear terms.

Conventions: data are ``(n_nodes, n_times)``; every connectivity matrix is indexed
``A[target, source]`` (row = receiving node), matching ``neurobridge.simulation.tvb_jr``.
Analysis functions never receive the generating truth; truth is only used by callers in a
separate evaluation step. Failed or ineligible fits are reported via ``status``/``reason``
with ``None``/NaN values, never as zeros.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import Literal

import numpy as np
from numpy.typing import NDArray
from scipy import linalg, signal

METHOD_NOTE = (
    "교육용 선형 상태공간(DCM 정신의) 모델입니다. SPM DCM이 아닙니다: 신경질량·혈역학 "
    "관측모델과 변분 베이즈(자유에너지)가 없고, 관측 채널을 잠재 상태 x로 직접 간주합니다. "
    "이산 VAR(1) x[t+1] = A_d x[t] + e 를 최소제곱으로 적합한 뒤 A_c = logm(A_d)/dt 로 "
    "연속시간 유효연결 A[target, source]로 변환합니다(실수 로그가 없으면 (A_d - I)/dt 근사로 "
    "대체하고 플래그를 남깁니다). 모델 비교는 같은 연결 마스크를 모든 시차에 적용한 VAR(p)로 "
    "적합하며(p는 BIC로 선택), BIC/AIC와 exp(-BIC/2) 정규화 사후확률은 '명시한 "
    "후보 모델들 중 어느 방향 모델이 데이터를 상대적으로 더 잘 설명하는가'에 대한 증거일 "
    "뿐이며, 인과관계의 증명이 아닙니다. 후보에 없는 모델(숨은 공통입력, 비선형성, 센서 "
    "혼합/볼륨 전도)은 평가되지 않습니다."
)

Status = Literal["ok", "ineligible"]


@dataclass(frozen=True)
class LinearStateSpaceFit:
    """Result of :func:`fit_linear_state_space`.

    ``A`` is the continuous-time effective connectivity ``A_c[target, source]`` (1/s),
    ``A_discrete`` the fitted VAR(1) matrix, ``noise_cov`` the discrete innovation
    covariance and ``noise_cov_continuous`` its ``/dt`` approximation.
    """

    status: Status
    reason: str | None
    dt: float
    n_samples: int
    A: NDArray[np.float64] | None = None
    A_discrete: NDArray[np.float64] | None = None
    noise_cov: NDArray[np.float64] | None = None
    noise_cov_continuous: NDArray[np.float64] | None = None
    conversion: Literal["logm", "euler_fallback"] | None = None
    conversion_reason: str | None = None
    stable: bool | None = None
    discrete_spectral_radius: float | None = None
    preprocessing: dict[str, object] = field(default_factory=dict)
    method_note: str = METHOD_NOTE


@dataclass(frozen=True)
class CandidateModel:
    """A candidate graph: ``mask[target, source]`` marks allowed ``A`` entries.

    The diagonal (self-dynamics) is always allowed. ``shared_noise=True`` lets the
    innovations be correlated across nodes (zero-lag common input) via a full residual
    covariance; otherwise innovations are independent per node.
    """

    name: str
    mask: NDArray[np.bool_]
    shared_noise: bool = False


@dataclass(frozen=True)
class ModelFit:
    name: str
    status: Status
    reason: str | None
    n_params: int | None = None
    log_likelihood: float | None = None
    bic: float | None = None
    aic: float | None = None
    posterior: float | None = None
    A_discrete: NDArray[np.float64] | None = None
    A_continuous_euler: NDArray[np.float64] | None = None
    mask: NDArray[np.bool_] | None = None
    shared_noise: bool = False


@dataclass(frozen=True)
class ModelComparison:
    """BIC/AIC comparison among *specified* candidate models.

    ``posterior`` values are approximate model probabilities under a uniform prior,
    ``exp(-BIC/2)`` normalised over the eligible candidates.
    """

    status: Status
    reason: str | None
    dt: float
    n_samples: int
    models: list[ModelFit]
    best_model: str | None
    question: str = "명시한 후보 모델 중 어느 방향성 모델이 데이터를 가장 잘 설명하는가?"
    method_note: str = METHOD_NOTE

    def by_name(self) -> dict[str, ModelFit]:
        return {model.name: model for model in self.models}


# --------------------------------------------------------------------------- helpers


def _prepare(
    x: NDArray[np.float64] | Sequence[Sequence[float]],
    dt: float,
    lowpass_hz: float | None,
    demean: bool,
) -> tuple[NDArray[np.float64] | None, str | None, dict[str, object]]:
    """Validate and optionally low-pass / demean ``x``; returns (data, reason, info)."""
    data = np.asarray(x, dtype=float)
    info: dict[str, object] = {"lowpass_hz": lowpass_hz, "demean": demean}
    if data.ndim != 2:
        return None, f"x must be 2-D (n_nodes, n_times), got shape {data.shape}", info
    if not np.isfinite(dt) or dt <= 0:
        return None, f"dt must be a positive finite number, got {dt}", info
    if not np.all(np.isfinite(data)):
        return None, "x contains non-finite values", info
    n_nodes, n_times = data.shape
    min_times = max(3 * n_nodes, n_nodes + 10)
    if n_times - 1 < min_times:
        return (
            None,
            (
                f"too few samples: {n_times - 1} transitions for {n_nodes} nodes "
                f"(need >= {min_times})"
            ),
            info,
        )
    if lowpass_hz is not None:
        nyquist = 0.5 / dt
        if not 0 < lowpass_hz < nyquist:
            return None, f"lowpass_hz={lowpass_hz} must be in (0, Nyquist={nyquist})", info
        # Zero-phase 4th-order Butterworth: removes fast noise so that one VAR(1) step of
        # length dt is a reasonable description, but it also adds autocorrelation and
        # can bias the lag-1 fit; it is off by default and recorded in ``preprocessing``.
        sos = signal.butter(4, lowpass_hz, btype="low", fs=1.0 / dt, output="sos")
        data = signal.sosfiltfilt(sos, data, axis=1)
        info["filter"] = "butterworth order 4, zero-phase (sosfiltfilt)"
    if demean:
        data = data - data.mean(axis=1, keepdims=True)
    past = data[:, :-1]
    rank = int(np.linalg.matrix_rank(past @ past.T))
    if rank < n_nodes:
        return (
            None,
            (
                f"rank-deficient design (rank {rank} < {n_nodes} nodes): channels are linearly "
                "dependent (e.g. average reference) so A is not identifiable"
            ),
            info,
        )
    return data, None, info


def _discrete_to_continuous(
    a_d: NDArray[np.float64], dt: float
) -> tuple[NDArray[np.float64], Literal["logm", "euler_fallback"], str | None]:
    eigvals = np.linalg.eigvals(a_d)
    bad = (np.abs(eigvals.imag) < 1e-12) & (eigvals.real <= 0)
    if np.any(bad):
        reason = "A_d has a non-positive real eigenvalue: no real matrix logarithm"
        return (a_d - np.eye(a_d.shape[0])) / dt, "euler_fallback", reason
    try:
        log_a = np.asarray(linalg.logm(a_d))
    except (ValueError, np.linalg.LinAlgError) as exc:  # pragma: no cover - defensive
        return (a_d - np.eye(a_d.shape[0])) / dt, "euler_fallback", f"logm failed: {exc}"
    scale = max(1.0, float(np.max(np.abs(log_a.real))))
    if not np.all(np.isfinite(log_a)) or float(np.max(np.abs(log_a.imag))) > 1e-8 * scale:
        reason = "logm(A_d) is not real/finite: principal logarithm unusable"
        return (a_d - np.eye(a_d.shape[0])) / dt, "euler_fallback", reason
    return np.real(log_a) / dt, "logm", None


# --------------------------------------------------------------------------- fitting


def fit_linear_state_space(
    x: NDArray[np.float64] | Sequence[Sequence[float]],
    dt: float,
    *,
    lowpass_hz: float | None = None,
    demean: bool = True,
) -> LinearStateSpaceFit:
    """Fit ``x[t+1] = A_d x[t] + e`` and convert to continuous ``A_c = logm(A_d)/dt``.

    Parameters
    ----------
    x:
        ``(n_nodes, n_times)`` data treated as the latent states (no observation model).
    dt:
        Sampling interval in seconds.
    lowpass_hz:
        Optional zero-phase low-pass applied before fitting (documented in
        ``preprocessing``). Default ``None`` = no filtering.
    demean:
        Remove each node's mean (no intercept is fitted).

    ``stable`` reports whether all eigenvalues of ``A_d`` lie inside the unit circle
    (equivalently ``Re eig(A_c) < 0``); unstable fits are returned unchanged with the flag.
    """
    data, reason, info = _prepare(x, dt, lowpass_hz, demean)
    n_samples = int(np.asarray(x).shape[-1]) if np.asarray(x).ndim >= 1 else 0
    if data is None:
        return LinearStateSpaceFit(
            status="ineligible",
            reason=reason,
            dt=dt,
            n_samples=n_samples,
            preprocessing=info,
        )
    past, future = data[:, :-1], data[:, 1:]
    a_d = np.linalg.solve(past @ past.T, past @ future.T).T
    resid = future - a_d @ past
    noise_cov = resid @ resid.T / resid.shape[1]
    a_c, conversion, conversion_reason = _discrete_to_continuous(a_d, dt)
    radius = float(np.max(np.abs(np.linalg.eigvals(a_d))))
    return LinearStateSpaceFit(
        status="ok",
        reason=None,
        dt=dt,
        n_samples=n_samples,
        A=a_c,
        A_discrete=a_d,
        noise_cov=noise_cov,
        noise_cov_continuous=noise_cov / dt,
        conversion=conversion,
        conversion_reason=conversion_reason,
        stable=radius < 1.0,
        discrete_spectral_radius=radius,
        preprocessing=info,
    )


# --------------------------------------------------------------------------- candidates


def _base_mask(n_nodes: int) -> NDArray[np.bool_]:
    if n_nodes < 1:
        raise ValueError("n_nodes must be >= 1")
    return np.eye(n_nodes, dtype=bool)


def _check_nodes(n_nodes: int, *nodes: int) -> None:
    for node in nodes:
        if not 0 <= node < n_nodes:
            raise ValueError(f"node {node} out of range for {n_nodes} nodes")


def none_model(n_nodes: int, name: str = "none") -> CandidateModel:
    """Only self-dynamics; no directed edges and independent innovations."""
    return CandidateModel(name=name, mask=_base_mask(n_nodes))


def forward_model(n_nodes: int, source: int, target: int, name: str = "forward") -> CandidateModel:
    """Single directed edge ``source -> target`` (``mask[target, source]``)."""
    _check_nodes(n_nodes, source, target)
    mask = _base_mask(n_nodes)
    mask[target, source] = True
    return CandidateModel(name=name, mask=mask)


def backward_model(
    n_nodes: int, source: int, target: int, name: str = "backward"
) -> CandidateModel:
    """The reversed edge ``target -> source``."""
    return forward_model(n_nodes, target, source, name=name)


def bidirectional_model(
    n_nodes: int, source: int, target: int, name: str = "bidirectional"
) -> CandidateModel:
    _check_nodes(n_nodes, source, target)
    mask = _base_mask(n_nodes)
    mask[target, source] = True
    mask[source, target] = True
    return CandidateModel(name=name, mask=mask)


def common_input_model(
    n_nodes: int,
    nodes: Sequence[int],
    driver: int | None = None,
    name: str = "common_input",
) -> CandidateModel:
    """'Common input only' for a small set of ``nodes``: no edges among them.

    With an observed ``driver`` node the model allows ``driver -> node`` for each node.
    Without one, the shared input is unobserved, so the model has no directed edges but
    correlated (zero-lag) innovations (``shared_noise=True``).
    """
    _check_nodes(n_nodes, *nodes)
    mask = _base_mask(n_nodes)
    if driver is None:
        return CandidateModel(name=name, mask=mask, shared_noise=True)
    _check_nodes(n_nodes, driver)
    if driver in nodes:
        raise ValueError("driver must not be one of the commonly driven nodes")
    for node in nodes:
        mask[node, driver] = True
    return CandidateModel(name=name, mask=mask)


def standard_candidates(
    n_nodes: int, source: int, target: int, driver: int | None = None
) -> list[CandidateModel]:
    """forward / backward / bidirectional / none / common_input for one node pair."""
    return [
        forward_model(n_nodes, source, target),
        backward_model(n_nodes, source, target),
        bidirectional_model(n_nodes, source, target),
        none_model(n_nodes),
        common_input_model(n_nodes, [source, target], driver=driver),
    ]


# --------------------------------------------------------------------------- comparison


def _lagged(
    data: NDArray[np.float64], order: int
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Return (past, future) with ``past`` shaped (order, n_nodes, n_trans)."""
    n_times = data.shape[1]
    future = data[:, order:]
    past = np.stack([data[:, order - k : n_times - k] for k in range(1, order + 1)])
    return past, future


def _fit_candidate(
    data: NDArray[np.float64], dt: float, candidate: CandidateModel, order: int = 1
) -> ModelFit:
    n_nodes = data.shape[0]
    mask = np.asarray(candidate.mask, dtype=bool)
    if mask.shape != (n_nodes, n_nodes):
        return ModelFit(
            name=candidate.name,
            status="ineligible",
            reason=f"mask shape {mask.shape} != ({n_nodes}, {n_nodes})",
        )
    mask = mask | np.eye(n_nodes, dtype=bool)
    past, future = _lagged(data, order)
    n_trans = future.shape[1]
    a_lags = np.zeros((order, n_nodes, n_nodes))
    resid = np.empty_like(future)
    for target in range(n_nodes):
        sources = np.flatnonzero(mask[target])
        # The mask applies to every lag 1..order: an absent edge has no influence at any lag.
        design = past[:, sources, :].reshape(order * sources.size, n_trans)
        beta, *_ = np.linalg.lstsq(design.T, future[target], rcond=None)
        a_lags[:, target, sources] = beta.reshape(order, sources.size)
        resid[target] = future[target] - beta @ design
    n_params = int(mask.sum()) * order + n_nodes  # coefficients + innovation variances
    if candidate.shared_noise:
        n_params += n_nodes * (n_nodes - 1) // 2
        cov = resid @ resid.T / n_trans
        sign, logdet = np.linalg.slogdet(cov)
        if sign <= 0:
            return ModelFit(
                name=candidate.name,
                status="ineligible",
                reason="singular residual covariance",
                mask=mask,
                shared_noise=True,
            )
        loglik = -0.5 * n_trans * (n_nodes * np.log(2 * np.pi) + logdet + n_nodes)
    else:
        var = np.mean(resid**2, axis=1)
        if np.any(var <= 0):
            return ModelFit(
                name=candidate.name,
                status="ineligible",
                reason="zero residual variance",
                mask=mask,
            )
        loglik = float(-0.5 * n_trans * np.sum(np.log(2 * np.pi * var) + 1.0))
    loglik = float(loglik)
    return ModelFit(
        name=candidate.name,
        status="ok",
        reason=None,
        n_params=n_params,
        log_likelihood=loglik,
        bic=-2.0 * loglik + n_params * np.log(n_trans),
        aic=-2.0 * loglik + 2.0 * n_params,
        A_discrete=a_lags[0] if order == 1 else a_lags.sum(axis=0),
        A_continuous_euler=(a_lags.sum(axis=0) - np.eye(n_nodes)) / dt,
        mask=mask,
        shared_noise=candidate.shared_noise,
    )


def compare_linear_models(
    x: NDArray[np.float64] | Sequence[Sequence[float]],
    dt: float,
    candidates: Sequence[CandidateModel],
    *,
    lowpass_hz: float | None = None,
    demean: bool = True,
    order: int = 1,
) -> ModelComparison:
    """Fit each candidate graph by row-wise constrained least squares and rank them.

    Each target row is regressed on its allowed sources (diagonal always allowed). The
    Gaussian log-likelihood uses per-node innovation variances (or a full covariance for
    ``shared_noise`` candidates). ``BIC = -2 logL + k log T`` and ``AIC = -2 logL + 2k``
    with ``k`` = allowed coefficients + noise parameters. Posterior probabilities assume a
    uniform prior over the *listed* candidates; they say nothing about unlisted models.

    ``order`` > 1 fits a masked VAR(order): each allowed edge gets one coefficient per lag.
    Oscillating sources (e.g. alpha-band Jansen-Rit nodes) are poorly described by a single
    lag, which inflates spurious edges; use an order chosen by AIC/BIC on the data. For
    ``order`` > 1, ``A_discrete`` holds the sum of the lag matrices (net lag influence).
    """
    if order < 1:
        raise ValueError("order must be >= 1")
    if not candidates:
        raise ValueError("at least one candidate model is required")
    names = [c.name for c in candidates]
    if len(set(names)) != len(names):
        raise ValueError("candidate names must be unique")
    data, reason, _ = _prepare(x, dt, lowpass_hz, demean)
    n_samples = int(np.asarray(x).shape[-1]) if np.asarray(x).ndim >= 1 else 0
    if data is None:
        fits = [ModelFit(name=n, status="ineligible", reason=reason) for n in names]
        return ModelComparison(
            status="ineligible",
            reason=reason,
            dt=dt,
            n_samples=n_samples,
            models=fits,
            best_model=None,
        )
    fits = [_fit_candidate(data, dt, c, order) for c in candidates]
    ok = [f for f in fits if f.status == "ok"]
    if not ok:
        return ModelComparison(
            status="ineligible",
            reason="no candidate could be fitted",
            dt=dt,
            n_samples=n_samples,
            models=fits,
            best_model=None,
        )
    bics = np.array([f.bic for f in ok], dtype=float)
    weights = np.exp(-0.5 * (bics - bics.min()))
    posterior = dict(zip([f.name for f in ok], weights / weights.sum(), strict=True))
    fits = [replace(f, posterior=float(posterior[f.name])) if f.status == "ok" else f for f in fits]
    best = min(ok, key=lambda f: f.bic if f.bic is not None else np.inf).name
    return ModelComparison(
        status="ok", reason=None, dt=dt, n_samples=n_samples, models=fits, best_model=best
    )
