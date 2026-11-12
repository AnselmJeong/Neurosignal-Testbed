"""Oracle tests for SMI (M22) and wSMI (M23) via mne_connectivity.wsmi (plan V14)."""

from __future__ import annotations

import inspect
import math
from itertools import permutations

import numpy as np
import pytest
from mne_connectivity import wsmi
from neurobridge.benchmarks.contracts import MetricStatus
from neurobridge.metrics import information, registry

FS = 256.0


def _values(result) -> np.ndarray:
    assert result.status is MetricStatus.OK, (result.reason_code, result.message)
    return np.asarray(result.values, dtype=float)


def _run(metric_id: str, data: np.ndarray, **params):
    return registry.run(metric_id, data, {"sfreq": FS, "params": params})


def _reference_smi(x: np.ndarray, y: np.ndarray, kernel: int, tau: int, weighted: bool) -> float:
    """Independent numpy SMI/wSMI from ordinal-pattern joint counts (single epoch, no filter).

    wSMI weight is 0 for identical patterns and for exactly reversed (opposite) patterns.
    """
    n_sym = math.factorial(kernel)
    index = {p: i for i, p in enumerate(permutations(range(kernel)))}
    n = x.size - tau * (kernel - 1)

    def symbols(s: np.ndarray) -> list[tuple[int, ...]]:
        return [tuple(np.argsort(s[k : k + kernel * tau : tau])) for k in range(n)]

    sx, sy = symbols(x), symbols(y)
    joint = np.zeros((n_sym, n_sym))
    for a, b in zip(sx, sy, strict=True):
        joint[index[a], index[b]] += 1
    joint /= n
    px, py = joint.sum(axis=1), joint.sum(axis=0)
    total = 0.0
    for a, ia in index.items():
        for b, ib in index.items():
            if joint[ia, ib] <= 0:
                continue
            w = 0.0 if (a == b or a == b[::-1]) else 1.0
            term = joint[ia, ib] * np.log(joint[ia, ib] / (px[ia] * py[ib]))
            total += (w * term) if weighted else term
    return total / np.log(n_sym)


def test_installed_wsmi_signature_matches_adapter_assumption() -> None:
    params = list(inspect.signature(wsmi).parameters)
    assert params == [
        "data", "kernel", "tau", "indices", "sfreq", "names", "tmin", "tmax",
        "anti_aliasing", "weighted", "average", "verbose",
    ]  # fmt: skip


def test_m22_m23_registered_with_predeclared_taus() -> None:
    caps = registry.capabilities()
    assert caps["M22"]["status"] == caps["M23"]["status"] == "implemented"
    data = np.random.default_rng(0).standard_normal((2, 3, 512))
    res = registry.run("M23", data, {"sfreq": FS})
    vals = _values(res)
    assert vals.shape == (3, 3, 3)
    assert res.axes == ["tau", "channel_row", "channel_col"]
    p = res.parameters
    assert p["kernel"] == 3 and p["taus_samples"] == [2, 4, 8] and p["weighted"] is True
    for tau, expected in {"2": 42.67, "4": 21.33, "8": 10.67}.items():
        assert p["effective_lowpass_hz"][tau] == pytest.approx(expected, abs=0.01)
        assert p["anti_alias_filter_applied"][tau] is True
    assert np.all(np.isnan(np.diagonal(vals, axis1=1, axis2=2)))
    np.testing.assert_array_equal(vals, np.swapaxes(vals, 1, 2))
    assert registry.run("M22", data, {"sfreq": FS}).parameters["weighted"] is False


@pytest.mark.parametrize("weighted", [False, True])
def test_v14_matches_independent_joint_count_reference(weighted: bool) -> None:
    rng = np.random.default_rng(14)
    x = rng.standard_normal(600)
    data = np.stack([x, np.roll(x, 1) + 0.5 * rng.standard_normal(600), rng.standard_normal(600)])
    metric_id = "M23" if weighted else "M22"
    vals = _values(_run(metric_id, data[np.newaxis], taus=[2], anti_aliasing=False))[0]
    for i, j in [(1, 0), (2, 0), (2, 1)]:
        ref = _reference_smi(data[i], data[j], kernel=3, tau=2, weighted=weighted)
        assert vals[i, j] == pytest.approx(ref, abs=1e-9)


def test_v14_identical_opposite_and_independent_ordering() -> None:
    rng = np.random.default_rng(141)
    x = rng.standard_normal((8, 1, 1024))
    data = np.concatenate(
        [
            x,
            x.copy(),  # identical
            -x,  # opposite patterns
            rng.standard_normal(x.shape),  # independent
            np.roll(x, 2, axis=-1) + 0.3 * rng.standard_normal(x.shape),  # lagged coupling
        ],
        axis=1,
    )
    smi = _values(_run("M22", data, taus=[2], anti_aliasing=False))[0]
    w = _values(_run("M23", data, taus=[2], anti_aliasing=False))[0]
    # SMI counts identical/opposite patterns as maximal sharing.
    assert smi[1, 0] > 0.9 and smi[2, 0] > 0.9
    assert smi[1, 0] > smi[3, 0] and smi[4, 0] > smi[3, 0]
    # wSMI gives identical and opposite patterns zero weight (volume-conduction guard) ...
    assert w[1, 0] == pytest.approx(0.0, abs=1e-12)
    assert w[2, 0] == pytest.approx(0.0, abs=1e-12)
    # ... while a lagged dependency exceeds the independent-pair value.
    assert w[4, 0] > 2 * w[3, 0]
    assert w[3, 0] >= 0


def test_too_short_epochs_are_insufficient_data() -> None:
    data = np.random.default_rng(1).standard_normal((3, 2, 10))
    res = registry.run("M23", data, {"sfreq": FS})
    assert res.status is MetricStatus.INSUFFICIENT_DATA
    assert res.reason_code == "too_few_samples_for_symbols" and res.values is None
    assert information.anti_alias_cutoff_hz(256.0, 3, 4) == pytest.approx(256 / 12)
