"""Non-destructive sensor-level QEEG analysis for imported recordings."""

from __future__ import annotations

import hashlib
import json
import shutil
import uuid
import warnings as python_warnings
from datetime import UTC, datetime
from pathlib import Path

import mne
import mne_connectivity
import numpy as np
from mne.preprocessing import ICA
from mne_connectivity import spectral_connectivity_epochs
from scipy import signal
from sklearn.exceptions import ConvergenceWarning

from neurobridge.contracts.models import (
    QeegBandPower,
    QeegConnectivityMatrix,
    QeegIcaComponent,
    QeegProvenance,
    QeegTopomap,
    RealDataQeegRequest,
    RealDataQeegResult,
    SeriesData,
    WarningMessage,
)

from .service import WORKING_COPY_NAME, _load_manifest, _sha256, default_project_root

BANDS: dict[str, tuple[float, float]] = {
    "delta": (1.0, 4.0),
    "theta": (4.0, 8.0),
    "alpha": (8.0, 13.0),
    "beta": (13.0, 30.0),
    "gamma": (30.0, 45.0),
}


def _recipe_hash(request: RealDataQeegRequest) -> str:
    payload = json.dumps(request.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _sensor_positions(raw: mne.io.BaseRaw, names: list[str]) -> list[tuple[float, float]]:
    positions: list[tuple[float, float]] = []
    for name in names:
        channel = raw.info["chs"][raw.ch_names.index(name)]
        xyz = np.asarray(channel["loc"][:3], dtype=float)
        if not np.isfinite(xyz).all() or np.linalg.norm(xyz) < 1e-7:
            return []
        positions.append((float(xyz[0]), float(xyz[1])))
    points = np.asarray(positions)
    points -= points.mean(axis=0, keepdims=True)
    scale = float(np.max(np.linalg.norm(points, axis=1)))
    if scale < 1e-9:
        return []
    return [tuple(item) for item in np.round(points / scale * 0.88, 5).tolist()]


def _connectivity(
    epochs: mne.Epochs,
    names: list[str],
    method: str,
    band: str,
) -> QeegConnectivityMatrix:
    low, high = BANDS[band]
    data = epochs.get_data(picks=names)
    result = spectral_connectivity_epochs(
        data=data,
        names=names,
        method=method,
        mode="multitaper",
        sfreq=float(epochs.info["sfreq"]),
        fmin=low,
        fmax=high,
        faverage=True,
        n_jobs=1,
        verbose=False,
    )
    matrix = np.asarray(result.get_data(output="dense")[:, :, 0], dtype=float)
    matrix = np.clip(np.abs(matrix + matrix.T), 0, 1)
    np.fill_diagonal(matrix, 0)
    return QeegConnectivityMatrix(
        method=method,  # type: ignore[arg-type]
        band=band,  # type: ignore[arg-type]
        band_hz=(low, high),
        channel_names=names,
        values=np.round(matrix, 5).tolist(),
        epoch_count=len(epochs),
    )


def _ica_components(ica: ICA, raw: mne.io.BaseRaw) -> list[QeegIcaComponent]:
    sources = ica.get_sources(raw).get_data()
    maps = np.asarray(ica.get_components(), dtype=float).T
    output: list[QeegIcaComponent] = []
    for index, component in enumerate(sources):
        frequencies, power = signal.welch(
            component,
            fs=float(raw.info["sfreq"]),
            nperseg=min(1024, component.size),
        )
        valid = (frequencies >= 1) & (frequencies <= min(45, raw.info["sfreq"] / 2))
        peak = float(frequencies[valid][np.argmax(power[valid])]) if np.any(valid) else None
        topography = maps[index]
        maximum = float(np.max(np.abs(topography)))
        if maximum > 0:
            topography = topography / maximum
        explained = ica.get_explained_variance_ratio(
            raw,
            components=index,
            ch_type="eeg",
        ).get("eeg", 0.0)
        output.append(
            QeegIcaComponent(
                index=index,
                explained_variance_pct=round(max(0.0, 100 * float(explained)), 3),
                topography=np.round(topography, 5).tolist(),
                peak_frequency_hz=None if peak is None else round(peak, 3),
            )
        )
    return output


def run_qeeg_analysis(
    project_id: str,
    request: RealDataQeegRequest,
    project_root: Path | None = None,
) -> RealDataQeegResult:
    """Filter a project working copy, optionally apply reviewed ICA exclusions, and analyze it."""

    root = project_root or default_project_root()
    project_dir = root / project_id
    if not project_dir.is_dir():
        raise ValueError(f"Project was not found: {project_id}")
    manifest, _ = _load_manifest(project_dir)
    working_name = str(manifest.get("working_copy_name", WORKING_COPY_NAME))
    working_path = project_dir / working_name
    if not working_path.is_file():
        raise ValueError(f"Project working copy was not found: {working_name}")

    raw = mne.io.read_raw_fif(working_path, preload=True, verbose=False)
    eeg_names = [
        name
        for name, kind in zip(raw.ch_names, raw.get_channel_types(), strict=True)
        if kind == "eeg" and name not in raw.info["bads"]
    ]
    if len(eeg_names) < 2:
        raise ValueError("QEEG analysis requires at least two non-bad EEG channels")
    nyquist = float(raw.info["sfreq"]) / 2
    if request.lowpass_hz >= nyquist:
        raise ValueError(f"Low-pass must remain below Nyquist ({nyquist:g} Hz)")
    if request.notch_hz is not None and request.notch_hz >= nyquist:
        raise ValueError(f"Notch frequency must remain below Nyquist ({nyquist:g} Hz)")

    analyzed = raw.copy().pick(eeg_names)
    stop = min(float(request.duration_limit_s), float(analyzed.times[-1]))
    if stop < request.epoch_duration_s * 2:
        raise ValueError("The recording is too short for two QEEG connectivity epochs")
    analyzed.crop(tmin=0, tmax=stop, include_tmax=False)
    if request.reference == "average":
        analyzed.set_eeg_reference("average", projection=False, verbose=False)
    if request.notch_hz is not None:
        analyzed.notch_filter(request.notch_hz, picks="eeg", verbose=False)
    analyzed.filter(request.highpass_hz, request.lowpass_hz, picks="eeg", verbose=False)

    warnings = [
        WarningMessage(
            code="qeeg_descriptive_not_normative",
            severity="warning",
            title="QEEG metrics are descriptive, not a diagnosis",
            explanation=(
                "Band power, ratios, coherence, and PLV describe this recording under the "
                "selected preprocessing recipe. They are not compared with a normative database."
            ),
            suggestion="Interpret them with task, age, state, montage, and recording context.",
        ),
        WarningMessage(
            code="connectivity_not_causality_real_data",
            severity="info",
            title="Coherence and PLV are not causal connections",
            explanation=(
                "Sensor mixing, reference choice, common sources, and volume conduction can "
                "inflate sensor-level connectivity."
            ),
            suggestion="Compare references and lag-sensitive metrics before making network claims.",
        ),
    ]

    positions = _sensor_positions(analyzed, eeg_names)
    if not positions:
        warnings.append(
            WarningMessage(
                code="qeeg_topomap_unavailable",
                severity="warning",
                title="Topomaps are unavailable without verified sensor positions",
                explanation=(
                    "The working copy does not contain usable positions for every EEG channel."
                ),
                suggestion=(
                    "Attach the correct acquisition montage, then import the recording again."
                ),
            )
        )

    ica_components: list[QeegIcaComponent] = []
    excluded: list[int] = []
    if request.ica_enabled:
        if len(eeg_names) < 3:
            raise ValueError("ICA requires at least three non-bad EEG channels in this workflow")
        rank_limit = len(eeg_names) - (1 if request.reference == "average" else 0)
        component_count = min(request.ica_component_count, rank_limit)
        fit_params = {"extended": True} if request.ica_method == "infomax" else None
        ica = ICA(
            n_components=component_count,
            method=request.ica_method,
            fit_params=fit_params,
            random_state=97,
            max_iter="auto",
        )
        with python_warnings.catch_warnings(record=True) as caught_warnings:
            python_warnings.simplefilter("always", ConvergenceWarning)
            ica.fit(
                analyzed,
                picks="eeg",
                reject_by_annotation=request.reject_by_annotation,
                verbose=False,
            )
        if any(isinstance(item.message, ConvergenceWarning) for item in caught_warnings):
            warnings.append(
                WarningMessage(
                    code="ica_did_not_converge",
                    severity="warning",
                    title="ICA did not converge",
                    explanation=(
                        "The optimizer reached its iteration limit, so the displayed component "
                        "separation may be unstable."
                    ),
                    suggestion=(
                        "Try a different method or component count before excluding components."
                    ),
                )
            )
        ica_components = _ica_components(ica, analyzed)
        invalid = [index for index in request.ica_exclude_components if index >= component_count]
        if invalid:
            raise ValueError(f"ICA exclusion indices do not exist: {invalid}")
        excluded = sorted(request.ica_exclude_components)
        if excluded:
            ica.apply(analyzed, exclude=excluded, verbose=False)
        warnings.append(
            WarningMessage(
                code="ica_manual_review_required",
                severity="warning",
                title="ICA exclusions require human review",
                explanation=(
                    "Component order and topography are data-specific. NeuroSignal never treats a "
                    "component index as universally artifactual."
                ),
                suggestion="Inspect component maps, spectra, traces, and known artifact channels.",
            )
        )

    n_fft = min(2048, analyzed.n_times)
    spectrum = analyzed.compute_psd(
        method="welch",
        fmin=max(1.0, request.highpass_hz),
        fmax=min(45.0, request.lowpass_hz, nyquist - 0.01),
        n_fft=n_fft,
        n_per_seg=n_fft,
        n_overlap=n_fft // 2,
        picks="eeg",
        verbose=False,
    )
    psd_v2_hz, frequencies = spectrum.get_data(return_freqs=True)
    psd = np.asarray(psd_v2_hz, dtype=float) * 1e12
    total_power = np.trapezoid(psd, frequencies, axis=1)
    band_powers: list[QeegBandPower] = []
    relative_by_band: dict[str, np.ndarray] = {}
    for name, (low, high) in BANDS.items():
        keep = (frequencies >= low) & (frequencies < high)
        absolute = (
            np.trapezoid(psd[:, keep], frequencies[keep], axis=1)
            if np.count_nonzero(keep) >= 2
            else np.zeros(len(eeg_names))
        )
        relative = np.divide(
            absolute,
            total_power,
            out=np.zeros_like(absolute),
            where=total_power > np.finfo(float).eps,
        )
        relative_by_band[name] = relative
        band_powers.append(
            QeegBandPower(
                name=name,  # type: ignore[arg-type]
                low_hz=low,
                high_hz=high,
                mean_absolute_power_uv2=round(float(np.mean(absolute)), 6),
                mean_relative_power=round(float(np.mean(relative)), 6),
                absolute_power_by_channel_uv2=np.round(absolute, 6).tolist(),
                relative_power_by_channel=np.round(relative, 6).tolist(),
            )
        )

    theta = relative_by_band["theta"]
    beta = relative_by_band["beta"]
    ratios = np.divide(
        theta,
        beta,
        out=np.full_like(theta, np.nan),
        where=beta > np.finfo(float).eps,
    )
    finite_ratios = ratios[np.isfinite(ratios)]
    ratio_by_channel = {
        name: (round(float(value), 5) if np.isfinite(value) else None)
        for name, value in zip(eeg_names, ratios, strict=True)
    }

    epochs = mne.make_fixed_length_epochs(
        analyzed,
        duration=request.epoch_duration_s,
        preload=True,
        reject_by_annotation=request.reject_by_annotation,
        verbose=False,
    )
    if len(epochs) < 2:
        raise ValueError("Fewer than two artifact-free epochs remain for connectivity analysis")
    connectivity_names = eeg_names[: request.max_connectivity_channels]
    if len(connectivity_names) < len(eeg_names):
        warnings.append(
            WarningMessage(
                code="connectivity_channel_subset",
                severity="info",
                title="Connectivity view uses a channel subset",
                explanation=(
                    f"The matrix uses the first {len(connectivity_names)} non-bad EEG channels "
                    f"of {len(eeg_names)} to keep the review legible."
                ),
                suggestion="Export the result JSON for the exact channel list.",
            )
        )
    coherence = _connectivity(epochs, connectivity_names, "coh", request.connectivity_band)
    plv = _connectivity(epochs, connectivity_names, "plv", request.connectivity_band)

    trace_stop = min(analyzed.n_times, int(analyzed.info["sfreq"] * 10))
    stride = max(1, trace_stop // 1000)
    trace_data = analyzed.get_data(start=0, stop=trace_stop)[:, ::stride] * 1e6
    time_s = analyzed.times[:trace_stop:stride]
    topomaps = [
        QeegTopomap(
            band=name,  # type: ignore[arg-type]
            channel_names=eeg_names,
            relative_power=np.round(relative_by_band[name], 6).tolist(),
            sensor_positions=positions,
            available=bool(positions),
        )
        for name in BANDS
    ]
    run_id = f"qeeg_{uuid.uuid4().hex[:12]}"
    run_dir = project_dir / "analyses" / run_id
    cleaned_path = run_dir / "cleaned_raw.fif"
    result_path = run_dir / "qeeg_result.json"
    result = RealDataQeegResult(
        run_id=run_id,
        state="completed",
        request=request,
        channel_names=eeg_names,
        sampling_rate_hz=float(analyzed.info["sfreq"]),
        analyzed_duration_s=round(float(analyzed.times[-1]), 4),
        trace=SeriesData(
            x=np.round(time_s, 5).tolist(),
            series={
                name: np.round(values, 4).tolist()
                for name, values in zip(eeg_names[:8], trace_data[:8], strict=True)
            },
            x_unit="s",
            y_unit="µV",
        ),
        frequency_hz=np.round(frequencies, 5).tolist(),
        mean_psd_uv2_hz=np.round(np.mean(psd, axis=0), 8).tolist(),
        psd_by_channel_uv2_hz={
            name: np.round(values, 8).tolist() for name, values in zip(eeg_names, psd, strict=True)
        },
        band_powers=band_powers,
        theta_beta_ratio_by_channel=ratio_by_channel,
        mean_theta_beta_ratio=(
            round(float(np.mean(finite_ratios)), 5) if finite_ratios.size else None
        ),
        topomaps=topomaps,
        coherence=coherence,
        plv=plv,
        ica_components=ica_components,
        ica_excluded_components=excluded,
        cleaned_fif_path=str(cleaned_path),
        result_json_path=str(result_path),
        warnings=warnings,
        provenance=QeegProvenance(
            created_at=datetime.now(UTC),
            mne_version=mne.__version__,
            mne_connectivity_version=mne_connectivity.__version__,
            source_working_copy=working_name,
            source_sha256=_sha256(working_path),
            analyzed_duration_s=round(float(analyzed.times[-1]), 4),
            recipe_hash=_recipe_hash(request),
        ),
    )
    staging_dir = project_dir / "analyses" / f".{run_id}.partial"
    staging_dir.mkdir(parents=True)
    try:
        analyzed.save(staging_dir / cleaned_path.name, overwrite=False, verbose=False)
        (staging_dir / result_path.name).write_text(
            json.dumps(result.model_dump(mode="json"), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        staging_dir.replace(run_dir)
    except Exception:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise
    return result
