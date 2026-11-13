"""Oracle tests for the DCM-style linear effective model and activity flow mapping."""

import numpy as np
import pytest
from neurobridge.flow.activity_flow import neighbors_within_radius, run_activity_flow
from neurobridge.flow.effective import (
    compare_linear_models,
    fit_linear_state_space,
    standard_candidates,
)
from scipy import linalg, signal

DT = 0.01
FS = 1.0 / DT


def _simulate_linear(a_c: np.ndarray, n_times: int, seed: int) -> np.ndarray:
    """Exact discretisation of dx = A_c x dt + dW (truth used only to generate)."""
    rng = np.random.default_rng(seed)
    a_d = linalg.expm(a_c * DT)
    noise = rng.standard_normal((a_c.shape[0], n_times)) * np.sqrt(DT)
    x = np.zeros((a_c.shape[0], n_times))
    for t in range(1, n_times):
        x[:, t] = a_d @ x[:, t - 1] + noise[:, t]
    return x


def _ar1_sources(n: int, n_times: int, rng: np.random.Generator) -> np.ndarray:
    return signal.lfilter([1.0], [1.0, -0.9], rng.standard_normal((n, n_times)), axis=1)


def test_recovered_continuous_a_matches_sparse_truth() -> None:
    truth = np.diag([-10.0, -12.0, -8.0, -15.0, -10.0])
    truth[1, 0], truth[2, 1], truth[4, 3] = 6.0, -5.0, 7.0  # [target, source]
    fit = fit_linear_state_space(_simulate_linear(truth, 20_000, seed=0), DT)

    assert fit.status == "ok"
    assert fit.conversion == "logm"
    assert fit.stable is True
    assert "SPM DCM이 아닙니다" in fit.method_note
    off = ~np.eye(5, dtype=bool)
    assert np.corrcoef(fit.A[off], truth[off])[0, 1] > 0.9
    edges = truth != 0
    true_off = edges & off
    assert np.all(np.sign(fit.A[true_off]) == np.sign(truth[true_off]))
    assert np.min(np.abs(fit.A[true_off])) > np.max(np.abs(fit.A[off & ~edges]))


def test_model_comparison_prefers_true_forward_model() -> None:
    truth = np.array([[-10.0, 0.0], [8.0, -10.0]])  # node 0 -> node 1
    x = _simulate_linear(truth, 5_000, seed=1)
    result = compare_linear_models(x, DT, standard_candidates(2, source=0, target=1))

    assert result.status == "ok"
    assert result.best_model == "forward"
    fits = result.by_name()
    assert fits["forward"].bic < fits["backward"].bic
    assert fits["forward"].bic < fits["none"].bic
    assert fits["forward"].posterior > 0.9
    assert fits["backward"].posterior < 1e-6
    assert fits["none"].posterior < 1e-6
    total = sum(f.posterior for f in result.models)
    assert total == pytest.approx(1.0)
    assert fits["forward"].A_discrete[0, 1] == 0.0  # masked entry is structurally absent


def test_null_system_prefers_model_without_directed_edges() -> None:
    x = _simulate_linear(np.diag([-10.0, -10.0]), 5_000, seed=2)
    result = compare_linear_models(x, DT, standard_candidates(2, source=0, target=1))
    assert result.best_model == "none"


def test_rank_deficient_average_reference_is_ineligible_not_zero() -> None:
    x = _simulate_linear(np.diag([-10.0, -10.0, -10.0]), 2_000, seed=3)
    x = x - x.mean(axis=0, keepdims=True)  # average reference -> linearly dependent rows
    fit = fit_linear_state_space(x, DT)
    assert fit.status == "ineligible"
    assert fit.A is None
    assert "rank-deficient" in fit.reason


def test_activity_flow_predicts_linear_mixture_and_not_independent_channels() -> None:
    rng = np.random.default_rng(4)
    sources = _ar1_sources(4, 6_000, rng)
    weights = rng.standard_normal((12, 4))
    mixed = weights @ sources + 0.1 * rng.standard_normal((12, 6_000))

    result = run_activity_flow(mixed, FS, activity="raw")
    assert result.status == "ok"
    assert result.predictions["regression"].mean_r > 0.95
    assert result.predictions["pearson"].mean_r > 0.8
    assert result.best_method == "regression"
    assert "시간적 방향성" in result.method_note
    assert result.example_actual.shape == result.example_predicted["pearson"].shape

    independent = rng.standard_normal((12, 6_000))
    null = run_activity_flow(independent, FS, activity="raw")
    for method in ("pearson", "regression"):
        assert abs(null.predictions[method].mean_r) < 0.05

    envelope = run_activity_flow(mixed, FS, activity="envelope", band=(1.0, 10.0))
    assert envelope.predictions["regression"].mean_r > 0.7


def test_fc_is_estimated_on_train_only() -> None:
    rng = np.random.default_rng(5)
    x = rng.standard_normal((6, 3)) @ _ar1_sources(3, 4_000, rng)
    x += 0.2 * rng.standard_normal(x.shape)
    base = run_activity_flow(x, FS, activity="raw")
    start, _ = base.test_samples

    mutated = x.copy()
    mutated[:, start - base.gap_samples :] = rng.standard_normal(
        (6, x.shape[1] - start + base.gap_samples)
    )
    changed = run_activity_flow(mutated, FS, activity="raw")
    for method in ("pearson", "regression"):
        np.testing.assert_array_equal(base.predictions[method].fc, changed.predictions[method].fc)
        assert changed.predictions[method].mean_r < base.predictions[method].mean_r - 0.5


def test_neighbour_exclusion_reduces_volume_conduction_prediction() -> None:
    rng = np.random.default_rng(6)
    n_ch = 20
    positions = np.arange(n_ch, dtype=float)[:, None]
    smear = np.exp(-np.abs(positions - positions.T) / 1.5)  # field spread to neighbours
    x = smear @ _ar1_sources(n_ch, 6_000, rng) + 0.05 * rng.standard_normal((n_ch, 6_000))

    full = run_activity_flow(x, FS, activity="raw")
    excluded = run_activity_flow(
        x, FS, activity="raw", neighbors=neighbors_within_radius(positions, 3.0)
    )
    for method in ("pearson", "regression"):
        assert excluded.predictions[method].mean_r < full.predictions[method].mean_r - 0.3
    assert not excluded.predictor_mask[5, 4]
    assert np.isnan(excluded.predictions["regression"].fc[5, 4])


def test_multilag_model_comparison_on_oscillators():
    """Coupled damped oscillators: VAR(order>1) candidates recover the true direction
    and pick 'none' when uncoupled, where a lag-1 description is misspecified."""
    import numpy as np
    from neurobridge.flow.effective import compare_linear_models, standard_candidates

    def simulate(coupling: float, seed: int) -> np.ndarray:
        rng = np.random.default_rng(seed)
        n = 20000
        x = np.zeros((2, n))
        r, theta = 0.97, 2 * np.pi * 10 / 256
        a1, a2 = 2 * r * np.cos(theta), -(r**2)
        for t in range(2, n):
            x[0, t] = a1 * x[0, t - 1] + a2 * x[0, t - 2] + rng.standard_normal()
            x[1, t] = (
                a1 * x[1, t - 1] + a2 * x[1, t - 2] + coupling * x[0, t - 2] + rng.standard_normal()
            )
        return x

    dt = 1 / 256
    coupled = compare_linear_models(simulate(0.3, 1), dt, standard_candidates(2, 0, 1), order=4)
    assert coupled.best_model == "forward"
    uncoupled = compare_linear_models(simulate(0.0, 2), dt, standard_candidates(2, 0, 1), order=4)
    assert uncoupled.best_model == "none"
