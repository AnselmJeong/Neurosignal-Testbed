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
from neurobridge.display import round_significant, view_indices

CHANNEL_NAMES = ("Fp1", "Fp2", "F7", "F8", "C3", "C4", "O1", "O2")
TRUTH_LABELS = ("alpha", "theta", "beta", "blink")
NEURAL_LABELS = ("alpha", "theta", "beta")

# 19-channel 10–20 variant with several artifact types (P1-4). Positions are a flat head map:
# x from left (-1) to right (+1), y from back (-1) to nose (+1).
MULTI_CHANNEL_POSITIONS: dict[str, tuple[float, float]] = {
    "Fp1": (-0.3, 0.95),
    "Fp2": (0.3, 0.95),
    "F7": (-0.8, 0.6),
    "F3": (-0.4, 0.5),
    "Fz": (0.0, 0.5),
    "F4": (0.4, 0.5),
    "F8": (0.8, 0.6),
    "T7": (-1.0, 0.0),
    "C3": (-0.5, 0.0),
    "Cz": (0.0, 0.0),
    "C4": (0.5, 0.0),
    "T8": (1.0, 0.0),
    "P7": (-0.8, -0.6),
    "P3": (-0.4, -0.5),
    "Pz": (0.0, -0.5),
    "P4": (0.4, -0.5),
    "P8": (0.8, -0.6),
    "O1": (-0.3, -0.95),
    "O2": (0.3, -0.95),
}
MULTI_CHANNEL_NAMES = tuple(MULTI_CHANNEL_POSITIONS)
MULTI_ARTIFACT_LABELS = ("blink", "horizontal eye", "muscle", "heartbeat", "bad electrode")
MULTI_TRUTH_LABELS = NEURAL_LABELS + MULTI_ARTIFACT_LABELS
BAD_ELECTRODE = "C3"
MIN_MATCH = 0.3


@dataclass(frozen=True)
class ArtifactSimulation:
    time_s: NDArray[np.float64]
    latent_uv: NDArray[np.float64]
    raw_sensor_uv: NDArray[np.float64]
    clean_target_uv: NDArray[np.float64]
    artifact_sensor_uv: NDArray[np.float64]
    mixing_matrix: NDArray[np.float64]
    channel_names: tuple[str, ...] = CHANNEL_NAMES
    truth_labels: tuple[str, ...] = TRUTH_LABELS
    artifact_parts: dict[str, NDArray[np.float64]] | None = None
    neural_uv: NDArray[np.float64] | None = None


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
    truth_correlations: NDArray[np.float64]
    active_truth_indices: NDArray[np.int64]


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


def channel_names_for(recipe: IcaRecipe) -> tuple[str, ...]:
    return MULTI_CHANNEL_NAMES if recipe.scenario == "multi_artifact" else CHANNEL_NAMES


def artifact_labels_for(recipe: IcaRecipe) -> tuple[str, ...]:
    return MULTI_ARTIFACT_LABELS if recipe.scenario == "multi_artifact" else ("blink",)


def _blob(center: tuple[float, float], width: float) -> NDArray[np.float64]:
    xy = np.asarray(list(MULTI_CHANNEL_POSITIONS.values()), dtype=float)
    distance = np.sum((xy - np.asarray(center)) ** 2, axis=1)
    return np.exp(-0.5 * distance / width**2)


def _saccades(
    time_s: NDArray[np.float64], rng: np.random.Generator, sfreq: int
) -> NDArray[np.float64]:
    """Look left and right: a staircase of gaze positions with ~30 ms ramps."""

    level = np.zeros_like(time_s)
    current = 0.0
    t = 0.6
    while t < time_s[-1]:
        current = float(rng.choice([-1.0, 1.0])) * 45.0 if current == 0.0 else 0.0
        level[time_s >= t] = current
        t += float(rng.uniform(0.9, 1.8))
    ramp = max(1, int(0.03 * sfreq))
    return np.convolve(level, np.ones(ramp) / ramp, mode="same")


def _muscle(
    time_s: NDArray[np.float64], rng: np.random.Generator, sfreq: int
) -> NDArray[np.float64]:
    """Jaw clenches: broadband 25–90 Hz noise in a few bursts."""

    sos = signal.butter(4, [25, min(90, sfreq / 2 - 5)], btype="bandpass", fs=sfreq, output="sos")
    noise = signal.sosfiltfilt(sos, rng.normal(0, 1, time_s.size))
    noise /= max(float(noise.std()), np.finfo(float).eps)
    envelope = np.zeros_like(time_s)
    for start in np.arange(0.9, time_s[-1] - 1.0, 3.1):
        length = float(rng.uniform(0.7, 1.3))
        mask = (time_s >= start) & (time_s < start + length)
        envelope[mask] = signal.windows.tukey(int(mask.sum()), alpha=0.3)
    return 22.0 * envelope * noise


def _heartbeat(time_s: NDArray[np.float64]) -> NDArray[np.float64]:
    """R peaks at 72 beats/min with a small T wave."""

    waveform = np.zeros_like(time_s)
    for beat in np.arange(0.35, time_s[-1], 60 / 72):
        waveform += 14.0 * np.exp(-0.5 * ((time_s - beat) / 0.012) ** 2)
        waveform += 3.0 * np.exp(-0.5 * ((time_s - beat - 0.25) / 0.05) ** 2)
    return waveform


def _electrode_pops(time_s: NDArray[np.float64], rng: np.random.Generator) -> NDArray[np.float64]:
    """A loose electrode: sudden jumps that decay over a few hundred ms."""

    waveform = np.zeros_like(time_s)
    for pop in (2.2, 5.9, 9.4):
        if pop >= time_s[-1]:
            continue
        after = time_s >= pop
        sign = float(rng.choice([-1.0, 1.0]))
        waveform[after] += sign * 70.0 * np.exp(-(time_s[after] - pop) / 0.35)
    return waveform


def _simulate_multi_artifact(recipe: IcaRecipe) -> ArtifactSimulation:
    rng = np.random.default_rng(recipe.seed)
    count = int(round(recipe.duration_s * recipe.sampling_rate_hz))
    time_s = np.arange(count, dtype=float) / recipe.sampling_rate_hz
    sfreq = recipe.sampling_rate_hz
    alpha_envelope = 0.68 + 0.32 * np.sin(2 * np.pi * 0.21 * time_s) ** 2
    alpha = 14 * alpha_envelope * np.sin(2 * np.pi * 10 * time_s + 0.25)
    theta_envelope = 0.75 + 0.25 * np.sin(2 * np.pi * 0.13 * time_s + 1.0)
    theta = 9 * theta_envelope * np.sin(2 * np.pi * 6 * time_s - 0.6)
    beta_envelope = signal.windows.tukey(count, alpha=0.18)
    beta = 5.5 * beta_envelope * np.sin(2 * np.pi * 18 * time_s + 0.8)
    blink = _blink_waveform(time_s, recipe.blink_amplitude_uv)
    latent_uv = np.asarray(
        [
            alpha,
            theta,
            beta,
            blink,
            _saccades(time_s, rng, sfreq),
            _muscle(time_s, rng, sfreq),
            _heartbeat(time_s),
            _electrode_pops(time_s, rng),
        ],
        dtype=float,
    )
    x = np.asarray([position[0] for position in MULTI_CHANNEL_POSITIONS.values()])
    y = np.asarray([position[1] for position in MULTI_CHANNEL_POSITIONS.values()])
    blink_column = _blob((0.0, 1.2), 0.38)
    bad_column = np.asarray([1.0 if name == BAD_ELECTRODE else 0.0 for name in MULTI_CHANNEL_NAMES])
    columns = [
        _blob((0.0, -0.9), 0.5),
        # Frontal-midline theta. "Mixed component" gives it the blink's exact scalp pattern,
        # so no unmixing can tell the two apart and one component carries both.
        blink_column.copy() if recipe.mixed_component else _blob((0.0, 0.45), 0.42),
        _blob((-0.5, 0.05), 0.33) + _blob((0.5, 0.05), 0.33),
        blink_column,
        x * np.exp(-0.5 * (y - 0.65) ** 2 / 0.3**2),
        _blob((1.0, 0.05), 0.32),
        0.6 * x - 0.4 * y + 0.15,
        bad_column,
    ]
    mixing = np.stack(columns, axis=1)
    mixing /= np.linalg.norm(mixing, axis=0, keepdims=True)
    neural_sensor = mixing[:, :3] @ latent_uv[:3]
    parts = {
        label: mixing[:, 3 + offset, None] * latent_uv[3 + offset]
        for offset, label in enumerate(MULTI_ARTIFACT_LABELS)
    }
    artifact_sensor = np.sum(list(parts.values()), axis=0)
    noise = rng.normal(0, recipe.sensor_noise_uv, size=neural_sensor.shape)
    clean_target = neural_sensor + noise
    raw_sensor = clean_target + artifact_sensor
    if recipe.reference == "average":
        clean_target = _average_reference(clean_target)
        artifact_sensor = _average_reference(artifact_sensor)
        raw_sensor = _average_reference(raw_sensor)
        parts = {label: _average_reference(values) for label, values in parts.items()}
        neural_sensor = _average_reference(neural_sensor)
    return ArtifactSimulation(
        time_s=time_s,
        latent_uv=latent_uv,
        raw_sensor_uv=raw_sensor,
        clean_target_uv=clean_target,
        artifact_sensor_uv=artifact_sensor,
        mixing_matrix=mixing,
        channel_names=MULTI_CHANNEL_NAMES,
        truth_labels=MULTI_TRUTH_LABELS,
        artifact_parts=parts,
        neural_uv=neural_sensor,
    )


def simulate_artifact_recipe(recipe: IcaRecipe) -> ArtifactSimulation:
    """Create three neural sources plus a planted ocular source in display µV."""

    if recipe.scenario == "multi_artifact":
        return _simulate_multi_artifact(recipe)

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
        neural_sensor = _average_reference(neural_sensor)
    return ArtifactSimulation(
        time_s=time_s,
        latent_uv=latent_uv,
        raw_sensor_uv=raw_sensor,
        clean_target_uv=clean_target,
        artifact_sensor_uv=artifact_sensor,
        mixing_matrix=mixing,
        artifact_parts={"blink": artifact_sensor},
        neural_uv=neural_sensor,
    )


def _raw_from_uv(values_uv: NDArray[np.float64], recipe: IcaRecipe) -> mne.io.RawArray:
    info = mne.create_info(list(channel_names_for(recipe)), recipe.sampling_rate_hz, ch_types="eeg")
    raw = mne.io.RawArray(values_uv * 1e-6, info, verbose=False)
    raw.set_montage("standard_1020", on_missing="raise", verbose=False)
    if recipe.reference == "average":
        raw.set_eeg_reference("average", projection=False, verbose=False)
    return raw


def _compatibility_fingerprint(recipe: IcaRecipe, rank: int) -> str:
    payload = {
        "channels": channel_names_for(recipe),
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
    centered_truth = filtered_truth - filtered_truth.mean(axis=1, keepdims=True)
    truth_scale = centered_truth.std(axis=1)
    active_truth_indices = np.flatnonzero(truth_scale > np.finfo(float).eps)
    standardized_truth = centered_truth[active_truth_indices]
    standardized_truth /= truth_scale[active_truth_indices, None]
    correlations = np.abs(standardized_components @ standardized_truth.T / time_s_count(recipe))
    component_rows, truth_columns = linear_sum_assignment(-correlations)
    assignment = {
        int(component): (
            int(active_truth_indices[truth_column]),
            float(correlations[component, truth_column]),
        )
        for component, truth_column in zip(component_rows, truth_columns, strict=True)
    }
    if recipe.scenario == "multi_artifact":
        # With many sources, the optimal pairing can hand a leftover source to a pure-noise
        # component (r ≈ 0.03). Such a pairing is not a recovery, so it is not reported.
        assignment = {
            component: match for component, match in assignment.items() if match[1] >= MIN_MATCH
        }
    compatibility = IcaCompatibility(
        fingerprint=_compatibility_fingerprint(recipe, rank),
        channel_names=list(simulation.channel_names),
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
        truth_correlations=correlations,
        active_truth_indices=active_truth_indices,
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
                title="ICLabel 제안을 보류했습니다",
                explanation=(
                    "ICLabel은 평균 기준 EEG에 extended Infomax를 쓴 경우에 맞춰져 있습니다. "
                    "성분을 직접 살펴보는 것은 그대로 할 수 있습니다."
                ),
                suggestion="참고 라벨을 보려면 평균 기준과 extended Infomax를 쓰세요.",
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
                title="ICLabel이 설치되어 있지 않습니다",
                explanation=("자동 라벨은 선택 사항입니다. 성분 제거는 어차피 직접 골라야 합니다."),
                suggestion="참고 라벨을 쓰려면 프로젝트의 ica 의존성 그룹을 설치하세요.",
            )
        )
        return ["unavailable"] * count, [0.0] * count, False, warnings


def simulate_ica_input(recipe: IcaRecipe) -> IcaSimulationResult:
    """Generate the contaminated sensor EEG without fitting a decomposition."""

    simulation = simulate_artifact_recipe(recipe)
    raw = _raw_from_uv(simulation.raw_sensor_uv, recipe)
    rank = int(mne.compute_rank(raw, rank=None, verbose=False)["eeg"])
    view = view_indices(simulation.time_s.size)
    recipe_hash = hashlib.sha256(recipe.model_dump_json().encode()).hexdigest()[:12]
    return IcaSimulationResult(
        run_id=f"ica_input_{uuid.uuid4().hex[:10]}",
        state="completed",
        recipe=recipe,
        sensor_trace=SeriesData(
            x=np.round(simulation.time_s[view], 4).tolist(),
            series={
                name: np.round(simulation.raw_sensor_uv[index, view], 4).tolist()
                for index, name in enumerate(simulation.channel_names)
            },
            x_unit="s",
            y_unit="µV",
        ),
        source_labels=list(simulation.truth_labels),
        channel_names=list(simulation.channel_names),
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
    view = view_indices(fitted.simulation.time_s.size)
    topographies = fitted.ica.get_components()
    labels = fitted.simulation.truth_labels
    artifact_labels = artifact_labels_for(recipe)
    costs = _single_exclusion_costs(fitted, recipe)
    components: list[IcaComponentSummary] = []
    for index, source in enumerate(fitted.component_sources):
        frequency, power = signal.welch(
            source,
            fs=recipe.sampling_rate_hz,
            nperseg=min(source.size, recipe.sampling_rate_hz * 2),
        )
        truth_match = fitted.assignment.get(index)
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
                matched_truth=None if truth_match is None else labels[truth_match[0]],
                matched_correlation=None if truth_match is None else round(truth_match[1], 4),
                matched_kind=None
                if truth_match is None
                else ("artifact" if labels[truth_match[0]] in artifact_labels else "neural"),
                truth_correlations={
                    labels[int(truth)]: round(float(fitted.truth_correlations[index, column]), 4)
                    for column, truth in enumerate(fitted.active_truth_indices)
                },
                artifact_removed_pct=costs[index][0],
                neural_loss_pct=costs[index][1],
                artifact_removed_by_type=costs[index][2],
                time_s=np.round(fitted.simulation.time_s[view], 4).tolist(),
                trace=np.round(source[view], 5).tolist(),
                frequency_hz=np.round(frequency, 4).tolist(),
                power=round_significant(power).tolist(),
                topography=np.round(component_topography, 4).tolist(),
            )
        )
    blink_component = next(
        (index for index, (truth, _) in fitted.assignment.items() if labels[truth] == "blink"),
        None,
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
        artifact_labels=list(artifact_labels),
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


def _rms(values: NDArray[np.float64]) -> float:
    return float(np.sqrt(np.mean(values**2)))


def _apply_to(
    fitted: FittedIca, recipe: IcaRecipe, values_uv: NDArray[np.float64], exclude: list[int]
) -> NDArray[np.float64]:
    raw = _raw_from_uv(values_uv, recipe)
    fitted.ica.apply(raw, exclude=exclude, verbose=False)
    return raw.get_data() * 1e6


def _removal_scores(
    fitted: FittedIca, recipe: IcaRecipe, exclude: list[int]
) -> tuple[float, float, dict[str, float]]:
    """Exact cost of an exclusion, known only because the parts were simulated separately.

    Returns (artifact power removed %, neural signal RMS lost %, removed % per artifact type).
    """

    simulation = fitted.simulation
    # Noise-free neural part: removing a pure-noise dimension should cost nothing here.
    neural = (
        simulation.neural_uv if simulation.neural_uv is not None else simulation.clean_target_uv
    )
    neural_after = _apply_to(fitted, recipe, neural, exclude)
    neural_loss = _rms(neural_after - neural) / max(_rms(neural), np.finfo(float).eps)
    by_type: dict[str, float] = {}
    for label, part in (simulation.artifact_parts or {}).items():
        power = float(np.mean(part**2))
        if power <= np.finfo(float).eps:
            continue
        after = _apply_to(fitted, recipe, part, exclude)
        by_type[label] = round(max(0.0, 100 * (1 - float(np.mean(after**2)) / power)), 2)
    total_power = float(np.mean(simulation.artifact_sensor_uv**2))
    if total_power <= np.finfo(float).eps:
        removed = 0.0
    else:
        after = _apply_to(fitted, recipe, simulation.artifact_sensor_uv, exclude)
        removed = max(0.0, 100 * (1 - float(np.mean(after**2)) / total_power))
    return round(removed, 2), round(float(neural_loss * 100), 2), by_type


def _single_exclusion_costs(
    fitted: FittedIca, recipe: IcaRecipe
) -> list[tuple[float, float, dict[str, float]]]:
    count = fitted.component_sources.shape[0]
    return [_removal_scores(fitted, recipe, [index]) for index in range(count)]


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
    if request.recipe.scenario == "multi_artifact":
        artifact_after = _apply_to(
            fitted, request.recipe, fitted.simulation.artifact_sensor_uv, exclusions
        )
        before_power = float(np.mean(fitted.simulation.artifact_sensor_uv**2))
        after_power = float(np.mean(artifact_after**2))
    else:
        blink_template = fitted.simulation.latent_uv[3]
        before_power = _template_power(fitted.simulation.raw_sensor_uv, blink_template)
        after_power = _template_power(cleaned_uv, blink_template)
    attenuation = 10 * np.log10(max(before_power, np.finfo(float).eps) / max(after_power, 1e-12))
    artifact_removed, _, removed_by_type = _removal_scores(fitted, request.recipe, exclusions)
    neural_rms = np.sqrt(np.mean(fitted.simulation.clean_target_uv**2))
    distortion = np.sqrt(
        np.mean((cleaned_neural_control_uv - fitted.simulation.clean_target_uv) ** 2)
    )
    distortion_pct = float(distortion / max(neural_rms, np.finfo(float).eps) * 100)
    view = view_indices(fitted.simulation.time_s.size)
    warnings: list[WarningMessage] = []
    if not exclusions:
        warnings.append(
            WarningMessage(
                code="no_components_excluded",
                severity="info",
                title="제거한 성분이 없습니다",
                explanation=("ICA 제안은 자료를 자동으로 지우지 않으므로 출력은 그대로입니다."),
                suggestion="성분을 살펴보고 직접 고른 뒤 적용하세요.",
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
                for index, channel_name in enumerate(fitted.simulation.channel_names)
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
        artifact_removed_pct=artifact_removed,
        artifact_removed_by_type=removed_by_type,
        compatibility_verified=True,
        warnings=warnings,
    )
