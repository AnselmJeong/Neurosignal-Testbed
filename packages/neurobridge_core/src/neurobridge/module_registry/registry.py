from neurobridge import __version__
from neurobridge.contracts.models import AnalysisModuleManifest, CapabilityManifest


def capability_manifest() -> CapabilityManifest:
    return CapabilityManifest(
        api_version="1.0",
        engine_version=__version__,
        modules=[
            AnalysisModuleManifest(
                id="simulation.level_a",
                version="1.0.0",
                label="Linear source mixture",
                status="available",
                input_kinds=["SimulationSpec"],
                output_kinds=["traces", "mixing_matrix", "truth"],
            ),
            AnalysisModuleManifest(
                id="preprocessing.filter",
                version="1.0.0",
                label="Reference and filter",
                status="available",
                input_kinds=["sensor_array"],
                output_kinds=["traces", "spectrum", "filter_response"],
            ),
            AnalysisModuleManifest(
                id="preprocessing.ica",
                version="1.0.0",
                label="Rank-aware ICA artifact recovery",
                status="available",
                input_kinds=["continuous_eeg", "artifact_truth"],
                output_kinds=["ica_components", "topographies", "cleaned_trace", "truth_scores"],
                prerequisites=["mne", "mne-icalabel (optional advisory labels)"],
            ),
            AnalysisModuleManifest(
                id="connectivity.sensor",
                version="0.1.0",
                label="Sensor connectivity",
                status="planned",
                input_kinds=["epochs"],
                output_kinds=["connectivity_matrix", "network"],
                prerequisites=["mne-connectivity"],
            ),
        ],
        datasets=["deterministic-simulation"],
        renderer_support=[
            "traces",
            "spectrum",
            "filter_response",
            "matrix",
            "ica_components",
            "topographies",
        ],
    )
