import numpy as np
import pytest
from neurobridge.connectivity import run_connectivity_challenge
from neurobridge.contracts.models import ConnectivityRecipe


def test_planted_lagged_edge_survives_surrogate_threshold() -> None:
    result = run_connectivity_challenge(
        ConnectivityRecipe(metric="imcoh", analysis_space="latent", surrogate_count=32)
    )
    assert result.scores.strongest_edge_correct is True
    assert result.scores.true_positive == 1
    assert result.scores.false_positive == 0
    assert result.scores.recall == 1
    assert result.scores.weighted_truth_correlation > 0.9


def test_null_network_does_not_invent_a_planted_edge() -> None:
    result = run_connectivity_challenge(
        ConnectivityRecipe(
            analysis_space="latent",
            coupling_strength=0,
            metric="coh",
            surrogate_count=32,
        )
    )
    assert result.scores.true_positive == 0
    assert result.scores.strongest_edge_correct is False
    assert result.scores.false_positive <= 1


def test_sensor_coherence_exposes_volume_conduction_bias() -> None:
    result = run_connectivity_challenge(
        ConnectivityRecipe(metric="coh", analysis_space="sensor", surrogate_count=20)
    )
    detected_sensor_edges = [edge for edge in result.thresholded_edges if edge.detected]
    assert len(detected_sensor_edges) >= 4
    assert "sensor_volume_conduction" in {warning.code for warning in result.warnings}


def test_spectrum_recovers_alpha_and_aperiodic_fit() -> None:
    result = run_connectivity_challenge(
        ConnectivityRecipe(analysis_space="latent", surrogate_count=20)
    )
    parameterization = result.spectrum.parameterization
    assert parameterization.peak_frequency_hz is not None
    assert abs(parameterization.peak_frequency_hz - result.recipe.alpha_frequency_hz) < 0.5
    assert 1.0 < parameterization.exponent < 2.0
    assert parameterization.r_squared > 0.9
    assert np.all(np.asarray(result.spectrum.welch_power) > 0)


@pytest.mark.parametrize("metric", ["pearson", "coh", "imcoh", "plv", "ppc", "pli", "wpli"])
def test_all_mvp_estimators_return_bounded_symmetric_matrices(metric: str) -> None:
    result = run_connectivity_challenge(
        ConnectivityRecipe(metric=metric, analysis_space="latent", surrogate_count=20)
    )
    matrix = np.asarray(result.latent.values)
    np.testing.assert_allclose(matrix, matrix.T)
    assert np.all((matrix >= 0) & (matrix <= 1))
    assert result.estimator_backend == ("numpy" if metric == "pearson" else "mne-connectivity")


def test_preview_is_the_exact_epoch_used_by_estimation() -> None:
    from neurobridge.connectivity import simulate_connectivity
    from neurobridge.connectivity.engine import LATENT_NAMES, SENSOR_NAMES, _simulate

    recipe = ConnectivityRecipe(metric="pearson", surrogate_count=20)
    preview = simulate_connectivity(recipe)
    data = _simulate(recipe)
    result = run_connectivity_challenge(recipe)
    assert preview == result.simulation
    assert preview.epoch_index == 0
    assert preview.latent_trace.y_unit == preview.sensor_trace.y_unit == "a.u."
    np.testing.assert_allclose(preview.latent_trace.x, np.arange(400) / 200)
    for names, trace, epochs in [
        (LATENT_NAMES, preview.latent_trace, data.latent_epochs),
        (SENSOR_NAMES, preview.sensor_trace, data.sensor_epochs),
    ]:
        assert list(trace.series) == names
        np.testing.assert_allclose(list(trace.series.values()), epochs[0], atol=5.1e-7)


def test_mixing_and_reference_changes_preserve_source_samples() -> None:
    from neurobridge.connectivity import simulate_connectivity

    recipe = ConnectivityRecipe()
    baseline = simulate_connectivity(recipe)
    for change in [{"volume_conduction": 0.1}, {"reference": "none"}]:
        altered = simulate_connectivity(recipe.model_copy(update=change))
        assert altered.latent_trace == baseline.latent_trace
        assert altered.sensor_trace != baseline.sensor_trace
    mean_sensor = np.asarray(list(baseline.sensor_trace.series.values())).mean(axis=0)
    np.testing.assert_allclose(mean_sensor, 0, atol=1e-6)


def test_coupling_changes_only_frontal_r_before_sensor_mixing() -> None:
    from neurobridge.connectivity import simulate_connectivity

    recipe = ConnectivityRecipe()
    baseline = simulate_connectivity(recipe)
    independent = simulate_connectivity(recipe.model_copy(update={"coupling_strength": 0}))
    for name in ["Frontal L", "Posterior L", "Posterior R"]:
        assert baseline.latent_trace.series[name] == independent.latent_trace.series[name]
    assert baseline.latent_trace.series["Frontal R"] != independent.latent_trace.series["Frontal R"]
    assert baseline.sensor_trace != independent.sensor_trace
    no_lag = simulate_connectivity(independent.recipe.model_copy(update={"phase_lag_deg": 0}))
    assert no_lag.latent_trace == independent.latent_trace
    assert no_lag.sensor_trace == independent.sensor_trace



def test_changing_metric_and_spectral_mode_preserves_actual_analysis_signals() -> None:
    recipe = ConnectivityRecipe(metric="coh", surrogate_count=20)
    coherence = run_connectivity_challenge(recipe)
    plv = run_connectivity_challenge(
        recipe.model_copy(update={"metric": "plv", "spectral_mode": "fourier"})
    )
    assert coherence.simulation.latent_trace == plv.simulation.latent_trace
    assert coherence.simulation.sensor_trace == plv.simulation.sensor_trace
    assert coherence.truth == plv.truth
    assert coherence.sensor.metric == "coh"
    assert plv.sensor.metric == "plv"
    assert coherence.sensor.values != plv.sensor.values
