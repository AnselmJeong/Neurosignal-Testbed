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
    for label, korean, value in (
        ("High-pass", "고역 통과(High-pass)", preprocessing.highpass_hz),
        ("Low-pass", "저역 통과(Low-pass)", preprocessing.lowpass_hz),
        ("Notch", "노치(Notch)", preprocessing.notch_hz),
    ):
        if value is not None and value >= nyquist:
            warnings.append(
                WarningMessage(
                    code=f"{label.lower().replace('-', '_')}_above_nyquist",
                    severity="error" if label != "Notch" else "warning",
                    title=f"{korean} 주파수가 Nyquist 이상입니다",
                    explanation=(
                        f"표본화율 {simulation.sampling_rate_hz} Hz에서는 {value:g} Hz를 "
                        "따로 표현할 수 없어 이 필터 단계는 적용되지 않습니다."
                    ),
                    suggestion=(
                        f"{nyquist:g} Hz보다 낮은 주파수를 쓰거나 표본화율을 높이세요."
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
                title="여기서는 60 Hz 노치가 중복입니다",
                explanation=(
                    "저역 통과(Low-pass)가 이미 60 Hz를 크게 줄이므로, 노치는 "
                    "독립적인 정리 단계가 아닙니다."
                ),
                suggestion="비교용으로 남겨 두거나, 설정을 단순하게 하려면 끄세요.",
            )
        )
    aliased = [source for source in simulation.sources if source.frequency_hz > nyquist]
    if aliased:
        names = ", ".join(f"{source.label} ({source.frequency_hz:g} Hz)" for source in aliased)
        warnings.append(
            WarningMessage(
                code="source_aliasing",
                severity="warning",
                title="심어 둔 원천이 접힙니다(aliasing)",
                explanation=(
                    f"{names}이(가) Nyquist 주파수 {nyquist:g} Hz를 넘어서 "
                    "관측 스펙트럼의 더 낮은 주파수로 접혀 나타납니다."
                ),
                suggestion="정답을 공개하기 전에 접힌 주파수를 예측해 보세요.",
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


# Quality factor of the line-noise notch: a -3 dB bandwidth of notch_hz / 30 (2 Hz at 60 Hz).
NOTCH_QUALITY = 30.0


def _design_notch_sos(
    sampling_rate_hz: float, spec: PreprocessingSpec
) -> NDArray[np.float64] | None:
    if spec.notch_hz is None or spec.notch_hz >= sampling_rate_hz / 2:
        return None
    numerator, denominator = signal.iirnotch(spec.notch_hz, NOTCH_QUALITY, fs=sampling_rate_hz)
    return signal.tf2sos(numerator, denominator)


def apply_preprocessing(
    sensor_uv: NDArray[np.float64], sampling_rate_hz: float, spec: PreprocessingSpec
) -> FilteredData:
    """Apply reference and zero-phase IIR filtering to a copied array."""

    values = np.asarray(sensor_uv, dtype=float).copy()
    if spec.reference == "average":
        values -= values.mean(axis=0, keepdims=True)
    sections = [
        sos
        for sos in (_design_sos(sampling_rate_hz, spec), _design_notch_sos(sampling_rate_hz, spec))
        if sos is not None
    ]
    if sections:
        sos = np.vstack(sections)
        values = signal.sosfiltfilt(sos, values, axis=-1)
        frequency, response = signal.sosfreqz(sos, worN=512, fs=sampling_rate_hz)
        # sosfiltfilt runs the filter forward and backward, so the data see |H|², not |H|.
        gain_db = 40 * np.log10(np.maximum(np.abs(response), 1e-8))
    else:
        frequency = np.linspace(0, sampling_rate_hz / 2, 512)
        gain_db = np.zeros_like(frequency)
    rank = int(np.linalg.matrix_rank(values))
    return FilteredData(values, frequency, gain_db, rank)
