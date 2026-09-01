"""Deterministic spectral and sensor-connectivity truth challenge."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass

import numpy as np
import scipy
from mne.time_frequency import psd_array_multitaper
from mne_connectivity import spectral_connectivity_epochs
from numpy.typing import NDArray
from scipy import signal
from specparam import SpectralModel

from neurobridge import __version__
from neurobridge.contracts.models import (
    ConnectivityEdge,
    ConnectivityMatrix,
    ConnectivityRecipe,
    ConnectivityResult,
    ConnectivityScores,
    Provenance,
    SpectralParameterization,
    SpectrumComparison,
    WarningMessage,
)

LATENT_NAMES = ["Frontal L", "Frontal R", "Posterior L", "Posterior R"]
SENSOR_NAMES = ["Fp1", "Fp2", "F7", "F8", "C3", "C4", "O1", "O2"]
SENSOR_POSITIONS = np.asarray(
    [
        (-0.38, 0.86),
        (0.38, 0.86),
        (-0.82, 0.42),
        (0.82, 0.42),
        (-0.46, -0.03),
        (0.46, -0.03),
        (-0.32, -0.78),
        (0.32, -0.78),
    ],
    dtype=float,
)
SOURCE_POSITIONS = np.asarray(
    [(-0.48, 0.52), (0.48, 0.52), (-0.42, -0.57), (0.42, -0.57)], dtype=float
)


@dataclass(frozen=True)
class ChallengeData:
    latent_epochs: NDArray[np.float64]
    sensor_epochs: NDArray[np.float64]
    mixing_matrix: NDArray[np.float64]
    truth_matrix: NDArray[np.float64]


def _colored_noise(
    rng: np.random.Generator, sample_count: int, exponent: float = 1.4
) -> NDArray[np.float64]:
    """Generate unit-variance noise with an approximately 1/f^exponent power spectrum."""

    frequency = np.fft.rfftfreq(sample_count)
    scale = np.zeros_like(frequency)
    scale[1:] = frequency[1:] ** (-exponent / 2)
    coefficients = (rng.normal(size=frequency.size) + 1j * rng.normal(size=frequency.size)) * scale
    values = np.fft.irfft(coefficients, n=sample_count)
    return (values - values.mean()) / max(values.std(), np.finfo(float).eps)


def _mixing_matrix(volume_conduction: float) -> NDArray[np.float64]:
    distances = np.linalg.norm(
        SENSOR_POSITIONS[:, None, :] - SOURCE_POSITIONS[None, :, :], axis=2
    )
    focal = np.exp(-3.1 * distances)
    broad = np.exp(-1.05 * distances)
    matrix = (1 - volume_conduction) * focal + volume_conduction * broad
    return matrix / np.maximum(np.linalg.norm(matrix, axis=0, keepdims=True), 1e-12)


def _simulate(recipe: ConnectivityRecipe) -> ChallengeData:
    rng = np.random.default_rng(recipe.seed)
    sample_count = int(round(recipe.epoch_duration_s * recipe.sampling_rate_hz))
    time_s = np.arange(sample_count) / recipe.sampling_rate_hz
    omega = 2 * np.pi * recipe.alpha_frequency_hz * time_s
    lag = np.deg2rad(recipe.phase_lag_deg)
    latent = np.empty((recipe.epoch_count, 4, sample_count), dtype=float)

    independent_weight = np.sqrt(max(0.0, 1 - recipe.coupling_strength**2))
    for epoch_index in range(recipe.epoch_count):
        phase_a, phase_b, phase_c, phase_d = rng.uniform(0, 2 * np.pi, size=4)
        source_a = np.sin(omega + phase_a)
        source_b = (
            recipe.coupling_strength * np.sin(omega + phase_a + lag)
            + independent_weight * np.sin(omega + phase_b)
        )
        oscillations = [source_a, source_b, np.sin(omega + phase_c), np.sin(omega + phase_d)]
        for source_index, oscillation in enumerate(oscillations):
            background = _colored_noise(rng, sample_count)
            latent[epoch_index, source_index] = oscillation + recipe.noise_sd * background

    mixing = _mixing_matrix(recipe.volume_conduction)
    sensor = np.einsum("cs,est->ect", mixing, latent)
    sensor += rng.normal(0, recipe.noise_sd * 0.08, size=sensor.shape)
    if recipe.reference == "average":
        sensor -= sensor.mean(axis=1, keepdims=True)

    truth = np.zeros((4, 4), dtype=float)
    truth[0, 1] = truth[1, 0] = recipe.coupling_strength
    return ChallengeData(latent, sensor, mixing, truth)


def _estimate(
    epochs: NDArray[np.float64], names: list[str], recipe: ConnectivityRecipe
) -> NDArray[np.float64]:
    if recipe.metric == "pearson":
        flattened = np.transpose(epochs, (1, 0, 2)).reshape(epochs.shape[1], -1)
        matrix = np.abs(np.corrcoef(flattened))
        np.fill_diagonal(matrix, 0)
        return np.clip(matrix, 0, 1)
    result = spectral_connectivity_epochs(
        data=epochs,
        names=names,
        method=recipe.metric,
        mode=recipe.spectral_mode,
        sfreq=recipe.sampling_rate_hz,
        fmin=recipe.band_low_hz,
        fmax=recipe.band_high_hz,
        faverage=True,
        n_jobs=1,
        verbose=False,
    )
    matrix = np.asarray(result.get_data(output="dense")[:, :, 0], dtype=float)
    matrix = np.abs(matrix + matrix.T)
    np.fill_diagonal(matrix, 0)
    return np.clip(matrix, 0, 1)


def _surrogate_distribution(
    epochs: NDArray[np.float64], names: list[str], recipe: ConnectivityRecipe
) -> NDArray[np.float64]:
    rng = np.random.default_rng(recipe.seed + 10_000)
    maxima = np.empty(recipe.surrogate_count, dtype=float)
    upper = np.triu_indices(epochs.shape[1], 1)
    for surrogate_index in range(recipe.surrogate_count):
        shuffled = np.empty_like(epochs)
        for node_index in range(epochs.shape[1]):
            shuffled[:, node_index] = epochs[rng.permutation(recipe.epoch_count), node_index]
        maxima[surrogate_index] = float(_estimate(shuffled, names, recipe)[upper].max())
    return maxima


def _spectrum(epochs: NDArray[np.float64], recipe: ConnectivityRecipe) -> SpectrumComparison:
    values = epochs[:, 0, :]
    nperseg = values.shape[-1]
    frequency, welch_power = signal.welch(
        values,
        fs=recipe.sampling_rate_hz,
        nperseg=nperseg,
        window="hann",
        axis=-1,
    )
    multitaper_power, multitaper_frequency = psd_array_multitaper(
        values,
        sfreq=recipe.sampling_rate_hz,
        fmin=2,
        fmax=40,
        bandwidth=2.5,
        adaptive=False,
        low_bias=True,
        normalization="full",
        verbose=False,
    )
    mean_welch = welch_power.mean(axis=0)
    mean_multitaper = multitaper_power.mean(axis=0)

    model = SpectralModel(
        peak_width_limits=(1.0, 8.0),
        max_n_peaks=4,
        min_peak_height=0.05,
        peak_threshold=1.5,
        verbose=False,
    )
    model.fit(frequency, mean_welch, [2, 40])
    fit = model.results.get_results()
    fit_frequency = np.asarray(model.data.freqs, dtype=float)
    aperiodic = 10 ** np.asarray(model.data.get_data("aperiodic"), dtype=float)
    modeled = 10 ** np.asarray(model.data.get_data("full"), dtype=float)
    periodic = np.asarray(model.get_params("periodic"), dtype=float)
    if periodic.ndim == 1:
        periodic = periodic[None, :]
    if periodic.size and np.isfinite(periodic).all():
        strongest = periodic[np.argmax(periodic[:, 1])]
        peak_frequency, peak_power, peak_bandwidth = map(float, strongest[:3])
    else:
        peak_frequency = peak_power = peak_bandwidth = None

    return SpectrumComparison(
        frequency_hz=np.round(fit_frequency, 4).tolist(),
        welch_power=np.round(np.interp(fit_frequency, frequency, mean_welch), 10).tolist(),
        multitaper_power=np.round(
            np.interp(fit_frequency, multitaper_frequency, mean_multitaper), 10
        ).tolist(),
        frequency_resolution_hz=round(recipe.sampling_rate_hz / nperseg, 4),
        parameterization=SpectralParameterization(
            backend="specparam",
            fit_low_hz=float(fit_frequency[0]),
            fit_high_hz=float(fit_frequency[-1]),
            offset=round(float(fit.aperiodic_fit[0]), 4),
            exponent=round(float(fit.aperiodic_fit[-1]), 4),
            peak_frequency_hz=None if peak_frequency is None else round(peak_frequency, 3),
            peak_power=None if peak_power is None else round(peak_power, 4),
            peak_bandwidth_hz=None if peak_bandwidth is None else round(peak_bandwidth, 3),
            r_squared=round(float(fit.metrics["gof_rsquared"]), 4),
            mean_absolute_error=round(float(fit.metrics["error_mae"]), 4),
            aperiodic_power=np.round(aperiodic, 10).tolist(),
            modeled_power=np.round(modeled, 10).tolist(),
        ),
    )


def _score(
    estimated: NDArray[np.float64], truth: NDArray[np.float64], threshold: float
) -> ConnectivityScores:
    upper = np.triu_indices_from(estimated, 1)
    estimate_values = estimated[upper]
    truth_values = truth[upper]
    detected = estimate_values >= threshold
    planted = truth_values > 0
    true_positive = int(np.sum(detected & planted))
    false_positive = int(np.sum(detected & ~planted))
    false_negative = int(np.sum(~detected & planted))
    precision = true_positive / max(true_positive + false_positive, 1)
    recall = true_positive / max(true_positive + false_negative, 1)
    if np.std(estimate_values) > 0 and np.std(truth_values) > 0:
        correlation = float(np.corrcoef(estimate_values, truth_values)[0, 1])
    else:
        correlation = 0.0
    return ConnectivityScores(
        threshold=round(threshold, 4),
        true_positive=true_positive,
        false_positive=false_positive,
        false_negative=false_negative,
        precision=round(precision, 4),
        recall=round(recall, 4),
        strongest_edge_correct=int(np.argmax(estimate_values)) == int(np.argmax(truth_values)),
        weighted_truth_correlation=round(correlation, 4),
    )


def _matrix(
    names: list[str], values: NDArray[np.float64], space: str, recipe: ConnectivityRecipe
) -> ConnectivityMatrix:
    return ConnectivityMatrix(
        node_names=names,
        values=np.round(values, 4).tolist(),
        space=space,
        metric=recipe.metric if space != "truth" else "planted coupling",
        band_hz=(recipe.band_low_hz, recipe.band_high_hz),
    )


def _edges(
    names: list[str],
    matrix: NDArray[np.float64],
    truth: NDArray[np.float64] | None,
    threshold: float,
) -> list[ConnectivityEdge]:
    edges: list[ConnectivityEdge] = []
    for source_index in range(len(names)):
        for target_index in range(source_index + 1, len(names)):
            value = float(matrix[source_index, target_index])
            edges.append(
                ConnectivityEdge(
                    source=names[source_index],
                    target=names[target_index],
                    weight=round(value, 4),
                    detected=value >= threshold,
                    is_true=None if truth is None else bool(truth[source_index, target_index] > 0),
                )
            )
    return sorted(edges, key=lambda edge: edge.weight, reverse=True)


def _warnings(recipe: ConnectivityRecipe, fit_r_squared: float) -> list[WarningMessage]:
    warnings = [
        WarningMessage(
            code="connectivity_not_causality",
            severity="warning",
            title="An edge is not a causal connection",
            explanation=(
                "This undirected estimator summarizes statistical dependence in this band; "
                "it is not a synapse, structural pathway, or proof of direction."
            ),
            suggestion="Compare the estimate with the planted latent graph after revealing truth.",
        )
    ]
    if recipe.analysis_space == "sensor":
        warnings.append(
            WarningMessage(
                code="sensor_volume_conduction",
                severity="warning",
                title="Sensor edges inherit shared field spread",
                explanation=(
                    "Each scalp channel contains mixtures of multiple latent sources. Zero-lag "
                    "sensor dependence can therefore appear without a new latent edge."
                ),
                suggestion=(
                    "Switch to latent space or a lag-sensitive metric for this controlled lesson."
                ),
            )
        )
    if recipe.metric in {"pearson", "coh", "plv"}:
        warnings.append(
            WarningMessage(
                code="zero_lag_sensitive_metric",
                severity="info",
                title="This metric retains zero-lag dependence",
                explanation=(
                    "Pearson correlation, coherence, and PLV can be inflated by instantaneous "
                    "sensor mixing."
                ),
                suggestion="Compare with imaginary coherence, PLI, or wPLI.",
            )
        )
    if fit_r_squared < 0.9:
        warnings.append(
            WarningMessage(
                code="specparam_fit_quality",
                severity="info",
                title="Inspect the spectral fit before interpreting it",
                explanation=(
                    "The periodic/aperiodic fit explains "
                    f"{fit_r_squared * 100:.1f}% of log-power variance."
                ),
                suggestion=(
                    "Increase epoch duration or inspect residual structure before "
                    "comparing exponents."
                ),
            )
        )
    return warnings


def run_connectivity_challenge(recipe: ConnectivityRecipe) -> ConnectivityResult:
    """Run a planted one-edge network through spectra, sensor mixing, surrogates, and scoring."""

    data = _simulate(recipe)
    latent = _estimate(data.latent_epochs, LATENT_NAMES, recipe)
    sensor = _estimate(data.sensor_epochs, SENSOR_NAMES, recipe)
    latent_surrogates = _surrogate_distribution(data.latent_epochs, LATENT_NAMES, recipe)
    sensor_surrogates = _surrogate_distribution(data.sensor_epochs, SENSOR_NAMES, recipe)
    latent_threshold = float(np.percentile(latent_surrogates, 95))
    sensor_threshold = float(np.percentile(sensor_surrogates, 95))
    spectrum = _spectrum(data.latent_epochs, recipe)
    score = _score(latent, data.truth_matrix, latent_threshold)
    if recipe.analysis_space == "sensor":
        selected_names, selected_values, selected_truth = SENSOR_NAMES, sensor, None
        selected_surrogates, selected_threshold = sensor_surrogates, sensor_threshold
    else:
        selected_names, selected_values, selected_truth = LATENT_NAMES, latent, data.truth_matrix
        selected_surrogates, selected_threshold = latent_surrogates, latent_threshold

    recipe_hash = hashlib.sha256(
        recipe.model_dump_json(exclude_none=True).encode("utf-8")
    ).hexdigest()[:12]
    return ConnectivityResult(
        run_id=f"conn_{uuid.uuid4().hex[:10]}",
        state="completed",
        recipe=recipe,
        warnings=_warnings(recipe, spectrum.parameterization.r_squared),
        spectrum=spectrum,
        latent=_matrix(LATENT_NAMES, latent, "latent", recipe),
        sensor=_matrix(SENSOR_NAMES, sensor, "sensor", recipe),
        selected=_matrix(selected_names, selected_values, recipe.analysis_space, recipe),
        truth=_matrix(LATENT_NAMES, data.truth_matrix, "truth", recipe),
        latent_edges=_edges(LATENT_NAMES, latent, data.truth_matrix, latent_threshold),
        sensor_edges=_edges(SENSOR_NAMES, sensor, None, sensor_threshold),
        thresholded_edges=_edges(
            selected_names, selected_values, selected_truth, selected_threshold
        ),
        surrogate_values=np.round(selected_surrogates, 4).tolist(),
        latent_surrogate_values=np.round(latent_surrogates, 4).tolist(),
        sensor_surrogate_values=np.round(sensor_surrogates, 4).tolist(),
        selected_threshold=round(selected_threshold, 4),
        latent_threshold=round(latent_threshold, 4),
        sensor_threshold=round(sensor_threshold, 4),
        scores=score,
        mixing_matrix=np.round(data.mixing_matrix, 4).tolist(),
        sensor_positions=np.round(SENSOR_POSITIONS, 4).tolist(),
        estimator_backend="numpy" if recipe.metric == "pearson" else "mne-connectivity",
        estimator_family=(
            "lag-sensitive" if recipe.metric in {"imcoh", "pli", "wpli"} else "functional"
        ),
        n_epochs_used=recipe.epoch_count,
        provenance=Provenance(
            recipe_hash=recipe_hash,
            engine_version=__version__,
            numpy_version=np.__version__,
            scipy_version=scipy.__version__,
            seed=recipe.seed,
            sampling_rate_hz=recipe.sampling_rate_hz,
            reference=recipe.reference,
            rank=int(np.linalg.matrix_rank(data.sensor_epochs.reshape(8, -1))),
        ),
    )
