"""Small, deterministic MNE forward/inverse benchmark for the source-modeling lab.

The geometry is deliberately a spherical educational template.  It is useful for
testing the full MNE path and visualizing leakage, but is never represented as
an individual's anatomy or a clinically meaningful localization.
"""

from __future__ import annotations

import hashlib
import uuid

import mne
import numpy as np
import scipy
from numpy.typing import NDArray

from neurobridge import __version__
from neurobridge.contracts.models import (
    Provenance,
    SeriesData,
    SourceModelRecipe,
    SourceModelResult,
    SourceModelSimulation,
    SourceReconstructionScores,
    SourceRoi,
    SourceTopography,
    WarningMessage,
)
from neurobridge.source_modeling.localization import evaluate_localization, infer_sources

CHANNEL_NAMES = [
    "Fp1",
    "Fp2",
    "F3",
    "F4",
    "C3",
    "C4",
    "P3",
    "P4",
    "O1",
    "O2",
    "Fz",
    "Cz",
    "Pz",
    "Oz",
]
ROI_SPECS = (
    ("frontal_l", "Frontal L", (-0.04, 0.00, 0.04)),
    ("frontal_r", "Frontal R", (0.04, 0.00, 0.04)),
    ("parietal_l", "Parietal L", (-0.04, -0.04, 0.00)),
    ("parietal_r", "Parietal R", (0.04, -0.04, 0.00)),
)


def _correlation(left: NDArray[np.float64], right: NDArray[np.float64]) -> float:
    if np.std(left) <= np.finfo(float).eps or np.std(right) <= np.finfo(float).eps:
        return 0.0
    return float(np.corrcoef(left, right)[0, 1])


def _nearest_vertices(source_rr: NDArray[np.float64]) -> list[int]:
    return [
        int(np.argmin(np.linalg.norm(source_rr - np.asarray(position), axis=1)))
        for _, _, position in ROI_SPECS
    ]


def _build_forward(recipe: SourceModelRecipe):
    info = mne.create_info(CHANNEL_NAMES, recipe.sampling_rate_hz, ch_types="eeg")
    info.set_montage("standard_1020")
    source_space = mne.setup_volume_source_space(
        subject=None,
        pos=float(recipe.grid_spacing_mm),
        sphere=(0.0, 0.0, 0.0, 0.08),
        exclude=0.01,
        verbose=False,
    )
    sphere = mne.make_sphere_model(r0=(0.0, 0.0, 0.0), head_radius=0.09, verbose=False)
    forward = mne.make_forward_solution(
        info,
        trans=None,
        src=source_space,
        bem=sphere,
        meg=False,
        eeg=True,
        verbose=False,
    )
    return (
        info,
        source_space,
        mne.convert_forward_solution(forward, force_fixed=True, use_cps=False, verbose=False),
    )


def _latent_time_courses(
    recipe: SourceModelRecipe,
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    sample_count = int(round(recipe.duration_s * recipe.sampling_rate_hz))
    time_s = np.arange(sample_count, dtype=float) / recipe.sampling_rate_hz
    alpha = 2 * np.pi * recipe.alpha_frequency_hz * time_s
    lag = np.deg2rad(recipe.phase_lag_deg)
    amplitude = recipe.source_amplitude_nam * 1e-9
    values = np.asarray(
        [
            amplitude * np.sin(alpha),
            amplitude * 0.88 * np.sin(alpha + lag),
            amplitude * 0.58 * np.sin(2 * np.pi * 7.0 * time_s + 0.45),
            amplitude * 0.42 * np.sin(2 * np.pi * 18.0 * time_s - 0.7),
        ],
        dtype=float,
    )
    return time_s, values


def _source_signal_specs(recipe: SourceModelRecipe) -> list[tuple[float, float, float]]:
    """Frequency, amplitude, and phase for each planted ROI proxy."""
    return [
        (recipe.alpha_frequency_hz, recipe.source_amplitude_nam, 0.0),
        (
            recipe.alpha_frequency_hz,
            recipe.source_amplitude_nam * 0.88,
            recipe.phase_lag_deg,
        ),
        (7.0, recipe.source_amplitude_nam * 0.58, float(np.rad2deg(0.45))),
        (18.0, recipe.source_amplitude_nam * 0.42, float(np.rad2deg(-0.7))),
    ]


def _series(
    time_s: NDArray[np.float64], names: list[str], values: NDArray[np.float64], unit: str
) -> SeriesData:
    return SeriesData(
        x=np.round(time_s, 5).tolist(),
        series={name: np.round(row, 6).tolist() for name, row in zip(names, values, strict=True)},
        x_unit="s",
        y_unit=unit,
    )


def _sensor_positions(info: mne.Info) -> list[tuple[float, float]]:
    montage = info.get_montage()
    assert montage is not None
    positions = montage.get_positions()["ch_pos"]
    xy = np.asarray([positions[name][:2] for name in CHANNEL_NAMES], dtype=float)
    xy /= max(float(np.abs(xy).max()), np.finfo(float).eps)
    return [tuple(np.round(point, 4)) for point in xy]


def _warnings(scores: SourceReconstructionScores) -> list[WarningMessage]:
    return [
        WarningMessage(
            code="template_geometry_not_individual",
            severity="warning",
            title="Illustrative template, not an individual head model",
            explanation=(
                "This lesson uses a 14-channel 10–20 montage and a spherical volume template. "
                "Its ROI names describe planted simulation vertices, not anatomy recovered "
                "from a person."
            ),
            suggestion=(
                "For real data, require digitization, a justified head model, and a documented "
                "coregistration."
            ),
        ),
        WarningMessage(
            code="source_leakage_caveat",
            severity="warning",
            title="Power peaks can merge, move or reflect noise",
            explanation=(
                "14 average-referenced channels supply at most 13 independent measurements. "
                "Many source configurations can explain them. Relative power thresholds "
                "detect spatial maxima but do not test statistical significance."
            ),
            suggestion=(
                "Change noise, phase, regularization and threshold. Reveal truth only after "
                "inspecting all detected peaks, including extra and missing detections."
            ),
        ),
    ]


def _forward_simulation(recipe: SourceModelRecipe):
    info, source_space, forward = _build_forward(recipe)
    source_rr = source_space[0]["rr"][source_space[0]["vertno"]]
    roi_indices = _nearest_vertices(source_rr)
    time_s, latent_roi_am = _latent_time_courses(recipe)
    source_data = np.zeros((len(source_rr), len(time_s)), dtype=float)
    source_data[roi_indices] = latent_roi_am
    source_estimate = mne.VolSourceEstimate(
        source_data, [source_space[0]["vertno"]], tmin=0.0, tstep=1 / recipe.sampling_rate_hz
    )
    projected = mne.simulation.simulate_raw(info, source_estimate, forward=forward, verbose=False)
    rng = np.random.default_rng(recipe.seed)
    sensor_data = projected.get_data() + rng.normal(
        0.0, recipe.sensor_noise_uv * 1e-6, size=projected.get_data().shape
    )
    raw = mne.io.RawArray(sensor_data, info, verbose=False)
    raw.set_eeg_reference("average", projection=True, verbose=False)
    raw.apply_proj(verbose=False)
    return info, source_space, forward, source_rr, roi_indices, time_s, latent_roi_am, raw


def _template_description(count: int, spacing: int) -> str:
    return (
        f"Spherical 90 mm teaching model with {count} fixed-orientation candidate points "
        f"on a {spacing} mm grid. Matched forward/inverse geometry; no individual anatomy."
    )


def _source_rois(
    recipe: SourceModelRecipe,
    source_rr: NDArray[np.float64],
    roi_indices: list[int],
) -> list[SourceRoi]:
    return [
        SourceRoi(
            id=roi_id,
            label=label,
            position_mm=tuple(np.round(source_rr[index] * 1000, 1)),
            frequency_hz=frequency_hz,
            amplitude_nam=round(amplitude_nam, 2),
            phase_deg=round(phase_deg, 1),
        )
        for ((roi_id, label, _), index, (frequency_hz, amplitude_nam, phase_deg)) in zip(
            ROI_SPECS, roi_indices, _source_signal_specs(recipe), strict=True
        )
    ]


def _provenance(recipe: SourceModelRecipe, raw: mne.io.BaseRaw) -> Provenance:
    recipe_hash = hashlib.sha256(
        recipe.model_dump_json(exclude_none=True).encode("utf-8")
    ).hexdigest()[:12]
    return Provenance(
        recipe_hash=recipe_hash,
        engine_version=__version__,
        numpy_version=np.__version__,
        scipy_version=scipy.__version__,
        seed=recipe.seed,
        sampling_rate_hz=recipe.sampling_rate_hz,
        reference="average (projector applied)",
        rank=int(np.linalg.matrix_rank(raw.get_data())),
    )


def simulate_source_model(recipe: SourceModelRecipe) -> SourceModelSimulation:
    """Generate the benchmark's sensor EEG without running an inverse solution."""
    info, _, _, source_rr, roi_indices, time_s, _, raw = _forward_simulation(recipe)
    return SourceModelSimulation(
        run_id=f"source_input_{uuid.uuid4().hex[:10]}",
        state="completed",
        recipe=recipe,
        template_description=_template_description(len(source_rr), recipe.grid_spacing_mm),
        rois=_source_rois(recipe, source_rr, roi_indices),
        candidate_positions_mm=[tuple(np.round(point * 1000, 1)) for point in source_rr],
        sensor_trace=_series(time_s, CHANNEL_NAMES, raw.get_data() * 1e6, "µV"),
        sensor_positions=_sensor_positions(info),
        provenance=_provenance(recipe, raw),
    )


def run_source_model_benchmark(recipe: SourceModelRecipe) -> SourceModelResult:
    """Project known volume-source signals, reconstruct them, and quantify cross-talk."""

    (
        _,
        _,
        forward,
        source_rr,
        roi_indices,
        time_s,
        latent_roi_am,
        raw,
    ) = _forward_simulation(recipe)
    # Inference is completed without passing any planted waveforms, positions or count.
    reconstructed, resolution, power_maps = infer_sources(raw, forward, recipe.inverse)
    # Everything below this boundary is simulation evaluation / diagnostic output only.
    reconstructed_roi_am = reconstructed[roi_indices]
    roi_names = [label for _, label, _ in ROI_SPECS]
    correlations: dict[str, float] = {}
    for (roi_id, _, _), latent in zip(ROI_SPECS, latent_roi_am, strict=True):
        roi_index = [item[0] for item in ROI_SPECS].index(roi_id)
        correlations[roi_id] = round(
            abs(_correlation(latent, reconstructed_roi_am[roi_index])), 4
        )
    rois = _source_rois(recipe, source_rr, roi_indices)
    roi_resolution = np.asarray(resolution)[np.ix_(roi_indices, roi_indices)]
    diagonal = np.maximum(np.abs(np.diag(roi_resolution)), np.finfo(float).eps)
    leakage = np.abs(roi_resolution / diagonal[None, :])
    np.fill_diagonal(leakage, 1.0)
    cross_talk = leakage[~np.eye(len(rois), dtype=bool)]
    score = SourceReconstructionScores(
        mean_roi_correlation=round(float(np.mean(list(correlations.values()))), 4),
        roi_correlations=correlations,
        max_roi_cross_talk=round(float(np.max(cross_talk)), 4),
        leakage_matrix=np.round(leakage, 4).tolist(),
    )
    # Match the average reference used by the displayed sensor EEG.
    lead_field = forward["sol"]["data"].copy()
    lead_field -= lead_field.mean(axis=0, keepdims=True)
    topographies = []
    for index, column in enumerate(lead_field.T):
        normalized = column / max(float(np.max(np.abs(column))), np.finfo(float).eps)
        topographies.append(
            SourceTopography(
                roi_id=f"v{index}", label=f"Candidate {index}",
                values=np.round(normalized, 4).tolist()
            )
        )
    return SourceModelResult(
        run_id=f"source_{uuid.uuid4().hex[:10]}",
        state="completed",
        recipe=recipe,
        warnings=_warnings(score),
        template_description=_template_description(len(source_rr), recipe.grid_spacing_mm),
        forward_method=(
            "MNE EEG forward solution · four-layer sphere · standard 10–20 (14 channels)"
        ),
        inverse_method=(
            f"MNE minimum-norm estimate · λ²={recipe.inverse.lambda2:.4g} · "
            "average-reference projector · "
            "ad-hoc covariance"
        ),
        rois=rois,
        candidate_positions_mm=[tuple(np.round(point * 1000, 1)) for point in source_rr],
        power_maps=power_maps,
        candidate_time_courses=_series(
            time_s, [f"v{i}" for i in range(len(source_rr))], reconstructed * 1e9, "nAm",
        ),
        evaluation=evaluate_localization(power_maps, rois),
        sensor_trace=_series(time_s, CHANNEL_NAMES, raw.get_data() * 1e6, "µV"),
        latent_roi_time_courses=_series(time_s, roi_names, latent_roi_am * 1e9, "nAm"),
        reconstructed_roi_time_courses=_series(
            time_s, roi_names, reconstructed_roi_am * 1e9, "nAm"
        ),
        sensor_topographies=topographies,
        sensor_positions=_sensor_positions(raw.info),
        scores=score,
        provenance=_provenance(recipe, raw),
    )
