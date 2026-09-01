from neurobridge.contracts.models import SourceModelRecipe
from neurobridge.source_modeling import run_source_model_benchmark


def test_template_roi_forward_inverse_benchmark_recovers_planted_vertices() -> None:
    result = run_source_model_benchmark(SourceModelRecipe())

    assert result.scores.benchmark_passed
    assert result.scores.mean_roi_correlation > 0.8
    assert result.scores.max_location_error_mm == 0
    assert result.scores.max_roi_cross_talk > 0
    assert result.sensor_trace.y_unit == "µV"
    assert result.reconstructed_roi_time_courses.y_unit == "nAm"


def test_source_noise_changes_sensor_data_without_mutating_template_contract() -> None:
    clean = run_source_model_benchmark(SourceModelRecipe(sensor_noise_uv=0))
    noisy = run_source_model_benchmark(SourceModelRecipe(sensor_noise_uv=0.8))

    assert clean.rois == noisy.rois
    assert clean.forward_method == noisy.forward_method
    assert clean.sensor_trace.series["Fp1"] != noisy.sensor_trace.series["Fp1"]
