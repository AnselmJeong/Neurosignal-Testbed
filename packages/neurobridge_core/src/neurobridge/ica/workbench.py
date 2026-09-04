"""Rank-aware ICA workbench for a deterministic planted-blink lesson."""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass

import mne
import numpy as np
import scipy
from mne.preprocessing import ICA
from numpy.typing import NDArray
from scipy import signal
from scipy.optimize import linear_sum_assignment

from neurobridge import __version__
from neurobridge.contracts.models import (
    IcaApplyRequest,
    IcaApplyResult,
    IcaCompatibility,
    IcaComponentSummary,
    IcaFitResult,
    IcaRecipe,
    IcaSimulationResult,
    Provenance,
    SeriesData,
    WarningMessage,
)

CHANNEL_NAMES = ("Fp1", "Fp2", "F7", "F8", "C3", "C4", "O1", "O2")
TRUTH_LABELS = ("alpha", "theta", "beta", "blink")


@dataclass(frozen=True)
class ArtifactSimulation:
    time_s: NDArray[np.float64]
    latent_uv: NDArray[np.float64]
    raw_sensor_uv: NDArray[np.float64]
    clean_target_uv: NDArray[np.float64]
    artifact_sensor_uv: NDArray[np.float64]
    mixing_matrix: NDArray[np.float64]


@dataclass(frozen=True)
class FittedIca:
    simulation: ArtifactSimulation
    target_raw: mne.io.RawArray
    fit_raw: mne.io.RawArray
    ica: ICA
    rank: int
    compatibility: IcaCompatibility
    component_sources: NDArray[np.float64]
    assignment: dict[int, tuple[int, float]]


def _average_reference(values: NDArray[np.float64]) -> NDArray[np.float64]:
    return values - values.mean(axis=0, keepdims=True)


def _blink_waveform(time_s: NDArray[np.float64], amplitude_uv: float) -> NDArray[np.float64]:
    waveform = np.zeros_like(time_s)
    for center in np.arange(1.5, time_s[-1], 2.6):
        width = 0.11 + 0.015 * np.sin(center)
        pulse = np.exp(-0.5 * ((time_s - center) / width) ** 2)
        undershoot = 0.22 * np.exp(-0.5 * ((time_s - center - 0.22) / (width * 1.8)) ** 2)
        waveform += amplitude_uv * (pulse - undershoot)
    return waveform


def simulate_artifact_recipe(recipe: IcaRecipe) -> ArtifactSimulation:
    """Create three neural sources plus a planted ocular source in display µV."""

    rng = np.random.default_rng(recipe.seed)
    count = int(round(recipe.duration_s * recipe.sampling_rate_hz))
    time_s = np.arange(count, dtype=float) / recipe.sampling_rate_hz
    alpha_envelope = 0.68 + 0.32 * np.sin(2 * np.pi * 0.21 * time_s) ** 2
    alpha = 14 * alpha_envelope * np.sin(2 * np.pi * 10 * time_s + 0.25)
    theta = 9 * np.sin(2 * np.pi * 6 * time_s - 0.6)
    beta_envelope = signal.windows.tukey(count, alpha=0.18)
    beta = 5.5 * beta_envelope * np.sin(2 * np.pi * 18 * time_s + 0.8)
    blink = _blink_waveform(time_s, recipe.blink_amplitude_uv)
    latent_uv = np.asarray([alpha, theta, beta, blink], dtype=float)

    mixing = np.asarray(
        [
            [0.12, 0.35, 0.32, 1.00],
            [0.10, 0.32, -0.30, 0.94],
            [0.20, 0.64, 0.82, 0.48],
            [0.18, 0.60, -0.78, 0.44],
            [0.46, 1.00, 0.18, 0.18],
            [0.44, 0.92, -0.16, 0.16],
            [1.00, 0.18, 0.08, 0.06],
            [0.94, 0.16, -0.08, 0.05],
        ],
        dtype=float,
    )
    mixing /= np.linalg.norm(mixing, axis=0, keepdims=True)
    neural_sensor = mixing[:, :3] @ latent_uv[:3]
    artifact_sensor = mixing[:, 3, None] * latent_uv[3]
    noise = rng.normal(0, recipe.sensor_noise_uv, size=neural_sensor.shape)
    clean_target = neural_sensor + noise
    raw_sensor = clean_target + artifact_sensor
    if recipe.reference == "average":
        clean_target = _average_reference(clean_target)
        artifact_sensor = _average_reference(artifact_sensor)
        raw_sensor = _average_reference(raw_sensor)
    return ArtifactSimulation(
        time_s=time_s,
        latent_uv=latent_uv,
        raw_sensor_uv=raw_sensor,
        clean_target_uv=clean_target,
        artifact_sensor_uv=artifact_sensor,
        mixing_matrix=mixing,
    )


def _raw_from_uv(values_uv: NDArray[np.float64], recipe: IcaRecipe) -> mne.io.RawArray:
    info = mne.create_info(list(CHANNEL_NAMES), recipe.sampling_rate_hz, ch_types="eeg")
    raw = mne.io.RawArray(values_uv * 1e-6, info, verbose=False)
    raw.set_montage("standard_1020", on_missing="raise", verbose=False)
    if recipe.reference == "average":
        raw.set_eeg_reference("average", projection=False, verbose=False)
    return raw


def _compatibility_fingerprint(recipe: IcaRecipe, rank: int) -> str:
    payload = {
        "channels": CHANNEL_NAMES,
        "bads": [],
        "reference": recipe.reference,
        "rank": rank,
        "fit_highpass_hz": recipe.fit_highpass_hz,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def _fit(recipe: IcaRecipe) -> FittedIca:
    simulation = simulate_artifact_recipe(recipe)
    target_raw = _raw_from_uv(simulation.raw_sensor_uv, recipe)
    fit_raw = target_raw.copy().filter(
        l_freq=recipe.fit_highpass_hz,
        h_freq=recipe.fit_lowpass_hz,
        method="iir",
        iir_params={"order": 4, "ftype": "butter"},
        verbose=False,
    )
    rank = int(mne.compute_rank(target_raw, rank=None, verbose=False)["eeg"])
    n_components = min(recipe.component_count, rank)
    fit_params = {"extended": True} if recipe.algorithm == "infomax" else None
    ica = ICA(
        n_components=n_components,
        method=recipe.algorithm,
        fit_params=fit_params,
        random_state=recipe.seed,
        max_iter="auto",
    )
    ica.fit(fit_raw, picks="eeg", verbose=False)
    component_sources = ica.get_sources(fit_raw).get_data()
    standardized_components = component_sources - component_sources.mean(axis=1, keepdims=True)
    standardized_components /= np.maximum(
        standardized_components.std(axis=1, keepdims=True), np.finfo(float).eps
    )
    truth_sos = signal.butter(
        4,
        [recipe.fit_highpass_hz, recipe.fit_lowpass_hz],
        btype="bandpass",
        fs=recipe.sampling_rate_hz,
        output="sos",
    )
    filtered_truth = signal.sosfiltfilt(truth_sos, simulation.latent_uv, axis=-1)
    standardized_truth = filtered_truth - filtered_truth.mean(axis=1, keepdims=True)
    standardized_truth /= np.maximum(
        standardized_truth.std(axis=1, keepdims=True), np.finfo(float).eps
    )
    correlations = np.abs(standardized_components @ standardized_truth.T / time_s_count(recipe))
    component_rows, truth_columns = linear_sum_assignment(-correlations)
    assignment = {
        int(component): (int(truth), float(correlations[component, truth]))
        for component, truth in zip(component_rows, truth_columns, strict=True)
    }
    compatibility = IcaCompatibility(
        fingerprint=_compatibility_fingerprint(recipe, rank),
        channel_names=list(CHANNEL_NAMES),
        bad_channels=[],
        reference=recipe.reference,
        rank=rank,
        fit_highpass_hz=recipe.fit_highpass_hz,
    )
    return FittedIca(
        simulation=simulation,
        target_raw=target_raw,
        fit_raw=fit_raw,
        ica=ica,
        rank=rank,
        compatibility=compatibility,
        component_sources=component_sources,
        assignment=assignment,
    )


def time_s_count(recipe: IcaRecipe) -> int:
    return int(round(recipe.duration_s * recipe.sampling_rate_hz))


def _label_components(
    fitted: FittedIca,
) -> tuple[list[str], list[float], bool, list[WarningMessage]]:
    warnings: list[WarningMessage] = []
    if fitted.ica.method != "infomax" or fitted.compatibility.reference != "average":
        warnings.append(
            WarningMessage(
                code="icalabel_prerequisites",
                severity="info",
                title="ICLabel suggestion withheld",
                explanation=(
                    "ICLabel is calibrated for extended Infomax on average-referenced EEG. "
                    "Manual component inspection remains available."
                ),
                suggestion="Use extended Infomax with average reference for an advisory label.",
            )
        )
        count = fitted.component_sources.shape[0]
        return ["not evaluated"] * count, [0.0] * count, True, warnings
    try:
        from mne_icalabel import label_components

        result = label_components(fitted.fit_raw, fitted.ica, method="iclabel")
        return (
            [str(label) for label in result["labels"]],
            [round(float(value), 4) for value in result["y_pred_proba"]],
            True,
            warnings,
        )
    except (ImportError, ModuleNotFoundError):
        count = fitted.component_sources.shape[0]
        warnings.append(
            WarningMessage(
                code="icalabel_unavailable",
                severity="info",
                title="ICLabel is not installed",
                explanation=(
                    "Automatic labels are optional; component removal still requires "
                    "manual selection."
                ),
                suggestion="Install the project's ica dependency group to enable advisory labels.",
            )
        )
        return ["unavailable"] * count, [0.0] * count, False, warnings


def _view_indices(length: int, maximum: int = 720) -> NDArray[np.int64]:
    if length <= maximum:
        return np.arange(length, dtype=int)
    return np.linspace(0, length - 1, maximum, dtype=int)


def simulate_ica_input(recipe: IcaRecipe) -> IcaSimulationResult:
    """Generate the contaminated sensor EEG without fitting a decomposition."""

    simulation = simulate_artifact_recipe(recipe)
    raw = _raw_from_uv(simulation.raw_sensor_uv, recipe)
    rank = int(mne.compute_rank(raw, rank=None, verbose=False)["eeg"])
    view = _view_indices(simulation.time_s.size)
    recipe_hash = hashlib.sha256(recipe.model_dump_json().encode()).hexdigest()[:12]
    return IcaSimulationResult(
        run_id=f"ica_input_{uuid.uuid4().hex[:10]}",
        state="completed",
        recipe=recipe,
        sensor_trace=SeriesData(
            x=np.round(simulation.time_s[view], 4).tolist(),
            series={
                CHANNEL_NAMES[index]: np.round(simulation.raw_sensor_uv[index, view], 4).tolist()
                for index in range(len(CHANNEL_NAMES))
            },
            x_unit="s",
            y_unit="µV",
        ),
        source_labels=list(TRUTH_LABELS),
        channel_names=list(CHANNEL_NAMES),
        rank=rank,
        provenance=Provenance(
            recipe_hash=recipe_hash,
            engine_version=__version__,
            numpy_version=np.__version__,
            scipy_version=scipy.__version__,
            seed=recipe.seed,
            sampling_rate_hz=recipe.sampling_rate_hz,
            reference=recipe.reference,
            rank=rank,
        ),
    )


def fit_ica_workbench(recipe: IcaRecipe) -> IcaFitResult:
    """Fit ICA and publish inspectable components without excluding any of them."""

    fitted = _fit(recipe)
    suggestions, probabilities, available, warnings = _label_components(fitted)
    view = _view_indices(fitted.simulation.time_s.size)
    topographies = fitted.ica.get_components()
    components: list[IcaComponentSummary] = []
    for index, source in enumerate(fitted.component_sources):
        frequency, power = signal.welch(
            source,
            fs=recipe.sampling_rate_hz,
            nperseg=min(source.size, recipe.sampling_rate_hz * 2),
        )
        truth_index, correlation = fitted.assignment.get(index, (index, 0.0))
        component_topography = topographies[:, index]
        component_topography /= max(np.max(np.abs(component_topography)), np.finfo(float).eps)
        variance_ratio = fitted.ica.get_explained_variance_ratio(
            fitted.fit_raw, components=[index]
        )["eeg"]
        components.append(
            IcaComponentSummary(
                index=index,
                suggested_label=suggestions[index],
                suggestion_probability=probabilities[index],
                explained_variance_pct=round(float(variance_ratio * 100), 2),
                matched_truth=TRUTH_LABELS[truth_index],
                matched_correlation=round(correlation, 4),
                time_s=np.round(fitted.simulation.time_s[view], 4).tolist(),
                trace=np.round(source[view], 5).tolist(),
                frequency_hz=np.round(frequency, 4).tolist(),
                power=np.round(power, 8).tolist(),
                topography=np.round(component_topography, 4).tolist(),
            )
        )
    blink_component = next(
        index for index, (truth, _) in fitted.assignment.items() if TRUTH_LABELS[truth] == "blink"
    )
    recipe_hash = hashlib.sha256(recipe.model_dump_json().encode()).hexdigest()[:12]
    raw_view = fitted.simulation.raw_sensor_uv[0, view]
    return IcaFitResult(
        run_id=f"ica_{uuid.uuid4().hex[:10]}",
        state="completed",
        recipe=recipe,
        warnings=warnings,
        raw_trace=SeriesData(
            x=np.round(fitted.simulation.time_s[view], 4).tolist(),
            series={"Contaminated · Fp1": np.round(raw_view, 4).tolist()},
            x_unit="s",
            y_unit="µV",
        ),
        components=components,
        compatibility=fitted.compatibility,
        blink_component_index=blink_component,
        mean_matched_correlation=round(
            float(np.mean([correlation for _, correlation in fitted.assignment.values()])), 4
        ),
        icalabel_available=available,
        provenance=Provenance(
            recipe_hash=recipe_hash,
            engine_version=__version__,
            numpy_version=np.__version__,
            scipy_version=scipy.__version__,
            seed=recipe.seed,
            sampling_rate_hz=recipe.sampling_rate_hz,
            reference=recipe.reference,
            rank=fitted.rank,
        ),
    )


def _template_power(values: NDArray[np.float64], template: NDArray[np.float64]) -> float:
    centered = template - template.mean()
    denominator = float(centered @ centered)
    coefficients = values @ centered / max(denominator, np.finfo(float).eps)
    reconstruction = coefficients[:, None] * centered
    return float(np.mean(reconstruction**2))


def apply_ica_exclusions(request: IcaApplyRequest) -> IcaApplyResult:
    """Recompute the pinned decomposition, validate compatibility, and apply manual exclusions."""

    fitted = _fit(request.recipe)
    expected = fitted.compatibility
    compatible = (
        request.compatibility_fingerprint == expected.fingerprint
        and request.target_reference == expected.reference
        and request.target_channel_names == expected.channel_names
    )
    if not compatible:
        raise ValueError(
            "ICA target is incompatible: channel order, reference, rank, or fit provenance changed."
        )
    component_count = fitted.component_sources.shape[0]
    exclusions = sorted(set(request.excluded_components))
    if any(index < 0 or index >= component_count for index in exclusions):
        raise ValueError("Excluded component index is outside the fitted decomposition")
    cleaned_raw = fitted.target_raw.copy()
    fitted.ica.apply(cleaned_raw, exclude=exclusions, verbose=False)
    cleaned_uv = cleaned_raw.get_data() * 1e6
    neural_control_raw = _raw_from_uv(fitted.simulation.clean_target_uv, request.recipe)
    cleaned_neural_control = neural_control_raw.copy()
    fitted.ica.apply(cleaned_neural_control, exclude=exclusions, verbose=False)
    cleaned_neural_control_uv = cleaned_neural_control.get_data() * 1e6
    blink_template = fitted.simulation.latent_uv[3]
    before_power = _template_power(fitted.simulation.raw_sensor_uv, blink_template)
    after_power = _template_power(cleaned_uv, blink_template)
    attenuation = 10 * np.log10(max(before_power, np.finfo(float).eps) / max(after_power, 1e-12))
    neural_rms = np.sqrt(np.mean(fitted.simulation.clean_target_uv**2))
    distortion = np.sqrt(
        np.mean((cleaned_neural_control_uv - fitted.simulation.clean_target_uv) ** 2)
    )
    distortion_pct = float(distortion / max(neural_rms, np.finfo(float).eps) * 100)
    view = _view_indices(fitted.simulation.time_s.size)
    warnings: list[WarningMessage] = []
    if not exclusions:
        warnings.append(
            WarningMessage(
                code="no_components_excluded",
                severity="info",
                title="No component was removed",
                explanation=(
                    "The output is unchanged because ICA suggestions never auto-delete data."
                ),
                suggestion="Inspect a component and select it explicitly before applying.",
            )
        )
    return IcaApplyResult(
        run_id=f"clean_{uuid.uuid4().hex[:10]}",
        state="completed",
        excluded_components=exclusions,
        before_after_trace=SeriesData(
            x=np.round(fitted.simulation.time_s[view], 4).tolist(),
            series={
                label: values
                for index, channel_name in enumerate(CHANNEL_NAMES)
                for label, values in (
                    (
                        f"Before · {channel_name}",
                        np.round(fitted.simulation.raw_sensor_uv[index, view], 4).tolist(),
                    ),
                    (
                        f"After · {channel_name}",
                        np.round(cleaned_uv[index, view], 4).tolist(),
                    ),
                )
            },
            x_unit="s",
            y_unit="µV",
        ),
        artifact_attenuation_db=round(float(attenuation), 2),
        neural_distortion_pct=round(distortion_pct, 2),
        neural_retention_pct=round(max(0.0, 100 - distortion_pct), 2),
        compatibility_verified=True,
        warnings=warnings,
    )
