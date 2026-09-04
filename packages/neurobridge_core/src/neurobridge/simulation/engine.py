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


def _normalize_rows(values: NDArray[np.float64]) -> NDArray[np.float64]:
    centered = values - values.mean(axis=-1, keepdims=True)
    scale = centered.std(axis=-1, keepdims=True)
    return centered / np.maximum(scale, np.finfo(float).eps)


def _one_over_f_background(
    rng: np.random.Generator,
    signal_count: int,
    sample_count: int,
    sampling_rate_hz: float,
) -> NDArray[np.float64]:
    """Synthesize unit-RMS colored activity with an approximately 1/f PSD."""

    frequencies = np.fft.rfftfreq(sample_count, d=1 / sampling_rate_hz)
    amplitude = np.zeros_like(frequencies)
    amplitude[1:] = frequencies[1:] ** -0.5
    coefficients = (
        rng.normal(size=(signal_count, frequencies.size))
        + 1j * rng.normal(size=(signal_count, frequencies.size))
    ) * amplitude
    coefficients[:, 0] = 0
    if sample_count % 2 == 0:
        coefficients[:, -1] = coefficients[:, -1].real
    background = np.fft.irfft(coefficients, n=sample_count, axis=-1)
    return _normalize_rows(background)


def _alpha_envelope(time_s: NDArray[np.float64]) -> NDArray[np.float64]:
    """Return a smooth deterministic alpha envelope with transient bursts."""

    slow = 0.46 + 0.12 * np.sin(2 * np.pi * 0.12 * time_s + 0.4)
    slow += 0.07 * np.sin(2 * np.pi * 0.035 * time_s + 1.1)
    bursts = np.zeros_like(time_s)
    duration_s = time_s[-1] + (time_s[1] - time_s[0]) if time_s.size > 1 else 0
    for burst_index, center_s in enumerate(np.arange(0.8, duration_s + 0.8, 2.35)):
        width_s = 0.34 + 0.05 * (burst_index % 3)
        height = 0.32 + 0.06 * np.sin(burst_index * 1.7 + 0.3)
        bursts += height * np.exp(-0.5 * ((time_s - center_s) / width_s) ** 2)
    envelope = np.clip(slow + bursts, 0.25, 1.0)
    return envelope / max(float(envelope.max()), np.finfo(float).eps)


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
            if 8 <= source.frequency_hz <= 13:
                waveform *= _alpha_envelope(time_s)
        latent.append(waveform)

    latent_uv = np.asarray(latent, dtype=float)
    mixing_matrix = _stable_mixing_matrix(spec.channel_count, len(spec.sources))
    sensor_uv = mixing_matrix @ latent_uv
    shared_background = _one_over_f_background(
        rng, 1, sample_count, spec.sampling_rate_hz
    )
    independent_background = _one_over_f_background(
        rng, spec.channel_count, sample_count, spec.sampling_rate_hz
    )
    colored_background = _normalize_rows(
        0.42 * shared_background + 0.91 * independent_background
    )
    white_noise = rng.normal(size=sensor_uv.shape)
    combined_background = _normalize_rows(0.96 * colored_background + 0.28 * white_noise)
    sensor_uv += spec.noise_uv * combined_background
    channel_names = tuple(f"EEG {index + 1:02d}" for index in range(spec.channel_count))
    return SimulationData(time_s, latent_uv, sensor_uv, mixing_matrix, channel_names)


def to_mne_raw(data: SimulationData, sampling_rate_hz: float):
    """Return an MNE RawArray; convert display µV to analysis SI volts."""

    import mne

    info = mne.create_info(list(data.channel_names), sampling_rate_hz, ch_types="eeg")
    return mne.io.RawArray(data.sensor_uv * 1e-6, info, verbose=False)
