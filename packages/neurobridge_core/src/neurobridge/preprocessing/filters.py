"""Reversible preprocessing transforms and educational warning rules."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from scipy import signal

from neurobridge.contracts.models import PreprocessingSpec, SimulationSpec, WarningMessage


@dataclass(frozen=True)
class FilteredData:
    values_uv: NDArray[np.float64]
    response_frequency_hz: NDArray[np.float64]
    response_gain_db: NDArray[np.float64]
    rank: int


def validate_recipe(
    simulation: SimulationSpec, preprocessing: PreprocessingSpec
) -> list[WarningMessage]:
    nyquist = simulation.sampling_rate_hz / 2
    warnings: list[WarningMessage] = []
    for label, value in (
        ("High-pass", preprocessing.highpass_hz),
        ("Low-pass", preprocessing.lowpass_hz),
        ("Notch", preprocessing.notch_hz),
    ):
        if value is not None and value >= nyquist:
            warnings.append(
                WarningMessage(
                    code=f"{label.lower().replace('-', '_')}_above_nyquist",
                    severity="error" if label != "Notch" else "warning",
                    title=f"{label} is at or above Nyquist",
                    explanation=(
                        f"{value:g} Hz cannot be represented independently at "
                        f"{simulation.sampling_rate_hz} Hz sampling."
                    ),
                    suggestion=(
                        f"Use a frequency below {nyquist:g} Hz or increase the sampling rate."
                    ),
                )
            )
    if (
        preprocessing.notch_hz is not None
        and preprocessing.lowpass_hz is not None
        and preprocessing.notch_hz > preprocessing.lowpass_hz
    ):
        warnings.append(
            WarningMessage(
                code="redundant_notch",
                severity="info",
                title="The 60 Hz notch is redundant here",
                explanation=(
                    "The low-pass transition already suppresses 60 Hz, so the notch "
                    "is not an independent cleanup step."
                ),
                suggestion="Keep it visible for comparison, or disable it to simplify the recipe.",
            )
        )
    aliased = [source for source in simulation.sources if source.frequency_hz > nyquist]
    if aliased:
        names = ", ".join(f"{source.label} ({source.frequency_hz:g} Hz)" for source in aliased)
        warnings.append(
            WarningMessage(
                code="source_aliasing",
                severity="warning",
                title="A planted source will alias",
                explanation=(
                    f"{names} exceeds the {nyquist:g} Hz Nyquist frequency and will "
                    "fold into the observed spectrum."
                ),
                suggestion="Predict the folded frequency before revealing the truth.",
            )
        )
    return warnings


def _design_sos(sampling_rate_hz: float, spec: PreprocessingSpec) -> NDArray[np.float64] | None:
    nyquist = sampling_rate_hz / 2
    low = spec.highpass_hz if spec.highpass_hz is not None and spec.highpass_hz < nyquist else None
    high = spec.lowpass_hz if spec.lowpass_hz is not None and spec.lowpass_hz < nyquist else None
    if low is not None and high is not None:
        return signal.butter(
            spec.filter_order, [low, high], btype="bandpass", fs=sampling_rate_hz, output="sos"
        )
    if low is not None:
        return signal.butter(
            spec.filter_order, low, btype="highpass", fs=sampling_rate_hz, output="sos"
        )
    if high is not None:
        return signal.butter(
            spec.filter_order, high, btype="lowpass", fs=sampling_rate_hz, output="sos"
        )
    return None


def apply_preprocessing(
    sensor_uv: NDArray[np.float64], sampling_rate_hz: float, spec: PreprocessingSpec
) -> FilteredData:
    """Apply reference and zero-phase IIR filtering to a copied array."""

    values = np.asarray(sensor_uv, dtype=float).copy()
    if spec.reference == "average":
        values -= values.mean(axis=0, keepdims=True)
    sos = _design_sos(sampling_rate_hz, spec)
    if sos is not None:
        values = signal.sosfiltfilt(sos, values, axis=-1)
        frequency, response = signal.sosfreqz(sos, worN=512, fs=sampling_rate_hz)
        gain_db = 20 * np.log10(np.maximum(np.abs(response), 1e-8))
    else:
        frequency = np.linspace(0, sampling_rate_hz / 2, 512)
        gain_db = np.zeros_like(frequency)
    rank = int(np.linalg.matrix_rank(values))
    return FilteredData(values, frequency, gain_db, rank)
