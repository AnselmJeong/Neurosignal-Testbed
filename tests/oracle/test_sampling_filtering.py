import numpy as np
from neurobridge.contracts.models import ExperimentRecipe, PreprocessingSpec, SimulationSpec
from neurobridge.preprocessing import apply_preprocessing
from neurobridge.service import run_experiment
from neurobridge.simulation import simulate_linear_mixture, to_mne_raw


def test_simulation_is_deterministic() -> None:
    spec = SimulationSpec(seed=17)
    first = simulate_linear_mixture(spec)
    second = simulate_linear_mixture(spec)
    np.testing.assert_array_equal(first.sensor_uv, second.sensor_uv)


def test_average_reference_removes_channel_mean() -> None:
    simulation = simulate_linear_mixture(SimulationSpec())
    filtered = apply_preprocessing(
        simulation.sensor_uv,
        250,
        PreprocessingSpec(highpass_hz=None, lowpass_hz=None, notch_hz=None),
    )
    np.testing.assert_allclose(filtered.values_uv.mean(axis=0), 0, atol=1e-12)


def test_filter_retains_alpha_and_attenuates_line_noise() -> None:
    result = run_experiment(ExperimentRecipe())
    frequency = np.asarray(result.spectrum.frequency_hz)
    raw = np.asarray(result.spectrum.raw_power)
    filtered = np.asarray(result.spectrum.filtered_power)
    alpha = np.argmin(np.abs(frequency - 10))
    line = np.argmin(np.abs(frequency - 60))
    assert filtered[alpha] > filtered[line] * 100
    assert filtered[line] < raw[line] * 0.01
    assert result.peak_frequencies_hz == [2.0, 10.0]


def test_mne_raw_uses_si_volts() -> None:
    simulation = simulate_linear_mixture(SimulationSpec(duration_s=2))
    raw = to_mne_raw(simulation, 250)
    np.testing.assert_allclose(raw.get_data(), simulation.sensor_uv * 1e-6)


def test_sampling_below_source_frequency_reports_alias_warning() -> None:
    result = run_experiment(
        ExperimentRecipe(
            simulation=SimulationSpec(sampling_rate_hz=100),
            preprocessing=PreprocessingSpec(lowpass_hz=40, notch_hz=None),
        )
    )
    assert "source_aliasing" in {warning.code for warning in result.warnings}
