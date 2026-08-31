"""Deterministic Level A source generation and explicit linear mixing."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from neurobridge.contracts.models import SimulationSpec


@dataclass(frozen=True)
class SimulationData:
    time_s: NDArray[np.float64]
    latent_uv: NDArray[np.float64]
    sensor_uv: NDArray[np.float64]
    mixing_matrix: NDArray[np.float64]
    channel_names: tuple[str, ...]


def _stable_mixing_matrix(channel_count: int, source_count: int) -> NDArray[np.float64]:
    channel_positions = np.linspace(-1.0, 1.0, channel_count)[:, None]
    source_positions = np.linspace(-0.85, 0.85, source_count)[None, :]
    distances = np.abs(channel_positions - source_positions)
    matrix = np.exp(-1.7 * distances)
    alternating = np.where(
        (np.arange(channel_count)[:, None] + np.arange(source_count)) % 3 == 0, -1, 1
    )
    matrix = matrix * alternating
    norms = np.linalg.norm(matrix, axis=0, keepdims=True)
    return matrix / np.maximum(norms, np.finfo(float).eps)


def simulate_linear_mixture(spec: SimulationSpec) -> SimulationData:
    """Generate latent µV sources and mix them into deterministic sensor channels."""

    rng = np.random.default_rng(spec.seed)
    sample_count = int(round(spec.duration_s * spec.sampling_rate_hz))
    time_s = np.arange(sample_count, dtype=float) / spec.sampling_rate_hz
    latent: list[NDArray[np.float64]] = []

    for source in spec.sources:
        phase = np.deg2rad(source.phase_deg)
        if source.kind == "blink":
            center = spec.duration_s * 0.48
            width = max(0.08, spec.duration_s * 0.018)
            waveform = source.amplitude_uv * np.exp(-0.5 * ((time_s - center) / width) ** 2)
        else:
            waveform = source.amplitude_uv * np.sin(
                2 * np.pi * source.frequency_hz * time_s + phase
            )
        latent.append(waveform)

    latent_uv = np.asarray(latent, dtype=float)
    mixing_matrix = _stable_mixing_matrix(spec.channel_count, len(spec.sources))
    sensor_uv = mixing_matrix @ latent_uv
    sensor_uv += rng.normal(0, spec.noise_uv, size=sensor_uv.shape)
    channel_names = tuple(f"EEG {index + 1:02d}" for index in range(spec.channel_count))
    return SimulationData(time_s, latent_uv, sensor_uv, mixing_matrix, channel_names)


def to_mne_raw(data: SimulationData, sampling_rate_hz: float):
    """Return an MNE RawArray; convert display µV to analysis SI volts."""

    import mne

    info = mne.create_info(list(data.channel_names), sampling_rate_hz, ch_types="eeg")
    return mne.io.RawArray(data.sensor_uv * 1e-6, info, verbose=False)
