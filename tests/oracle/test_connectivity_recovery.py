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
