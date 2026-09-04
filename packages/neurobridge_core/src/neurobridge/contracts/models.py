"""Versioned API-neutral data contracts for the first vertical slice."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceSpec(ContractModel):
    id: str
    label: str
    frequency_hz: float = Field(gt=0, le=120)
    amplitude_uv: float = Field(gt=0, le=250)
    phase_deg: float = Field(default=0, ge=-360, le=360)
    kind: Literal["sine", "blink"] = "sine"


class SimulationSpec(ContractModel):
    schema_version: Literal["1.0"] = "1.0"
    seed: int = Field(default=42, ge=0, le=2**31 - 1)
    duration_s: float = Field(default=8.0, ge=2.0, le=60.0)
    sampling_rate_hz: int = Field(default=250, ge=80, le=1000)
    channel_count: int = Field(default=4, ge=3, le=16)
    noise_uv: float = Field(default=4.0, ge=0, le=100)
    sources: list[SourceSpec] = Field(
        default_factory=lambda: [
            SourceSpec(id="delta", label="Slow drift", frequency_hz=2, amplitude_uv=8),
            SourceSpec(id="alpha", label="Alpha rhythm", frequency_hz=10, amplitude_uv=24),
            SourceSpec(id="line", label="Line noise", frequency_hz=60, amplitude_uv=12),
        ]
    )

    @model_validator(mode="after")
    def unique_sources(self) -> SimulationSpec:
        ids = [source.id for source in self.sources]
        if len(ids) != len(set(ids)):
            raise ValueError("source IDs must be unique")
        return self


class PreprocessingSpec(ContractModel):
    highpass_hz: float | None = Field(default=1.0, gt=0, le=100)
    lowpass_hz: float | None = Field(default=40.0, gt=0, le=200)
    notch_hz: float | None = Field(default=60.0, gt=0, le=200)
    filter_order: int = Field(default=4, ge=2, le=10)
    reference: Literal["average", "none"] = "average"

    @model_validator(mode="after")
    def ordered_passband(self) -> PreprocessingSpec:
        if (
            self.highpass_hz is not None
            and self.lowpass_hz is not None
            and self.highpass_hz >= self.lowpass_hz
        ):
            raise ValueError("high-pass frequency must be lower than low-pass frequency")
        return self


class ExperimentRecipe(ContractModel):
    recipe_version: Literal["1.0"] = "1.0"
    title: str = Field(default="Sampling & filtering · first run", min_length=1, max_length=120)
    simulation: SimulationSpec = Field(default_factory=SimulationSpec)
    preprocessing: PreprocessingSpec = Field(default_factory=PreprocessingSpec)


class WarningMessage(ContractModel):
    code: str
    severity: Literal["info", "warning", "error"]
    title: str
    explanation: str
    suggestion: str | None = None


class SeriesData(ContractModel):
    x: list[float]
    series: dict[str, list[float]]
    x_unit: str
    y_unit: str


class SpectrumData(ContractModel):
    frequency_hz: list[float]
    raw_power: list[float]
    filtered_power: list[float]
    raw_power_by_channel: dict[str, list[float]]
    filtered_power_by_channel: dict[str, list[float]]
    unit: str


class FilterResponseData(ContractModel):
    frequency_hz: list[float]
    gain_db: list[float]


class Provenance(ContractModel):
    recipe_hash: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    engine_version: str
    numpy_version: str
    scipy_version: str
    seed: int
    sampling_rate_hz: int
    units: str = "µV display / V analysis"
    reference: str
    rank: int


class ExperimentResult(ContractModel):
    run_id: str
    state: Literal["completed", "partial", "failed"]
    recipe: ExperimentRecipe
    warnings: list[WarningMessage]
    traces: SeriesData
    spectrum: SpectrumData
    filter_response: FilterResponseData
    mixing_matrix: list[list[float]]
    peak_frequencies_hz: list[float]
    truth_peaks_hz: list[float]
    retained_variance_pct: float
    provenance: Provenance


class AnalysisModuleManifest(ContractModel):
    id: str
    version: str
    label: str
    status: Literal["available", "planned", "unavailable"]
    input_kinds: list[str]
    output_kinds: list[str]
    prerequisites: list[str] = Field(default_factory=list)


class CapabilityManifest(ContractModel):
    api_version: str
    engine_version: str
    modules: list[AnalysisModuleManifest]
    datasets: list[str]
    renderer_support: list[str]


class IcaRecipe(ContractModel):
    recipe_version: Literal["1.0"] = "1.0"
    title: str = Field(default="ICA artifact recovery · planted blink", min_length=1)
    seed: int = Field(default=97, ge=0, le=2**31 - 1)
    duration_s: float = Field(default=12.0, ge=8.0, le=60.0)
    sampling_rate_hz: int = Field(default=250, ge=160, le=1000)
    blink_amplitude_uv: float = Field(default=90.0, ge=0, le=300)
    sensor_noise_uv: float = Field(default=0.25, ge=0, le=50)
    reference: Literal["average", "none"] = "average"
    fit_highpass_hz: float = Field(default=1.0, ge=1.0, le=4.0)
    fit_lowpass_hz: float = Field(default=100.0, ge=30.0, le=120.0)
    algorithm: Literal["fastica", "infomax"] = "infomax"
    component_count: int = Field(default=4, ge=3, le=7)

    @model_validator(mode="after")
    def valid_ica_band(self) -> IcaRecipe:
        if self.fit_highpass_hz >= self.fit_lowpass_hz:
            raise ValueError("ICA fit high-pass must be lower than the low-pass")
        if self.fit_lowpass_hz >= self.sampling_rate_hz / 2:
            raise ValueError("ICA fit low-pass must be below Nyquist")
        return self


class IcaComponentSummary(ContractModel):
    index: int
    suggested_label: str
    suggestion_probability: float
    explained_variance_pct: float
    matched_truth: str
    matched_correlation: float
    time_s: list[float]
    trace: list[float]
    frequency_hz: list[float]
    power: list[float]
    topography: list[float]


class IcaCompatibility(ContractModel):
    fingerprint: str
    channel_names: list[str]
    bad_channels: list[str]
    reference: str
    rank: int
    fit_highpass_hz: float


class IcaSimulationResult(ContractModel):
    run_id: str
    state: Literal["completed", "failed"]
    recipe: IcaRecipe
    sensor_trace: SeriesData
    source_labels: list[str]
    channel_names: list[str]
    rank: int
    provenance: Provenance


class IcaFitResult(ContractModel):
    run_id: str
    state: Literal["completed", "failed"]
    recipe: IcaRecipe
    warnings: list[WarningMessage]
    raw_trace: SeriesData
    components: list[IcaComponentSummary]
    compatibility: IcaCompatibility
    blink_component_index: int
    mean_matched_correlation: float
    icalabel_available: bool
    provenance: Provenance


class IcaApplyRequest(ContractModel):
    recipe: IcaRecipe
    excluded_components: list[int] = Field(default_factory=list)
    compatibility_fingerprint: str
    target_reference: Literal["average", "none"]
    target_channel_names: list[str]


class IcaApplyResult(ContractModel):
    run_id: str
    state: Literal["completed", "failed"]
    excluded_components: list[int]
    before_after_trace: SeriesData
    artifact_attenuation_db: float
    neural_distortion_pct: float
    neural_retention_pct: float
    compatibility_verified: bool
    warnings: list[WarningMessage]


class ConnectivityRecipe(ContractModel):
    recipe_version: Literal["1.0"] = "1.0"
    title: str = Field(default="Connectivity truth challenge · alpha network", min_length=1)
    seed: int = Field(default=314, ge=0, le=2**31 - 1)
    sampling_rate_hz: int = Field(default=200, ge=100, le=1000)
    epoch_count: int = Field(default=24, ge=8, le=80)
    epoch_duration_s: float = Field(default=2.0, ge=1.0, le=8.0)
    alpha_frequency_hz: float = Field(default=10.0, ge=5.0, le=30.0)
    phase_lag_deg: float = Field(default=60.0, ge=0, le=180)
    coupling_strength: float = Field(default=0.78, ge=0, le=1)
    noise_sd: float = Field(default=0.55, ge=0.05, le=3)
    volume_conduction: float = Field(default=0.72, ge=0, le=1)
    reference: Literal["average", "none"] = "average"
    analysis_space: Literal["sensor", "latent"] = "sensor"
    metric: Literal["pearson", "coh", "imcoh", "plv", "ppc", "pli", "wpli"] = "coh"
    spectral_mode: Literal["multitaper", "fourier"] = "multitaper"
    band_low_hz: float = Field(default=8.0, ge=1.0, le=80)
    band_high_hz: float = Field(default=12.0, ge=2.0, le=100)
    surrogate_count: int = Field(default=48, ge=20, le=200)

    @model_validator(mode="after")
    def valid_connectivity_recipe(self) -> ConnectivityRecipe:
        nyquist = self.sampling_rate_hz / 2
        if self.band_low_hz >= self.band_high_hz:
            raise ValueError("connectivity band low edge must be below its high edge")
        if self.band_high_hz >= nyquist:
            raise ValueError("connectivity band must stay below Nyquist")
        if not self.band_low_hz <= self.alpha_frequency_hz <= self.band_high_hz:
            raise ValueError("planted alpha frequency must fall inside the analysis band")
        return self


class SpectralParameterization(ContractModel):
    backend: Literal["specparam"]
    fit_low_hz: float
    fit_high_hz: float
    offset: float
    exponent: float
    peak_frequency_hz: float | None
    peak_power: float | None
    peak_bandwidth_hz: float | None
    r_squared: float
    mean_absolute_error: float
    aperiodic_power: list[float]
    modeled_power: list[float]


class SpectrumComparison(ContractModel):
    frequency_hz: list[float]
    welch_power: list[float]
    multitaper_power: list[float]
    unit: str = "power/Hz"
    frequency_resolution_hz: float
    parameterization: SpectralParameterization


class ConnectivityMatrix(ContractModel):
    node_names: list[str]
    values: list[list[float]]
    space: Literal["sensor", "latent", "truth"]
    metric: str
    band_hz: tuple[float, float]


class ConnectivityEdge(ContractModel):
    source: str
    target: str
    weight: float
    detected: bool
    is_true: bool | None


class ConnectivityScores(ContractModel):
    threshold: float
    true_positive: int
    false_positive: int
    false_negative: int
    precision: float
    recall: float
    strongest_edge_correct: bool
    weighted_truth_correlation: float


class ConnectivityResult(ContractModel):
    run_id: str
    state: Literal["completed", "failed"]
    recipe: ConnectivityRecipe
    warnings: list[WarningMessage]
    spectrum: SpectrumComparison
    latent: ConnectivityMatrix
    sensor: ConnectivityMatrix
    selected: ConnectivityMatrix
    truth: ConnectivityMatrix
    latent_edges: list[ConnectivityEdge]
    sensor_edges: list[ConnectivityEdge]
    thresholded_edges: list[ConnectivityEdge]
    surrogate_values: list[float]
    latent_surrogate_values: list[float]
    sensor_surrogate_values: list[float]
    selected_threshold: float
    latent_threshold: float
    sensor_threshold: float
    surrogate_percentile: float = 95.0
    scores: ConnectivityScores
    mixing_matrix: list[list[float]]
    sensor_positions: list[tuple[float, float]]
    estimator_backend: Literal["mne-connectivity", "numpy"]
    estimator_family: Literal["functional", "lag-sensitive"]
    n_epochs_used: int
    provenance: Provenance


class SourceModelRecipe(ContractModel):
    """Constrained educational source-modeling recipe.

    This intentionally describes a small spherical template, rather than an
    individual's anatomy.  It keeps the forward/inverse lesson reproducible
    without claiming an anatomical localization result.
    """

    recipe_version: Literal["1.0"] = "1.0"
    title: str = Field(default="Source modeling · template ROI benchmark", min_length=1)
    seed: int = Field(default=2718, ge=0, le=2**31 - 1)
    sampling_rate_hz: int = Field(default=100, ge=80, le=250)
    duration_s: float = Field(default=4.0, ge=2.0, le=10.0)
    alpha_frequency_hz: float = Field(default=10.0, ge=5.0, le=50.0)
    phase_lag_deg: float = Field(default=55.0, ge=0, le=180)
    source_amplitude_nam: float = Field(default=20.0, ge=2.0, le=80.0)
    sensor_noise_uv: float = Field(default=0.08, ge=0, le=5.0)
    inverse_method: Literal["MNE"] = "MNE"
    montage: Literal["standard_1020_14"] = "standard_1020_14"

    @model_validator(mode="after")
    def valid_source_model_recipe(self) -> SourceModelRecipe:
        if self.alpha_frequency_hz >= self.sampling_rate_hz / 2:
            raise ValueError("planted alpha frequency must stay below Nyquist")
        return self


class SourceRoi(ContractModel):
    id: str
    label: str
    position_mm: tuple[float, float, float]


class SourceTopography(ContractModel):
    roi_id: str
    label: str
    values: list[float]


class SourceReconstructionScores(ContractModel):
    mean_roi_correlation: float
    roi_correlations: dict[str, float]
    mean_location_error_mm: float
    max_location_error_mm: float
    location_error_mm: dict[str, float]
    max_roi_cross_talk: float
    leakage_matrix: list[list[float]]
    benchmark_passed: bool


class SourceModelResult(ContractModel):
    run_id: str
    state: Literal["completed", "failed"]
    recipe: SourceModelRecipe
    warnings: list[WarningMessage]
    template_description: str
    forward_method: str
    inverse_method: str
    rois: list[SourceRoi]
    sensor_trace: SeriesData
    latent_roi_time_courses: SeriesData
    reconstructed_roi_time_courses: SeriesData
    sensor_topographies: list[SourceTopography]
    sensor_positions: list[tuple[float, float]]
    scores: SourceReconstructionScores
    provenance: Provenance


class LocalImportRequest(ContractModel):
    """A path selected by the local user; the service copies but never overwrites it."""

    source_path: str = Field(min_length=1)
    project_name: str = Field(default="Imported EEG recording", min_length=1, max_length=120)


class RecordingInspection(ContractModel):
    source_name: str
    format: Literal["fif", "edf", "bdf", "brainvision", "eeglab"]
    source_sha256: str
    channel_count: int
    eeg_channel_count: int
    channel_names: list[str]
    channel_types: dict[str, int]
    sampling_rate_hz: float
    duration_s: float
    highpass_hz: float | None
    lowpass_hz: float | None
    annotation_count: int
    digitization_point_count: int
    montage_present: bool
    warnings: list[WarningMessage]


class RealDataQcSummary(ContractModel):
    channel_count: int
    eeg_channel_count: int
    duration_s: float
    sampling_rate_hz: float
    bad_channels: list[str]
    flat_channels: list[str]
    annotation_count: int
    alpha_relative_power: float | None
    warnings: list[WarningMessage]


class RealDataProject(ContractModel):
    project_id: str
    schema_version: int
    migration_status: Literal["current", "migrated", "recovered"]
    project_name: str
    source_name: str
    source_format: Literal["fif", "edf", "bdf", "brainvision", "eeglab"]
    working_copy_name: str
    imported_at: datetime


class RealDataImportResult(ContractModel):
    project: RealDataProject
    inspection: RecordingInspection
    qc: RealDataQcSummary
    report_available: bool


class EegbciLessonStatus(ContractModel):
    state: Literal["cached", "not_cached"]
    cache_directory: str
    available_runs: list[int]
    message: str


class EegbciImportRequest(ContractModel):
    run: Literal[1, 2]
    project_name: str = Field(default="EEGBCI offline lesson", min_length=1, max_length=120)


class ReportExportResult(ContractModel):
    project_id: str
    report_name: str
    download_path: str
    generated_at: datetime


class RealDataQeegRequest(ContractModel):
    """Reproducible preprocessing and sensor-level QEEG settings for one imported project."""

    schema_version: Literal["1.0"] = "1.0"
    highpass_hz: float = Field(default=1.0, gt=0, le=40)
    lowpass_hz: float = Field(default=40.0, gt=1, le=120)
    notch_hz: float | None = Field(default=None, gt=0, le=120)
    reference: Literal["average", "none"] = "average"
    duration_limit_s: float = Field(default=120.0, ge=8, le=600)
    epoch_duration_s: float = Field(default=2.0, ge=1, le=10)
    reject_by_annotation: bool = True
    ica_enabled: bool = False
    ica_method: Literal["fastica", "infomax"] = "fastica"
    ica_component_count: int = Field(default=12, ge=2, le=64)
    ica_exclude_components: list[int] = Field(default_factory=list, max_length=32)
    connectivity_band: Literal["theta", "alpha", "beta"] = "alpha"
    max_connectivity_channels: int = Field(default=12, ge=2, le=24)

    @model_validator(mode="after")
    def valid_qeeg_request(self) -> RealDataQeegRequest:
        if self.highpass_hz >= self.lowpass_hz:
            raise ValueError("QEEG high-pass frequency must be lower than low-pass frequency")
        if len(self.ica_exclude_components) != len(set(self.ica_exclude_components)):
            raise ValueError("ICA exclusion indices must be unique")
        if any(index < 0 for index in self.ica_exclude_components):
            raise ValueError("ICA exclusion indices cannot be negative")
        if self.ica_exclude_components and not self.ica_enabled:
            raise ValueError("Enable ICA before excluding ICA components")
        return self


class QeegBandPower(ContractModel):
    name: Literal["delta", "theta", "alpha", "beta", "gamma"]
    low_hz: float
    high_hz: float
    mean_absolute_power_uv2: float
    mean_relative_power: float
    absolute_power_by_channel_uv2: list[float]
    relative_power_by_channel: list[float]


class QeegTopomap(ContractModel):
    band: Literal["delta", "theta", "alpha", "beta", "gamma"]
    channel_names: list[str]
    relative_power: list[float]
    sensor_positions: list[tuple[float, float]]
    available: bool


class QeegConnectivityMatrix(ContractModel):
    method: Literal["coh", "plv"]
    band: Literal["theta", "alpha", "beta"]
    band_hz: tuple[float, float]
    channel_names: list[str]
    values: list[list[float]]
    epoch_count: int


class QeegIcaComponent(ContractModel):
    index: int
    explained_variance_pct: float
    topography: list[float]
    peak_frequency_hz: float | None


class QeegProvenance(ContractModel):
    created_at: datetime
    mne_version: str
    mne_connectivity_version: str
    source_working_copy: str
    source_sha256: str
    analyzed_duration_s: float
    recipe_hash: str


class RealDataQeegResult(ContractModel):
    run_id: str
    state: Literal["completed", "partial"]
    request: RealDataQeegRequest
    channel_names: list[str]
    sampling_rate_hz: float
    analyzed_duration_s: float
    trace: SeriesData
    frequency_hz: list[float]
    mean_psd_uv2_hz: list[float]
    psd_by_channel_uv2_hz: dict[str, list[float]]
    band_powers: list[QeegBandPower]
    theta_beta_ratio_by_channel: dict[str, float | None]
    mean_theta_beta_ratio: float | None
    topomaps: list[QeegTopomap]
    coherence: QeegConnectivityMatrix
    plv: QeegConnectivityMatrix
    ica_components: list[QeegIcaComponent]
    ica_excluded_components: list[int]
    cleaned_fif_path: str
    result_json_path: str
    warnings: list[WarningMessage]
    provenance: QeegProvenance
