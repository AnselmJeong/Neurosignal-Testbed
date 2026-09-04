"""Application service orchestrating scientific primitives into one result contract."""

from __future__ import annotations

import hashlib
import uuid

import numpy as np
import scipy
from scipy import signal

from neurobridge import __version__
from neurobridge.contracts.models import (
    ExperimentRecipe,
    ExperimentResult,
    FilterResponseData,
    Provenance,
    SeriesData,
    SpectrumData,
)
from neurobridge.preprocessing import apply_preprocessing, validate_recipe
from neurobridge.simulation import simulate_linear_mixture


def _downsample_indices(length: int, maximum: int = 1000) -> np.ndarray:
    if length <= maximum:
        return np.arange(length)
    return np.linspace(0, length - 1, maximum, dtype=int)


def _welch_power(values: np.ndarray, sampling_rate_hz: float) -> tuple[np.ndarray, np.ndarray]:
    segment = min(values.shape[-1], max(256, int(sampling_rate_hz * 2)))
    frequencies, power = signal.welch(values, fs=sampling_rate_hz, nperseg=segment, axis=-1)
    return frequencies, power


def _observed_peaks(frequencies: np.ndarray, power: np.ndarray) -> list[float]:
    mask = (frequencies >= 1) & (frequencies <= 70)
    masked_power = power[mask]
    local_peaks, _ = signal.find_peaks(
        masked_power,
        distance=3,
        prominence=max(float(np.median(masked_power) * 6), np.finfo(float).eps),
    )
    candidate_frequencies = frequencies[mask][local_peaks]
    candidate_power = masked_power[local_peaks]
    if candidate_power.size == 0:
        return []
    order = np.argsort(candidate_power)[::-1][:3]
    return sorted(round(float(value), 2) for value in candidate_frequencies[order])


def run_experiment(recipe: ExperimentRecipe) -> ExperimentResult:
    """Execute the deterministic sampling and filtering lesson."""

    simulation = simulate_linear_mixture(recipe.simulation)
    filtered = apply_preprocessing(
        simulation.sensor_uv, recipe.simulation.sampling_rate_hz, recipe.preprocessing
    )
    raw_frequency, raw_power_by_channel = _welch_power(
        simulation.sensor_uv, recipe.simulation.sampling_rate_hz
    )
    filtered_frequency, filtered_power_by_channel = _welch_power(
        filtered.values_uv, recipe.simulation.sampling_rate_hz
    )
    if not np.allclose(raw_frequency, filtered_frequency):
        raise RuntimeError("spectrum frequency coordinates do not match")
    raw_power = raw_power_by_channel.mean(axis=0)
    filtered_power = filtered_power_by_channel.mean(axis=0)

    view = _downsample_indices(simulation.time_s.size)
    traces: dict[str, list[float]] = {}
    for channel_index, channel_name in enumerate(simulation.channel_names):
        traces[f"Raw · {channel_name}"] = np.round(
            simulation.sensor_uv[channel_index, view], 4
        ).tolist()
        traces[f"Filtered · {channel_name}"] = np.round(
            filtered.values_uv[channel_index, view], 4
        ).tolist()
    recipe_json = recipe.model_dump_json(exclude_none=True)
    recipe_hash = hashlib.sha256(recipe_json.encode("utf-8")).hexdigest()[:12]
    variance = np.var(filtered.values_uv) / max(np.var(simulation.sensor_uv), np.finfo(float).eps)

    return ExperimentResult(
        run_id=f"run_{uuid.uuid4().hex[:10]}",
        state="completed",
        recipe=recipe,
        warnings=validate_recipe(recipe.simulation, recipe.preprocessing),
        traces=SeriesData(
            x=np.round(simulation.time_s[view], 4).tolist(),
            series=traces,
            x_unit="s",
            y_unit="µV",
        ),
        spectrum=SpectrumData(
            frequency_hz=np.round(raw_frequency, 4).tolist(),
            raw_power=np.round(raw_power, 8).tolist(),
            filtered_power=np.round(filtered_power, 8).tolist(),
            raw_power_by_channel={
                channel_name: np.round(raw_power_by_channel[channel_index], 8).tolist()
                for channel_index, channel_name in enumerate(simulation.channel_names)
            },
            filtered_power_by_channel={
                channel_name: np.round(filtered_power_by_channel[channel_index], 8).tolist()
                for channel_index, channel_name in enumerate(simulation.channel_names)
            },
            unit="µV²/Hz",
        ),
        filter_response=FilterResponseData(
            frequency_hz=np.round(filtered.response_frequency_hz, 4).tolist(),
            gain_db=np.round(filtered.response_gain_db, 4).tolist(),
        ),
        mixing_matrix=np.round(simulation.mixing_matrix, 3).tolist(),
        peak_frequencies_hz=_observed_peaks(filtered_frequency, filtered_power),
        truth_peaks_hz=sorted(source.frequency_hz for source in recipe.simulation.sources),
        retained_variance_pct=round(float(variance * 100), 1),
        provenance=Provenance(
            recipe_hash=recipe_hash,
            engine_version=__version__,
            numpy_version=np.__version__,
            scipy_version=scipy.__version__,
            seed=recipe.simulation.seed,
            sampling_rate_hz=recipe.simulation.sampling_rate_hz,
            reference=recipe.preprocessing.reference,
            rank=filtered.rank,
        ),
    )
