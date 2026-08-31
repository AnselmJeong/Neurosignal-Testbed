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
