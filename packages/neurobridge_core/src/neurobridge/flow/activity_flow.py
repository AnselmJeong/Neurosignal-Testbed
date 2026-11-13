"""Cole-style activity flow mapping on resting data (source document §2.D).

Activity flow predicts each held-out target channel from the other channels' activity
weighted by functional connectivity::

    a_hat_j(t) = sum_{i != j, i not excluded} FC[j, i] * a_i(t)

Matrices are indexed ``FC[target, source]``. Resting adaptation used here:

* **Split**: the record is cut into one contiguous TRAIN block followed by a gap and one
  contiguous TEST block. Activity is computed *separately* inside each block (filters never
  cross the boundary) and the gap (default 1 s) discards samples whose autocorrelation with
  the end of TRAIN would otherwise inflate test performance.
* **Activity**: band-limited amplitude envelope (default alpha 8-13 Hz, Butterworth +
  Hilbert) or the raw signal, z-scored per channel with TRAIN mean/std only.
* **FC on TRAIN only**: Pearson correlation FC and multiple-regression FC (closed-form
  ridge). The target is always excluded from its own predictors; optionally its spatial
  neighbours too, because on EEG/MEG neighbouring sensors see the *same* sources through
  volume conduction, so "predicting" a channel from its neighbours is partly circular
  (the field spread, not network propagation, does the work).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
from numpy.typing import NDArray
from scipy import signal

METHOD_NOTE = (
    "Cole 등의 activity flow mapping(â_j = Σ_{i≠j} FC_ij a_i)을 휴지기 데이터에 적용한 교육용 "
    "구현입니다. 시간을 연속된 TRAIN/TEST 블록으로 나누고(사이에 gap을 두어 자기상관 누설 "
    "방지), FC(Pearson, 다중회귀/ridge)는 TRAIN에서만 추정하며 z-점수화도 TRAIN 통계만 "
    "사용합니다. 목표 채널은 항상 예측변수에서 제외하고, 선택적으로 공간 이웃도 제외해 볼륨 "
    "전도에 의한 순환성을 줄입니다. 주의: 정적 FC는 시간적 방향성을 측정하지 않습니다. 이 "
    "방법은 연결망을 통한 활동 전파 모델의 예측력을 검증하는 것이지, 실제 신경 신호가 "
    "이동한 경로를 추적하는 것이 아닙니다."
)

ActivityKind = Literal["envelope", "raw"]
FCMethod = Literal["pearson", "regression"]
Neighbors = NDArray[np.bool_] | Mapping[int, Iterable[int]]


@dataclass(frozen=True)
class FlowPrediction:
    """Activity-flow prediction quality for one FC type on the TEST block."""

    method: FCMethod
    fc: NDArray[np.float64]  # [target, source]; NaN on diagonal / excluded entries
    r: NDArray[np.float64]  # per-channel Pearson r(predicted, actual); NaN if undefined
    r2: NDArray[np.float64]  # per-channel 1 - SSE/SST (may be negative)
    channel_status: list[str]
    mean_r: float
    mean_r2: float
    predicted: NDArray[np.float64]  # (n_channels, n_test)


@dataclass(frozen=True)
class ActivityFlowResult:
    status: Literal["ok", "ineligible"]
    reason: str | None
    activity: ActivityKind
    band: tuple[float, float] | None
    sfreq: float
    train_samples: tuple[int, int] | None = None
    test_samples: tuple[int, int] | None = None
    gap_samples: int | None = None
    predictor_mask: NDArray[np.bool_] | None = None  # [target, source] True = used
    predictions: dict[str, FlowPrediction] = field(default_factory=dict)
    actual_test: NDArray[np.float64] | None = None
    example_channel: int | None = None
    example_actual: NDArray[np.float64] | None = None
    example_predicted: dict[str, NDArray[np.float64]] = field(default_factory=dict)
    comparison: dict[str, dict[str, float]] = field(default_factory=dict)
    best_method: str | None = None
    method_note: str = METHOD_NOTE


def neighbors_within_radius(
    positions: NDArray[np.float64] | Sequence[Sequence[float]], radius: float
) -> NDArray[np.bool_]:
    """Boolean ``[target, source]`` matrix of channels closer than ``radius`` (no self)."""
    pos = np.asarray(positions, dtype=float)
    if pos.ndim != 2:
        raise ValueError("positions must be (n_channels, n_dims)")
    dist = np.linalg.norm(pos[:, None, :] - pos[None, :, :], axis=-1)
    out = dist <= radius
    np.fill_diagonal(out, False)
    return out


def _predictor_mask(n_ch: int, neighbors: Neighbors | None) -> NDArray[np.bool_]:
    mask = ~np.eye(n_ch, dtype=bool)
    if neighbors is None:
        return mask
    if isinstance(neighbors, Mapping):
        for target, sources in neighbors.items():
            for source in sources:
                mask[int(target), int(source)] = False
    else:
        excl = np.asarray(neighbors, dtype=bool)
        if excl.shape != (n_ch, n_ch):
            raise ValueError(f"neighbors matrix must be ({n_ch}, {n_ch}), got {excl.shape}")
        mask &= ~excl
    return mask


def _activity(
    block: NDArray[np.float64], sfreq: float, kind: ActivityKind, band: tuple[float, float]
) -> NDArray[np.float64]:
    if kind == "raw":
        return block.copy()
    sos = signal.butter(4, band, btype="bandpass", fs=sfreq, output="sos")
    return np.abs(signal.hilbert(signal.sosfiltfilt(sos, block, axis=1), axis=1))


def _ridge_weights(
    z_train: NDArray[np.float64], mask: NDArray[np.bool_], alpha: float
) -> NDArray[np.float64]:
    n_ch = z_train.shape[0]
    fc = np.full((n_ch, n_ch), np.nan)
    for target in range(n_ch):
        sources = np.flatnonzero(mask[target])
        if sources.size == 0:
            continue
        xs = z_train[sources]
        gram = xs @ xs.T + alpha * np.eye(sources.size)
        fc[target, sources] = np.linalg.solve(gram, xs @ z_train[target])
    return fc


def _score(
    method: FCMethod,
    fc: NDArray[np.float64],
    mask: NDArray[np.bool_],
    z_test: NDArray[np.float64],
) -> FlowPrediction:
    n_ch = z_test.shape[0]
    weights = np.where(mask, fc, 0.0)  # excluded predictors contribute nothing
    predicted = weights @ z_test
    r = np.full(n_ch, np.nan)
    r2 = np.full(n_ch, np.nan)
    status: list[str] = []
    for ch in range(n_ch):
        if not mask[ch].any():
            status.append("no_predictors")
            continue
        pred, act = predicted[ch], z_test[ch]
        if np.std(pred) == 0 or np.std(act) == 0:
            status.append("constant_series")
            continue
        r[ch] = float(np.corrcoef(pred, act)[0, 1])
        r2[ch] = float(1.0 - np.sum((act - pred) ** 2) / np.sum((act - act.mean()) ** 2))
        status.append("ok")
    shown = fc.copy()
    shown[~mask] = np.nan
    finite = np.isfinite(r)
    return FlowPrediction(
        method=method,
        fc=shown,
        r=r,
        r2=r2,
        channel_status=status,
        mean_r=float(np.mean(r[finite])) if finite.any() else float("nan"),
        mean_r2=float(np.mean(r2[finite])) if finite.any() else float("nan"),
        predicted=predicted,
    )


def run_activity_flow(
    x: NDArray[np.float64] | Sequence[Sequence[float]],
    sfreq: float,
    *,
    activity: ActivityKind = "envelope",
    band: tuple[float, float] = (8.0, 13.0),
    train_fraction: float = 0.6,
    gap_s: float = 1.0,
    fc_methods: Sequence[FCMethod] = ("pearson", "regression"),
    ridge_alpha: float = 1.0,
    neighbors: Neighbors | None = None,
    example_channel: int = 0,
) -> ActivityFlowResult:
    """Activity flow mapping with a contiguous TRAIN / gap / TEST split.

    Parameters
    ----------
    x:
        ``(n_channels, n_times)`` resting data.
    activity:
        ``"envelope"`` (band amplitude envelope, default) or ``"raw"``.
    train_fraction, gap_s:
        TRAIN = first ``train_fraction`` of samples; TEST starts ``gap_s`` seconds later.
    ridge_alpha:
        L2 penalty (absolute, on z-scored TRAIN sums of squares) for regression FC.
    neighbors:
        Extra predictors to exclude per target: boolean ``[target, source]`` matrix (see
        :func:`neighbors_within_radius`) or ``{target: [sources]}``.
    """
    data = np.asarray(x, dtype=float)
    band_out = band if activity == "envelope" else None

    def fail(reason: str) -> ActivityFlowResult:
        return ActivityFlowResult(
            status="ineligible", reason=reason, activity=activity, band=band_out, sfreq=sfreq
        )

    if data.ndim != 2 or data.shape[0] < 2:
        return fail(f"x must be (n_channels >= 2, n_times), got shape {data.shape}")
    if not np.all(np.isfinite(data)):
        return fail("x contains non-finite values")
    if activity not in ("envelope", "raw"):
        return fail(f"unknown activity kind {activity!r}")
    unknown = [m for m in fc_methods if m not in ("pearson", "regression")]
    if unknown or not fc_methods:
        return fail(f"fc_methods must be non-empty subset of pearson/regression: {unknown}")
    if not 0 < train_fraction < 1:
        return fail("train_fraction must be in (0, 1)")
    if activity == "envelope" and not 0 < band[0] < band[1] < sfreq / 2:
        return fail(f"band {band} must satisfy 0 < low < high < Nyquist ({sfreq / 2})")
    n_ch, n_times = data.shape
    if not 0 <= example_channel < n_ch:
        return fail(f"example_channel {example_channel} out of range")
    n_train = int(round(train_fraction * n_times))
    gap = int(round(gap_s * sfreq))
    test_start = n_train + gap
    min_block = max(n_ch + 2, 30)
    if n_train < min_block or n_times - test_start < min_block:
        return fail(
            f"blocks too short: train={n_train}, test={n_times - test_start} samples "
            f"(need >= {min_block} each after a {gap}-sample gap)"
        )
    try:
        mask = _predictor_mask(n_ch, neighbors)
    except (ValueError, IndexError) as exc:
        return fail(f"invalid neighbors: {exc}")

    act_train = _activity(data[:, :n_train], sfreq, activity, band)
    act_test = _activity(data[:, test_start:], sfreq, activity, band)
    mean = act_train.mean(axis=1, keepdims=True)
    std = act_train.std(axis=1, keepdims=True)
    if np.any(std == 0):
        flat = np.flatnonzero(std[:, 0] == 0).tolist()
        return fail(f"channels {flat} have zero TRAIN variance; cannot z-score")
    z_train = (act_train - mean) / std
    z_test = (act_test - mean) / std

    predictions: dict[str, FlowPrediction] = {}
    for method in fc_methods:
        if method == "pearson":
            fc = np.corrcoef(z_train)
            np.fill_diagonal(fc, np.nan)
        else:
            fc = _ridge_weights(z_train, mask, ridge_alpha)
        predictions[method] = _score(method, fc, mask, z_test)

    comparison = {m: {"mean_r": p.mean_r, "mean_r2": p.mean_r2} for m, p in predictions.items()}
    ranked = [m for m in predictions if np.isfinite(predictions[m].mean_r)]
    best = max(ranked, key=lambda m: predictions[m].mean_r) if ranked else None
    return ActivityFlowResult(
        status="ok",
        reason=None,
        activity=activity,
        band=band_out,
        sfreq=sfreq,
        train_samples=(0, n_train),
        test_samples=(test_start, n_times),
        gap_samples=gap,
        predictor_mask=mask,
        predictions=predictions,
        actual_test=z_test,
        example_channel=example_channel,
        example_actual=z_test[example_channel],
        example_predicted={m: p.predicted[example_channel] for m, p in predictions.items()},
        comparison=comparison,
        best_method=best,
    )
