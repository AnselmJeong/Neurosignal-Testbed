"""Oracle tests for partial information decomposition (neurobridge.flow.pid)."""

from __future__ import annotations

import numpy as np
import pytest
from neurobridge.benchmarks.contracts import MetricStatus
from neurobridge.flow.pid import (
    LN2,
    PIDResult,
    discrete_pid_williams_beer,
    gaussian_pid,
    gaussian_pid_from_cov,
    integration_demo,
    teaching_distribution,
    teaching_examples,
    time_lagged_pid,
)

TERMS = ("redundancy", "unique_s1", "unique_s2", "synergy")


def _assert_sums(res: PIDResult) -> None:
    for terms in (res.nats, res.bits):
        assert terms is not None
        total = terms.redundancy + terms.unique_s1 + terms.unique_s2 + terms.synergy
        assert total == pytest.approx(terms.i_s12_t, abs=1e-12)
        assert terms.co_information == pytest.approx(terms.redundancy - terms.synergy, abs=1e-12)
        assert terms.interaction_information == pytest.approx(-terms.co_information, abs=1e-12)


# --------------------------------------------------------------------------- Gaussian


def test_sum_target_closed_form_has_mmi_synergy_and_min_redundancy() -> None:
    sigma2 = 0.5
    # variables: X1, X2, T = X1 + X2 + noise (independent unit-variance X1, X2)
    cov = np.array(
        [
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
            [1.0, 1.0, 2.0 + sigma2],
        ]
    )
    res = gaussian_pid_from_cov(cov, [0], [1], [2])
    assert res.status is MetricStatus.OK and res.measure == "mmi"
    i1 = 0.5 * np.log((2.0 + sigma2) / (1.0 + sigma2))
    i12 = 0.5 * np.log((2.0 + sigma2) / sigma2)
    n = res.nats
    assert n.i_s1_t == pytest.approx(i1, rel=1e-12)
    assert n.i_s2_t == pytest.approx(i1, rel=1e-12)
    assert n.i_s12_t == pytest.approx(i12, rel=1e-12)
    assert n.redundancy == pytest.approx(min(n.i_s1_t, n.i_s2_t), abs=0)
    assert n.synergy == pytest.approx(i12 - i1, rel=1e-12)
    assert n.synergy > 0.1
    assert res.bits.synergy == pytest.approx(n.synergy / LN2, rel=1e-12)
    _assert_sums(res)


def test_sum_target_from_samples_matches_closed_form() -> None:
    rng = np.random.default_rng(1)
    x1, x2 = rng.standard_normal((2, 50_000))
    t = x1 + x2 + np.sqrt(0.5) * rng.standard_normal(50_000)
    res = gaussian_pid(x1, x2, t)
    assert res.status is MetricStatus.OK
    assert res.nats.synergy == pytest.approx(0.5 * np.log(5.0) - 0.5 * np.log(2.5 / 1.5), abs=0.02)
    assert res.nats.redundancy == min(res.nats.i_s1_t, res.nats.i_s2_t)
    _assert_sums(res)


def test_single_driver_gives_unique_information_and_no_synergy() -> None:
    rng = np.random.default_rng(2)
    x1, x2 = rng.standard_normal((2, 50_000))
    t = x1 + 0.7 * rng.standard_normal(50_000)
    res = gaussian_pid(x1, x2, t)
    n = res.nats
    assert n.i_s1_t == pytest.approx(0.5 * np.log(1.49 / 0.49), abs=0.02)
    assert n.unique_s1 == pytest.approx(n.i_s1_t, abs=0.005)
    assert abs(n.synergy) < 0.005
    assert abs(n.unique_s2) < 1e-12  # MMI: X2 carries the minimum, so U2 = 0 exactly
    _assert_sums(res)


def test_copied_sources_are_pure_redundancy() -> None:
    rng = np.random.default_rng(3)
    x = rng.standard_normal(20_000)
    t = x + 0.8 * rng.standard_normal(20_000)
    res = gaussian_pid(x, x.copy(), t)
    assert res.status is MetricStatus.OK
    n = res.nats
    assert n.redundancy == pytest.approx(n.i_s1_t, rel=1e-9)
    assert n.i_s12_t == pytest.approx(n.i_s1_t, rel=1e-9)
    assert abs(n.synergy) < 1e-9
    assert abs(n.unique_s1) < 1e-9 and abs(n.unique_s2) < 1e-9
    assert res.diagnostics["rank_s12"] == 1
    # closed form with a shared index is the same statement
    cov = np.array([[1.0, 1.0], [1.0, 1.64]])
    exact = gaussian_pid_from_cov(cov, [0], [0], [1])
    assert exact.nats.redundancy == pytest.approx(0.5 * np.log(1.64 / 0.64), rel=1e-12)
    assert exact.nats.synergy == pytest.approx(0.0, abs=1e-12)


def test_independent_gaussians_are_near_zero() -> None:
    rng = np.random.default_rng(4)
    x1, x2, t = rng.standard_normal((3, 50_000))
    res = gaussian_pid(x1, x2, t)
    for key in TERMS:
        assert abs(getattr(res.nats, key)) < 2e-4
    assert res.diagnostics["approx_plugin_bias_nats"]["i_s12_t"] == pytest.approx(2 / 1e5)


def test_ineligible_inputs_are_statuses_not_zeros() -> None:
    rng = np.random.default_rng(5)
    x1, x2 = rng.standard_normal((2, 1_000))
    deterministic = gaussian_pid(x1, x2, x1 + x2)
    assert deterministic.status is MetricStatus.INVALID_INPUT
    assert deterministic.reason_code == "target_determined_by_sources"
    assert deterministic.nats is None and deterministic.bits is None
    few = gaussian_pid(x1[:20], x2[:20], x1[:20])
    assert few.status is MetricStatus.INSUFFICIENT_DATA and few.nats is None
    nan = gaussian_pid(np.r_[x1[:-1], np.nan], x2, x1)
    assert nan.status is MetricStatus.INVALID_INPUT and nan.reason_code == "non_finite"
    overlap = gaussian_pid_from_cov(np.eye(3), [0], [1], [1])
    assert overlap.reason_code == "target_overlaps_sources"


def test_time_lagged_pid_detects_integration_vs_single_drive() -> None:
    demo = integration_demo(n_times=40_000, seed=7)
    both, only_a = demo["integrates_a_and_b"], demo["a_only"]
    assert both.status is MetricStatus.OK and only_a.status is MetricStatus.OK
    assert both.nats.synergy > 0.1
    assert both.nats.redundancy == min(both.nats.i_s1_t, both.nats.i_s2_t)
    assert abs(only_a.nats.synergy) < 0.005
    assert only_a.nats.unique_s1 == pytest.approx(only_a.nats.i_s1_t, abs=0.005)
    assert only_a.nats.unique_s1 > 0.2
    _assert_sums(both)
    assert both.diagnostics["lag"] == 1 and both.diagnostics["n_samples"] == 40_000 - 1


def test_time_lagged_pid_history_and_lag_alignment() -> None:
    rng = np.random.default_rng(8)
    n = 30_000
    a, b = rng.standard_normal((2, n))
    c = np.zeros(n)
    c[3:] = a[:-3] + b[:-3]
    c += 0.5 * rng.standard_normal(n)
    x = np.vstack([a, b, c])
    aligned = time_lagged_pid(x, 0, 1, 2, lag=3, history=1)
    misaligned = time_lagged_pid(x, 0, 1, 2, lag=1, history=1)
    embedded = time_lagged_pid(x, 0, 1, 2, lag=1, history=3)
    assert aligned.nats.i_s12_t > 0.5
    assert misaligned.nats.i_s12_t < 0.01
    assert embedded.nats.i_s12_t == pytest.approx(aligned.nats.i_s12_t, abs=0.01)
    assert embedded.diagnostics["dims"] == {"s1": 3, "s2": 3, "t": 1}
    bad = time_lagged_pid(x, 0, 1, 5)
    assert bad.status is MetricStatus.INVALID_INPUT and bad.reason_code == "invalid_channel"
    short = time_lagged_pid(x[:, :4], 0, 1, 2, lag=3, history=2)
    assert short.status is MetricStatus.INSUFFICIENT_DATA


# --------------------------------------------------------------------------- discrete


def test_xor_is_pure_synergy() -> None:
    b = discrete_pid_williams_beer(teaching_distribution("xor")).bits
    assert b.synergy == pytest.approx(1.0, abs=1e-12)
    assert b.redundancy == pytest.approx(0.0, abs=1e-12)
    assert b.unique_s1 == pytest.approx(0.0, abs=1e-12)
    assert b.unique_s2 == pytest.approx(0.0, abs=1e-12)


def test_and_gate_matches_williams_beer_values() -> None:
    res = discrete_pid_williams_beer(teaching_distribution("and"))
    b = res.bits
    h_t = -(0.75 * np.log2(0.75) + 0.25 * np.log2(0.25))
    i_single = h_t - 0.5 * 1.0  # H(T) - H(T|X1): T is uncertain (1 bit) only when X1 = 1
    assert b.i_s1_t == pytest.approx(i_single, abs=1e-12)
    assert b.redundancy == pytest.approx(0.311278, abs=1e-6)
    assert b.synergy == pytest.approx(0.5, abs=1e-12)
    assert b.unique_s1 == pytest.approx(0.0, abs=1e-12)
    assert b.i_s12_t == pytest.approx(0.811278, abs=1e-6)
    assert res.nats.synergy == pytest.approx(0.5 * LN2, abs=1e-12)
    _assert_sums(res)


def test_two_bit_copy_shows_imin_measure_dependence() -> None:
    """T = (X1, X2). Intuition/BROJA: U1 = U2 = 1 bit. Williams-Beer I_min: R = S = 1 bit."""
    res = discrete_pid_williams_beer(teaching_distribution("copy"))
    b = res.bits
    assert b.i_s1_t == pytest.approx(1.0, abs=1e-12)
    assert b.i_s2_t == pytest.approx(1.0, abs=1e-12)
    assert b.i_s12_t == pytest.approx(2.0, abs=1e-12)
    assert b.redundancy == pytest.approx(1.0, abs=1e-12)
    assert b.synergy == pytest.approx(1.0, abs=1e-12)
    assert b.unique_s1 == pytest.approx(0.0, abs=1e-12)
    assert any("BROJA" in note for note in res.notes)


def test_single_copy_is_unique_and_identical_inputs_are_redundant() -> None:
    unique = discrete_pid_williams_beer(teaching_distribution("unique")).bits
    assert unique.unique_s1 == pytest.approx(1.0, abs=1e-12)
    for key in ("redundancy", "unique_s2", "synergy"):
        assert getattr(unique, key) == pytest.approx(0.0, abs=1e-12)
    red = discrete_pid_williams_beer(teaching_distribution("redundant")).bits
    assert red.redundancy == pytest.approx(1.0, abs=1e-12)
    for key in ("unique_s1", "unique_s2", "synergy"):
        assert getattr(red, key) == pytest.approx(0.0, abs=1e-12)


def test_discrete_independence_is_zero_and_bad_tables_are_statuses() -> None:
    b = discrete_pid_williams_beer(teaching_distribution("independent")).bits
    for key in (*TERMS, "i_s12_t"):
        assert getattr(b, key) == pytest.approx(0.0, abs=1e-12)
    unnormalised = discrete_pid_williams_beer(np.ones((2, 2, 2)))
    assert unnormalised.status is MetricStatus.INVALID_INPUT and unnormalised.bits is None
    assert discrete_pid_williams_beer(np.ones((2, 2))).reason_code == "invalid_shape"
    examples = teaching_examples()
    assert set(examples) >= {"xor", "and", "copy", "independent"}
    assert all(r.status is MetricStatus.OK for r in examples.values())
    assert examples["xor"].model_dump(mode="json")["bits"]["synergy"] == pytest.approx(1.0)
