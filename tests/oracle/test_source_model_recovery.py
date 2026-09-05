import copy

import numpy as np
import pytest
from neurobridge.contracts.models import SourceInverseSettings, SourceModelRecipe, SourceRoi
from neurobridge.source_modeling import engine, run_source_model_benchmark, simulate_source_model
from neurobridge.source_modeling.localization import (
    detect_peaks,
    evaluate_localization,
    infer_sources,
    power_maps_from_currents,
)


def test_default_localization_reports_actual_displacement() -> None:
    result = run_source_model_benchmark(SourceModelRecipe())
    assert len(result.candidate_positions_mm) == 250
    assert len(result.candidate_time_courses.series) == 250
    assert len(result.sensor_topographies) == 250
    assert result.evaluation.mean_error_mm is not None
    assert result.evaluation.mean_error_mm > 0
    assert "estimated_positions_mm" not in result.model_dump()
    assert "benchmark_passed" not in result.scores.model_dump()
    assert all(len(b.power_nam2) == 250 for b in result.power_maps)
    assert result.evaluation.matched_count + result.evaluation.missed_count == 4
    assert result.sensor_trace.y_unit == "µV"
    assert result.candidate_time_courses.y_unit == "nAm"
    # Displayed forward maps use the same average reference as the EEG.
    assert all(abs(sum(t.values)) < 0.002 for t in result.sensor_topographies)


def test_inverse_settings_reuse_the_identical_sensor_input() -> None:
    recipe = SourceModelRecipe(grid_spacing_mm=40)
    simulation = simulate_source_model(recipe)
    recipe.inverse = SourceInverseSettings(lambda2=1, peak_threshold=0.8)
    result = run_source_model_benchmark(recipe)
    assert simulation.sensor_trace == result.sensor_trace
    assert simulation.rois == result.rois
    assert len(result.candidate_positions_mm) == 26


def test_truth_metadata_cannot_change_inference(monkeypatch) -> None:
    recipe = SourceModelRecipe(grid_spacing_mm=40)
    baseline = run_source_model_benchmark(recipe)
    original_rois = engine._source_rois

    def displaced_truth(*args):
        return [
            roi.model_copy(update={"position_mm": (900.0, 900.0, 900.0)})
            for roi in original_rois(*args)
        ]

    monkeypatch.setattr(engine, "_source_rois", displaced_truth)
    changed = run_source_model_benchmark(recipe)
    assert changed.power_maps == baseline.power_maps
    assert changed.candidate_time_courses == baseline.candidate_time_courses
    assert changed.evaluation.matched_count == 0
    assert changed.evaluation.missed_count == 4
    assert changed.evaluation.mean_error_mm is None
    assert changed.evaluation.max_error_mm is None


def test_latent_waveforms_do_not_select_peaks(monkeypatch) -> None:
    recipe = SourceModelRecipe(grid_spacing_mm=40)
    baseline = run_source_model_benchmark(recipe)
    original_simulation = engine._forward_simulation

    def corrupt_answer(recipe):
        payload = list(original_simulation(recipe))
        payload[6] = np.random.default_rng(77).normal(size=payload[6].shape)
        return tuple(payload)

    monkeypatch.setattr(engine, "_forward_simulation", corrupt_answer)
    changed = run_source_model_benchmark(recipe)
    assert changed.sensor_trace == baseline.sensor_trace
    assert changed.power_maps == baseline.power_maps
    assert changed.evaluation == baseline.evaluation
    assert changed.scores.roi_correlations != baseline.scores.roi_correlations


def test_zero_eeg_produces_no_forced_peaks_and_does_not_mutate_input() -> None:
    payload = engine._forward_simulation(SourceModelRecipe(grid_spacing_mm=40))
    raw = payload[-1].copy()
    raw.apply_function(lambda values: np.zeros_like(values), verbose=False)
    before = raw.get_data().copy()
    currents, _, maps = infer_sources(raw, payload[2], SourceInverseSettings())
    np.testing.assert_array_equal(raw.get_data(), before)
    assert not currents.any()
    assert all(not band.peaks and not any(band.power_nam2) for band in maps)


@pytest.mark.parametrize("peak_count", [1, 2, 3, 5])
def test_detector_has_no_assumed_number_of_sources(peak_count) -> None:
    positions = np.asarray([(i * 20.0, 0, 0) for i in range(peak_count * 3 + 2)])
    power = np.zeros(len(positions))
    expected = list(range(1, peak_count * 3, 3))
    power[expected] = 1
    assert detect_peaks(power, positions, SourceInverseSettings()) == expected


def test_flat_plateaus_and_distance_suppression() -> None:
    positions = np.asarray([(i * 20.0, 0, 0) for i in range(7)])
    assert detect_peaks(np.ones(7), positions, SourceInverseSettings()) == []
    assert detect_peaks(np.zeros(7), positions, SourceInverseSettings()) == []
    assert detect_peaks(np.array([0, 1, 1, 0, 0.8, 0, 0]), positions, SourceInverseSettings()) == [
        1,
        4,
    ]
    assert detect_peaks(
        np.array([0, 1, 0, 0.8, 0, 0, 0]),
        positions,
        SourceInverseSettings(peak_separation_mm=60),
    ) == [1]


def test_power_units_and_analysis_bands_do_not_use_truth_frequencies() -> None:
    time = np.arange(400) / 100
    positions = np.asarray([(i * 20.0, 0, 0) for i in range(5)])
    currents = np.zeros((5, 400))
    currents[2] = 10e-9 * np.sin(2 * np.pi * 10 * time)
    maps = power_maps_from_currents(currents, 100, positions, SourceInverseSettings())
    alpha = next(b for b in maps if b.id == "alpha")
    assert alpha.power_nam2[2] == pytest.approx(50, rel=0.001)
    assert [p.vertex_index for p in alpha.peaks] == [2]
    assert all(not b.peaks for b in maps if b.id in {"theta", "beta"})


def test_matching_is_one_to_one_gated_and_never_changes_peaks() -> None:
    positions = np.asarray([(i * 20.0, 0, 0) for i in range(8)])
    currents = np.zeros((8, 400))
    time = np.arange(400) / 100
    currents[1] = 10e-9 * np.sin(2 * np.pi * 10 * time)
    currents[6] = currents[1]
    maps = power_maps_from_currents(currents, 100, positions, SourceInverseSettings())
    truth = [
        SourceRoi(
            id=str(i),
            label=str(i),
            position_mm=(x, 0, 0),
            frequency_hz=10,
            amplitude_nam=10,
            phase_deg=0,
        )
        for i, x in enumerate([20, 30, 500])
    ]
    before = copy.deepcopy(maps)
    evaluation = evaluate_localization(maps, truth, match_radius_mm=40)
    assert maps == before
    assert evaluation.matched_count == 1
    assert evaluation.missed_count == 2
    assert evaluation.unmatched_peak_count >= 1
    alpha = next(b for b in evaluation.bands if b.band_id == "alpha")
    assert len({m.peak_id for m in alpha.matches}) == len(alpha.matches)


def test_harder_detection_can_miss_a_source() -> None:
    result = run_source_model_benchmark(
        SourceModelRecipe(
            phase_lag_deg=0,
            inverse=SourceInverseSettings(peak_threshold=0.9),
        )
    )
    assert result.evaluation.missed_count > 0
    assert len(next(b for b in result.power_maps if b.id == "alpha").peaks) < 2


def test_noise_changes_estimated_power_without_moving_truth() -> None:
    clean = run_source_model_benchmark(SourceModelRecipe(sensor_noise_uv=0))
    noisy = run_source_model_benchmark(SourceModelRecipe(sensor_noise_uv=5))
    assert clean.rois == noisy.rois
    assert clean.power_maps != noisy.power_maps
    assert clean.sensor_trace != noisy.sensor_trace
    assert noisy.evaluation.unmatched_peak_count > clean.evaluation.unmatched_peak_count


def test_sources_outside_analysis_bands_are_explicitly_unscored() -> None:
    roi = SourceRoi(
        id="outside",
        label="Outside",
        position_mm=(0, 0, 0),
        frequency_hz=35,
        amplitude_nam=10,
        phase_deg=0,
    )
    score = evaluate_localization([], [roi])
    assert score.outside_band_roi_ids == ["outside"]
    assert score.mean_error_mm is None
