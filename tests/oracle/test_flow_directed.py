"""Oracle tests for Granger causality (M27) and transfer entropy (M28) (plan V16).

Fixtures have a known generating graph; analysis functions only see the time series.
"""

from __future__ import annotations

import numpy as np
import pytest
from neurobridge.benchmarks.contracts import MetricStatus
from neurobridge.flow import granger
from neurobridge.flow import transfer_entropy as te
from neurobridge.metrics import directed, registry

FS = 100.0


def _var_a_to_b(n_times: int = 4000, seed: int = 1) -> np.ndarray:
    """VAR(2): A autonomous, B driven by A at lag 1. Channel 0 = A, 1 = B."""
    rng = np.random.default_rng(seed)
    x = np.zeros((2, n_times))
    e = rng.standard_normal((2, n_times))
    for t in range(2, n_times):
        x[0, t] = 0.5 * x[0, t - 1] - 0.2 * x[0, t - 2] + e[0, t]
        x[1, t] = 0.4 * x[1, t - 1] + 0.5 * x[0, t - 1] + e[1, t]
    return x


def _fork(n_times: int = 5000, seed: int = 2) -> np.ndarray:
    """C (channel 2) drives A (0) at lag 1 and B (1) at lag 3; no A-B edge."""
    rng = np.random.default_rng(seed)
    x = np.zeros((3, n_times))
    e = rng.standard_normal((3, n_times))
    for t in range(3, n_times):
        x[2, t] = 0.6 * x[2, t - 1] + e[2, t]
        x[0, t] = 0.8 * x[2, t - 1] + 0.5 * e[0, t]
        x[1, t] = 0.8 * x[2, t - 3] + 0.5 * e[1, t]
    return x


def _nonlinear(n_times: int = 3000, seed: int = 3) -> np.ndarray:
    """B_t = A_{t-1}^2 - 1 + noise: zero linear cross-covariance, strong dependence."""
    rng = np.random.default_rng(seed)
    a = rng.standard_normal(n_times)
    b = np.zeros(n_times)
    b[1:] = a[:-1] ** 2 - 1.0 + 0.5 * rng.standard_normal(n_times - 1)
    return np.vstack([a, b])


# --------------------------------------------------------------------------- GC


def test_known_var_direction_and_order_selection():
    x = _var_a_to_b()
    sel = granger.select_order(x, max_order=8, criterion="bic")
    assert sel.status == "ok" and sel.order == 2
    fit = granger.fit_var(x, 2)
    assert fit.stable and fit.max_eigenvalue_modulus < 1
    assert fit.coefs.shape == (2, 2, 2)
    assert fit.coefs[0, 1, 0] == pytest.approx(0.5, abs=0.05)  # [lag1][target B, source A]
    assert fit.whiteness["min_p"] > 0.01

    res = granger.pairwise_gc(x, "bic")
    assert res.ok and res.gc is not None and res.p_values is not None
    assert res.gc[1, 0] > 0.15  # A -> B
    assert res.gc[0, 1] < 0.01  # B -> A
    assert res.gc[1, 0] > 20 * res.gc[0, 1]
    assert res.p_values[1, 0] < 1e-10
    assert res.p_values[0, 1] > 0.01
    assert np.isnan(np.diag(res.gc)).all()


def test_fork_pairwise_spurious_conditional_removes_it():
    x = _fork()
    pw = granger.pairwise_gc(x, 4)
    cond = granger.conditional_gc(x, 4)
    assert pw.ok and cond.ok
    assert pw.gc is not None and cond.gc is not None
    assert pw.p_values is not None and cond.p_values is not None
    # A's past carries C_{t-3} two steps early: pairwise GC reports a spurious A -> B.
    assert pw.gc[1, 0] > 0.3 and pw.p_values[1, 0] < 1e-10
    # Conditioning on C removes it; the true C -> A and C -> B edges stay.
    assert cond.gc[1, 0] < 0.005 and cond.p_values[1, 0] > 0.01
    assert cond.p_values[0, 2] < 1e-10 and cond.p_values[1, 2] < 1e-10
    assert cond.diagnostics["var"]["stable"]


def test_time_reversal_flips_direction():
    tr = granger.time_reversed_gc(_var_a_to_b(), 2)
    assert tr.status == "ok"
    assert tr.dominance_forward is not None and tr.dominance_reversed is not None
    assert tr.dominance_forward[1, 0] > 0.1  # A -> B dominates forward
    assert tr.dominance_reversed[1, 0] < -0.1  # and flips under reversal
    assert tr.net is not None and tr.net[1, 0] > 0


def test_conditional_refuses_rank_deficient_and_short_data():
    rng = np.random.default_rng(4)
    y = rng.standard_normal((4, 3000))
    avg_ref = y - y.mean(axis=0)  # rank n - 1
    res = granger.conditional_gc(avg_ref, 2)
    assert res.status == "invalid_input" and res.reason_code == "rank_deficient"
    assert res.gc is None
    assert granger.pairwise_gc(avg_ref, 2).ok  # 2-channel subsets stay full rank

    short = granger.conditional_gc(rng.standard_normal((4, 40)), 3)
    assert short.status == "insufficient_data" and short.gc is None


def test_epoch_boundaries_are_not_crossed():
    x = _var_a_to_b(n_times=4000)
    epochs = x.reshape(2, 8, 500).transpose(1, 0, 2)
    concat = epochs.transpose(1, 0, 2).reshape(2, -1)
    a = granger.pairwise_gc(epochs, 2)
    b = granger.pairwise_gc(concat, 2, epoch_length=500)
    assert a.gc is not None and b.gc is not None
    np.testing.assert_allclose(a.gc, b.gc, equal_nan=True)
    assert granger.lagged_design(epochs, 2).y.shape[0] == 8 * (500 - 2)


def test_spectral_gc_backend_view():
    x = _var_a_to_b(n_times=4000).reshape(2, 8, 500).transpose(1, 0, 2)
    spec = granger.spectral_gc(x, FS, [(0, 1), (1, 0)], fmin=2.0, fmax=40.0, n_lags=10)
    if spec.status != "ok":
        pytest.skip(f"mne_connectivity spectral GC unsupported: {spec.message}")
    assert spec.spectra is not None and spec.freqs is not None
    assert spec.spectra.shape == (2, spec.freqs.size)
    assert spec.spectra[0].mean() > 10 * spec.spectra[1].mean()


# --------------------------------------------------------------------------- TE


def test_gaussian_te_equals_half_gc():
    x = _var_a_to_b()
    gc = granger.pairwise_gc(x, 2)
    assert gc.gc is not None
    res = te.gaussian_te(x, source=0, target=1, k_hist=2, l_hist=2, lag=1)
    assert res.ok and res.te is not None
    assert res.te == pytest.approx(gc.gc[1, 0] / 2, rel=1e-8)
    assert res.te_bits == pytest.approx(res.te / np.log(2))
    assert res.p_value_analytic is not None and res.p_value_analytic < 1e-10
    rev = te.gaussian_te(x, source=1, target=0, k_hist=2, l_hist=2, lag=1)
    assert rev.te == pytest.approx(gc.gc[0, 1] / 2, rel=1e-6)


def test_ksg_matches_gaussian_on_linear_gaussian():
    x = _var_a_to_b(n_times=3000)
    gauss = te.gaussian_te(x, 0, 1, k_hist=2, l_hist=2)
    ksg = te.ksg_te(x, 0, 1, k_hist=2, l_hist=2, k_neighbors=4, theiler=2)
    assert gauss.te is not None and ksg.te is not None
    assert ksg.te == pytest.approx(gauss.te, abs=0.03)
    assert ksg.parameters["bias_note"]


def test_ksg_detects_nonlinear_coupling_gc_misses():
    x = _nonlinear()
    gc = granger.pairwise_gc(x, 2)
    assert gc.p_values is not None and gc.p_values[1, 0] > 0.01  # linear GC blind
    lin = te.surrogate_test(x, 0, 1, estimator="gaussian", n_surrogates=99)
    assert lin.surrogate is not None and lin.surrogate.p_value > 0.05
    ksg = te.surrogate_test(x, 0, 1, estimator="ksg", n_surrogates=19)
    assert ksg.surrogate is not None and ksg.te is not None
    assert ksg.te > 0.3
    assert ksg.surrogate.p_value == pytest.approx(1 / 20)  # minimum attainable
    assert ksg.te > ksg.surrogate.null.max()


def test_independent_signals_surrogate_not_small_and_negative_kept():
    rng = np.random.default_rng(100)
    z = rng.standard_normal((2, 2000))
    res = te.surrogate_test(z, 0, 1, estimator="ksg", n_surrogates=19)
    assert res.surrogate is not None and res.surrogate.p_value > 0.2
    # Finite-sample KSG bias under independence is reported raw (no clip to 0).
    values = [
        te.ksg_te(np.random.default_rng(s).standard_normal((2, 1000)), 0, 1).te for s in range(6)
    ]
    assert any(v is not None and v < 0 for v in values)


# --------------------------------------------------------------------------- registry


def _run(metric_id, data, variant=None, **params):
    return registry.run(metric_id, data, {"sfreq": FS, "params": params}, variant=variant)


def test_registry_m27_variants_ok():
    caps = registry.capabilities()
    assert caps["M27"]["status"] == caps["M28"]["status"] == "implemented"
    assert set(caps["M27"]["variants"]) == {"pairwise", "conditional"}
    assert caps["M27"]["default_variant"] == "pairwise"
    assert set(caps["M28"]["variants"]) == {"gaussian", "ksg"}
    x = _fork(n_times=3000)
    pw = _run("M27", x, order=4, time_reversed=True)
    assert pw.status is MetricStatus.OK and pw.variant == "pairwise"
    assert pw.axes == ["target", "source"] and pw.units == "nats"
    vals = np.asarray(pw.values, dtype=float)
    assert vals.shape == (3, 3) and np.isnan(np.diag(vals)).all()
    assert "pairwise_common_input_not_removed" in pw.validity_flags
    assert pw.diagnostics["time_reversed"]["status"] == "ok"
    cond = _run("M27", x, variant="conditional", order="bic", max_order=6)
    assert cond.status is MetricStatus.OK
    cv = np.asarray(cond.values, dtype=float)
    assert cv[1, 0] < vals[1, 0]
    named = registry.run(
        "M27",
        x,
        {
            "sfreq": FS,
            "channel_names": ["A", "B", "C"],
            "params": {"order": 4, "pairs": [["C", "B"]]},
        },
    )
    nv = np.asarray(named.values, dtype=float)
    assert np.isfinite(nv[1, 2]) and np.isnan(nv[0, 1])


def test_registry_m27_refusals():
    rng = np.random.default_rng(5)
    y = rng.standard_normal((4, 2000))
    res = _run("M27", y - y.mean(axis=0), variant="conditional", order=2)
    assert res.status is MetricStatus.INVALID_INPUT and res.reason_code == "rank_deficient"
    assert res.values is None
    short = _run("M27", rng.standard_normal((3, 30)), variant="conditional", order=3)
    assert short.status is MetricStatus.INSUFFICIENT_DATA and short.values is None
    bad = _run("M27", y, pairs=[[0, 0]])
    assert bad.status is MetricStatus.INVALID_INPUT and bad.reason_code == "invalid_pair"


def test_registry_m28_variants_ok():
    x = _var_a_to_b(n_times=2000)
    gauss = _run("M28", x, k_hist=2, l_hist=2)
    assert gauss.status is MetricStatus.OK and gauss.variant == "gaussian"
    gv = np.asarray(gauss.values, dtype=float)
    assert gv[1, 0] > gv[0, 1] and np.isnan(np.diag(gv)).all()
    ksg = _run("M28", x, variant="ksg", pairs=[[0, 1], [1, 0]], n_surrogates=9)
    assert ksg.status is MetricStatus.OK
    kv = np.asarray(ksg.values, dtype=float)
    assert kv[1, 0] > kv[0, 1]
    assert ksg.diagnostics["p_values"][1][0] == pytest.approx(0.1)
    five = np.random.default_rng(6).standard_normal((5, 500))
    refused = _run("M28", five, variant="ksg")
    assert refused.status is MetricStatus.INVALID_INPUT and refused.reason_code == "pairs_required"
    assert set(directed.ADAPTERS) == {
        (m, v) for m in ("M27", "M28") for v in registry.registered_variants(m)
    }
