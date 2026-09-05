"""Inference sees EEG, geometry and analysis settings only. Evaluation runs afterward."""

from __future__ import annotations

import mne
import numpy as np
from mne.minimum_norm import (
    apply_inverse_raw,
    make_inverse_operator,
    make_inverse_resolution_matrix,
)
from numpy.typing import NDArray
from scipy.optimize import linear_sum_assignment
from scipy.signal import periodogram
from scipy.spatial.distance import cdist

from neurobridge.contracts.models import (
    SourceBandEvaluation,
    SourceEvaluation,
    SourceInverseSettings,
    SourceMatch,
    SourcePeak,
    SourcePowerMap,
    SourceRoi,
)

# Fixed analysis bands, independent of any planted waveform or recipe frequency.
BANDS = (
    ("theta", "Theta · 4–8 Hz", 4.0, 8.0),
    ("alpha", "Alpha · 8–13 Hz", 8.0, 13.0),
    ("beta", "Beta · 13–30 Hz", 13.0, 30.0),
    ("broadband", "Broadband · 4–30 Hz", 4.0, 30.0),
)


def detect_peaks(
    power: NDArray[np.float64],
    positions_mm: NDArray[np.float64],
    settings: SourceInverseSettings,
) -> list[int]:
    """Spatial maxima on nearest-neighbor grid, then distance suppression.

    Equal-height connected plateaus collapse to one deterministic representative.
    A constant/zero field has no distinct peak. Threshold is descriptive, not a p-value.
    """
    if len(power) == 0 or not np.all(np.isfinite(power)) or np.max(power) <= 0:
        return []
    maximum = float(np.max(power))
    relative = power / maximum
    if float(np.ptp(relative)) <= 1e-10:
        return []
    distances = cdist(positions_mm, positions_mm)
    nonzero = distances[distances > 1e-6]
    if not len(nonzero):
        return [0]
    neighbors = (distances <= float(nonzero.min()) * 1.01) & (distances > 0)
    visited: set[int] = set()
    candidates: list[int] = []
    for index in range(len(power)):
        if index in visited or relative[index] < settings.peak_threshold:
            continue
        plateau = {index}
        pending = [index]
        boundary: set[int] = set()
        while pending:
            current = pending.pop()
            for adjacent in np.flatnonzero(neighbors[current]):
                other = int(adjacent)
                if abs(relative[other] - relative[index]) <= 1e-10:
                    if other not in plateau:
                        plateau.add(other)
                        pending.append(other)
                else:
                    boundary.add(other)
        visited.update(plateau)
        if boundary and all(relative[other] < relative[index] for other in boundary):
            candidates.append(min(plateau))
    accepted: list[int] = []
    for index in sorted(candidates, key=lambda i: (-power[i], i)):
        if all(distances[index, other] >= settings.peak_separation_mm for other in accepted):
            accepted.append(index)
    return accepted


def power_maps_from_currents(
    currents_am: NDArray[np.float64],
    sampling_rate_hz: float,
    positions_mm: NDArray[np.float64],
    settings: SourceInverseSettings,
) -> list[SourcePowerMap]:
    frequencies, density = periodogram(
        currents_am * 1e9,
        fs=sampling_rate_hz,
        window="hann",
        detrend="constant",
        scaling="density",
        axis=-1,
    )
    bin_width = frequencies[1] - frequencies[0]
    numerical_floor = float(density.sum(axis=1).max() * bin_width) * np.finfo(float).eps * 100
    maps = []
    for band_id, label, low, high in BANDS:
        # Half-open bands prevent double counting at 8 and 13 Hz.
        power = density[:, (frequencies >= low) & (frequencies < high)].sum(axis=1)
        power *= bin_width
        # Discard floating-point spectral residue, never an estimated noise significance cutoff.
        power[power <= numerical_floor] = 0
        maximum = float(power.max())
        relative = power / maximum if maximum > 0 else np.zeros_like(power)
        peaks = [
            SourcePeak(
                id=f"{band_id}-v{index}",
                vertex_index=index,
                position_mm=tuple(positions_mm[index]),
                power_nam2=float(power[index]),
                relative_power=float(relative[index]),
            )
            for index in detect_peaks(power, positions_mm, settings)
        ]
        maps.append(
            SourcePowerMap(
                id=band_id,
                label=label,
                low_hz=low,
                high_hz=high,
                power_nam2=power.tolist(),
                relative_power=relative.tolist(),
                peaks=peaks,
            )
        )
    return maps


def infer_sources(
    raw: mne.io.BaseRaw,
    forward: mne.Forward,
    settings: SourceInverseSettings,
) -> tuple[NDArray[np.float64], NDArray[np.float64], list[SourcePowerMap]]:
    """No source count, truth positions, latent signals or generating recipe accepted."""
    inverse = make_inverse_operator(
        raw.info,
        forward,
        mne.make_ad_hoc_cov(raw.info, verbose=False),
        loose=0,
        depth=None,
        verbose=False,
    )
    estimate = apply_inverse_raw(
        raw,
        inverse,
        lambda2=settings.lambda2,
        method="MNE",
        verbose=False,
    )
    positions = forward["src"][0]["rr"][estimate.vertices[0]] * 1000
    maps = power_maps_from_currents(estimate.data, raw.info["sfreq"], positions, settings)
    resolution = make_inverse_resolution_matrix(
        forward,
        inverse,
        method="MNE",
        lambda2=settings.lambda2,
        verbose=False,
    )
    return estimate.data, np.asarray(resolution), maps


def evaluate_localization(
    maps: list[SourcePowerMap],
    truth: list[SourceRoi],
    match_radius_mm: float = 40.0,
) -> SourceEvaluation:
    """One-to-one spatial matching AFTER detection; never selects or moves peaks.

    Maximize valid matches, then minimize distance, with explicit dummy assignments.
    Broadband is exploratory and excluded to avoid counting the same source twice.
    """
    evaluations = []
    all_errors: list[float] = []
    for band in maps:
        if band.id == "broadband":
            continue
        sources = [roi for roi in truth if band.low_hz <= roi.frequency_hz < band.high_hz]
        peaks = band.peaks
        matches = []
        used_sources: set[int] = set()
        used_peaks: set[int] = set()
        if sources and peaks:
            distances = cdist(
                np.asarray([roi.position_mm for roi in sources]),
                np.asarray([peak.position_mm for peak in peaks]),
            )
            penalty = (len(sources) + 1) * (match_radius_mm + 1)
            cost = np.full((len(sources), len(peaks) + len(sources)), penalty)
            cost[:, : len(peaks)] = np.where(
                distances <= match_radius_mm,
                distances,
                penalty * 2,
            )
            rows, columns = linear_sum_assignment(cost)
            for row, column in zip(rows, columns, strict=True):
                if column < len(peaks) and distances[row, column] <= match_radius_mm:
                    error = float(distances[row, column])
                    used_sources.add(int(row))
                    used_peaks.add(int(column))
                    all_errors.append(error)
                    matches.append(
                        SourceMatch(
                            roi_id=sources[row].id,
                            peak_id=peaks[column].id,
                            distance_mm=round(error, 2),
                        )
                    )
        evaluations.append(
            SourceBandEvaluation(
                band_id=band.id,
                matches=matches,
                missed_roi_ids=[roi.id for i, roi in enumerate(sources) if i not in used_sources],
                unmatched_peak_ids=[peak.id for i, peak in enumerate(peaks) if i not in used_peaks],
                mean_error_mm=round(float(np.mean([m.distance_mm for m in matches])), 2)
                if matches
                else None,
            )
        )
    return SourceEvaluation(
        match_radius_mm=match_radius_mm,
        bands=evaluations,
        matched_count=sum(len(band.matches) for band in evaluations),
        missed_count=sum(len(band.missed_roi_ids) for band in evaluations),
        unmatched_peak_count=sum(len(band.unmatched_peak_ids) for band in evaluations),
        mean_error_mm=round(float(np.mean(all_errors)), 2) if all_errors else None,
        max_error_mm=round(float(np.max(all_errors)), 2) if all_errors else None,
        outside_band_roi_ids=[
            roi.id
            for roi in truth
            if not any(
                b.low_hz <= roi.frequency_hz < b.high_hz for b in maps if b.id != "broadband"
            )
        ],
    )
