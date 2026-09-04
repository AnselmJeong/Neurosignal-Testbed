import numpy as np
from neurobridge.contracts.models import ExperimentRecipe, PreprocessingSpec, SimulationSpec
from neurobridge.preprocessing import apply_preprocessing
from neurobridge.service import run_experiment
from neurobridge.simulation import simulate_linear_mixture, to_mne_raw
from neurobridge.simulation.engine import _one_over_f_background
from scipy import signal


def test_simulation_is_deterministic() -> None:
    spec = SimulationSpec(seed=17)
    first = simulate_linear_mixture(spec)
    second = simulate_linear_mixture(spec)
    np.testing.assert_array_equal(first.sensor_uv, second.sensor_uv)


def test_background_has_approximately_one_over_f_power() -> None:
    background = _one_over_f_background(
        np.random.default_rng(42), signal_count=8, sample_count=15000, sampling_rate_hz=250
    )
    frequency, power = signal.welch(background, fs=250, nperseg=2000, axis=-1)
    mean_power = power.mean(axis=0)
    fit = (frequency >= 1) & (frequency <= 45)
    slope = np.polyfit(np.log10(frequency[fit]), np.log10(mean_power[fit]), 1)[0]

    assert -1.2 < slope < -0.8


def test_alpha_source_has_a_time_varying_amplitude_envelope() -> None:
    simulation = simulate_linear_mixture(SimulationSpec(noise_uv=0))
    alpha = simulation.latent_uv[1]
    analytic_envelope = np.abs(signal.hilbert(alpha))
    window_size = 250
    window_means = [
        analytic_envelope[start : start + window_size].mean()
        for start in range(0, analytic_envelope.size - window_size + 1, window_size)
    ]

    assert max(window_means) / min(window_means) > 1.35


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


def test_result_exposes_raw_and_filtered_trace_for_every_sensor() -> None:
    result = run_experiment(ExperimentRecipe())

    assert set(result.traces.series) == {
        f"{state} · EEG {channel:02d}"
        for channel in range(1, 5)
        for state in ("Raw", "Filtered")
    }
    assert all(len(values) == len(result.traces.x) for values in result.traces.series.values())


def test_result_exposes_raw_and_filtered_spectrum_for_every_sensor() -> None:
    result = run_experiment(ExperimentRecipe())
    expected_channels = {f"EEG {channel:02d}" for channel in range(1, 5)}

    assert set(result.spectrum.raw_power_by_channel) == expected_channels
    assert set(result.spectrum.filtered_power_by_channel) == expected_channels
    assert all(
        len(values) == len(result.spectrum.frequency_hz)
        for values in (
            *result.spectrum.raw_power_by_channel.values(),
            *result.spectrum.filtered_power_by_channel.values(),
        )
    )
    assert not np.allclose(
        result.spectrum.raw_power_by_channel["EEG 01"],
        result.spectrum.raw_power_by_channel["EEG 02"],
    )
    assert not np.allclose(
        result.spectrum.filtered_power_by_channel["EEG 02"],
        result.spectrum.filtered_power_by_channel["EEG 03"],
    )


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
