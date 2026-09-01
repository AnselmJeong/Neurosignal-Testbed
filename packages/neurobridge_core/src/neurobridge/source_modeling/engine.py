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
from mne.minimum_norm import (
    apply_inverse_epochs,
    make_inverse_operator,
    make_inverse_resolution_matrix,
)
from numpy.typing import NDArray

from neurobridge import __version__
from neurobridge.contracts.models import (
    Provenance,
    SeriesData,
    SourceModelRecipe,
    SourceModelResult,
    SourceReconstructionScores,
    SourceRoi,
    SourceTopography,
    WarningMessage,
)

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
        pos=40.0,
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
            title="Inverse estimates spread activity between ROIs",
            explanation=(
                f"The MNE resolution matrix has up to {scores.max_roi_cross_talk * 100:.1f}% "
                "cross-talk between these ROI proxies. A reconstructed edge can reflect "
                "field spread "
                "or inverse leakage."
            ),
            suggestion=(
                "Compare latent, sensor, and reconstructed time courses before interpreting "
                "an ROI result."
            ),
        ),
    ]


def run_source_model_benchmark(recipe: SourceModelRecipe) -> SourceModelResult:
    """Project known volume-source signals, reconstruct them, and quantify cross-talk."""

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
    events = np.asarray([[0, 0, 1]])
    epochs = mne.Epochs(
        raw,
        events,
        event_id={"template": 1},
        tmin=0,
        tmax=time_s[-1],
        baseline=None,
        preload=True,
        verbose=False,
    )
    covariance = mne.make_ad_hoc_cov(raw.info, verbose=False)
    inverse = make_inverse_operator(
        raw.info, forward, covariance, loose=0, depth=None, verbose=False
    )
    reconstructed = apply_inverse_epochs(
        epochs, inverse, lambda2=1 / 9, method=recipe.inverse_method, verbose=False
    )[0].data
    resolution = make_inverse_resolution_matrix(
        forward, inverse, method=recipe.inverse_method, lambda2=1 / 9, verbose=False
    )
    reconstructed_roi_am = reconstructed[roi_indices]
    roi_names = [label for _, label, _ in ROI_SPECS]
    rois = [
        SourceRoi(
            id=roi_id,
            label=label,
            position_mm=tuple(np.round(source_rr[index] * 1000, 1)),
        )
        for (roi_id, label, _), index in zip(ROI_SPECS, roi_indices, strict=True)
    ]
    correlations: dict[str, float] = {}
    location_errors: dict[str, float] = {}
    for roi, latent in zip(rois, latent_roi_am, strict=True):
        per_vertex = np.asarray([abs(_correlation(latent, row)) for row in reconstructed])
        recovered_index = int(np.argmax(per_vertex))
        correlations[roi.id] = round(
            abs(_correlation(latent, reconstructed_roi_am[rois.index(roi)])), 4
        )
        location_errors[roi.id] = round(
            float(
                np.linalg.norm(source_rr[recovered_index] - np.asarray(roi.position_mm) / 1000)
                * 1000
            ),
            2,
        )
    roi_resolution = np.asarray(resolution)[np.ix_(roi_indices, roi_indices)]
    diagonal = np.maximum(np.abs(np.diag(roi_resolution)), np.finfo(float).eps)
    leakage = np.abs(roi_resolution / diagonal[None, :])
    np.fill_diagonal(leakage, 1.0)
    cross_talk = leakage[~np.eye(len(rois), dtype=bool)]
    score = SourceReconstructionScores(
        mean_roi_correlation=round(float(np.mean(list(correlations.values()))), 4),
        roi_correlations=correlations,
        mean_location_error_mm=round(float(np.mean(list(location_errors.values()))), 2),
        max_location_error_mm=round(float(np.max(list(location_errors.values()))), 2),
        location_error_mm=location_errors,
        max_roi_cross_talk=round(float(np.max(cross_talk)), 4),
        leakage_matrix=np.round(leakage, 4).tolist(),
        benchmark_passed=(
            float(np.mean(list(correlations.values()))) >= 0.6
            and float(np.max(list(location_errors.values()))) <= 60.0
        ),
    )
    lead_field = forward["sol"]["data"][:, roi_indices]
    topographies = []
    for roi, column in zip(rois, lead_field.T, strict=True):
        normalized = column / max(float(np.max(np.abs(column))), np.finfo(float).eps)
        topographies.append(
            SourceTopography(
                roi_id=roi.id, label=roi.label, values=np.round(normalized, 4).tolist()
            )
        )
    recipe_hash = hashlib.sha256(
        recipe.model_dump_json(exclude_none=True).encode("utf-8")
    ).hexdigest()[:12]
    return SourceModelResult(
        run_id=f"source_{uuid.uuid4().hex[:10]}",
        state="completed",
        recipe=recipe,
        warnings=_warnings(score),
        template_description=(
            "Spherical 90 mm educational volume template with 26 fixed-orientation "
            "source vertices; "
            "not an individual anatomical model."
        ),
        forward_method=(
            "MNE EEG forward solution · four-layer sphere · standard 10–20 (14 channels)"
        ),
        inverse_method=(
            "MNE minimum-norm estimate · λ²=1/9 · average-reference projector · "
            "ad-hoc covariance"
        ),
        rois=rois,
        sensor_trace=_series(time_s, CHANNEL_NAMES, raw.get_data() * 1e6, "µV"),
        latent_roi_time_courses=_series(time_s, roi_names, latent_roi_am * 1e9, "nAm"),
        reconstructed_roi_time_courses=_series(
            time_s, roi_names, reconstructed_roi_am * 1e9, "nAm"
        ),
        sensor_topographies=topographies,
        sensor_positions=_sensor_positions(raw.info),
        scores=score,
        provenance=Provenance(
            recipe_hash=recipe_hash,
            engine_version=__version__,
            numpy_version=np.__version__,
            scipy_version=scipy.__version__,
            seed=recipe.seed,
            sampling_rate_hz=recipe.sampling_rate_hz,
            reference="average (projector applied)",
            rank=int(np.linalg.matrix_rank(raw.get_data())),
        ),
    )
