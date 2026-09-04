"""Local-only real-data workflow with an immutable source and FIF derivative.

The service accepts a user-selected local path. It opens that path read-only,
records a fingerprint, and writes all derived data under the NeuroSignal local
project directory. No preprocessing function ever receives the source path as
an output destination.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

import mne
import numpy as np
from scipy import signal

from neurobridge.contracts.models import (
    EegbciImportRequest,
    EegbciLessonStatus,
    LocalImportRequest,
    RealDataImportResult,
    RealDataProject,
    RealDataQcSummary,
    RecordingInspection,
    ReportExportResult,
    WarningMessage,
)

CURRENT_PROJECT_SCHEMA = 2
MANIFEST_NAME = "project.json"
WORKING_COPY_NAME = "recording_raw.fif"
REPORT_NAME = "qc-report.html"
FORMAT_BY_SUFFIX = {
    ".fif": "fif",
    ".edf": "edf",
    ".bdf": "bdf",
    ".vhdr": "brainvision",
    ".set": "eeglab",
}


def default_project_root() -> Path:
    configured = os.environ.get("NEUROSIGNAL_PROJECTS_DIR") or os.environ.get(
        "NEUROBRIDGE_PROJECTS_DIR"
    )
    if configured:
        return Path(configured).expanduser()
    app_support = Path.home() / "Library" / "Application Support"
    current = app_support / "NeuroSignal" / "projects"
    legacy = app_support / "NeuroBridge EEG Lab" / "projects"
    return legacy if legacy.exists() and not current.exists() else current


def _eegbci_cache_root(cache_directory: str | None) -> Path:
    if cache_directory:
        return Path(cache_directory).expanduser()
    configured = mne.get_config("MNE_DATASETS_EEGBCI_PATH") or mne.get_config("MNE_DATA")
    return Path(configured) if configured else Path.home() / "mne_data"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolve_source(source_path: str) -> Path:
    source = Path(source_path).expanduser().resolve()
    if not source.exists():
        raise ValueError(f"Source file was not found: {source}")
    if not source.is_file():
        raise ValueError(f"Source path is not a file: {source}")
    if source.suffix.lower() not in FORMAT_BY_SUFFIX:
        supported = ", ".join(sorted(FORMAT_BY_SUFFIX))
        raise ValueError(
            f"Unsupported EEG format '{source.suffix or '(none)'}'. Supported: {supported}"
        )
    return source


def _read_raw(source: Path, *, preload: bool = False):
    suffix = source.suffix.lower()
    if suffix == ".fif":
        return mne.io.read_raw_fif(source, preload=preload, verbose=False)
    if suffix in {".edf", ".bdf"}:
        return mne.io.read_raw_edf(source, preload=preload, verbose=False)
    if suffix == ".vhdr":
        return mne.io.read_raw_brainvision(source, preload=preload, verbose=False)
    if suffix == ".set":
        return mne.io.read_raw_eeglab(source, preload=preload, verbose=False)
    raise ValueError(f"Unsupported EEG format: {source.suffix}")


def _channel_types(raw: mne.io.BaseRaw) -> dict[str, int]:
    counts: dict[str, int] = {}
    for kind in raw.get_channel_types():
        counts[kind] = counts.get(kind, 0) + 1
    return counts


def _inspection_warnings(raw: mne.io.BaseRaw) -> list[WarningMessage]:
    warnings = [
        WarningMessage(
            code="real_data_no_reference_score",
            severity="info",
            title="No simulated reference score",
            explanation=(
                "This recording is analyzed as observed data. Quality checks describe the file "
                "and processing choices rather than scoring recovery against a planted signal."
            ),
            suggestion="Use QC, provenance, and sensitivity checks when deciding what to retain.",
        ),
        WarningMessage(
            code="local_data_privacy",
            severity="warning",
            title="Keep identifiers local",
            explanation=(
                "Recording metadata or file names can contain identifying information. "
                "NeuroSignal stores the working copy and report only in the selected local project."
            ),
            suggestion="Review filenames and metadata before sharing an exported report.",
        ),
    ]
    if not raw.info.get("dig"):
        warnings.append(
            WarningMessage(
                code="montage_missing",
                severity="warning",
                title="No digitization or montage is attached",
                explanation="Sensor positions cannot be verified from this file alone.",
                suggestion=(
                    "Attach a justified montage before topographic or source-space analysis."
                ),
            )
        )
    if not len(raw.annotations):
        warnings.append(
            WarningMessage(
                code="annotations_absent",
                severity="info",
                title="No annotations found",
                explanation=(
                    "No event or artifact annotations were present in the imported recording."
                ),
                suggestion="Add reviewed annotations before condition-locked analyses.",
            )
        )
    return warnings


def inspect_local_recording(source_path: str) -> RecordingInspection:
    source = _resolve_source(source_path)
    raw = _read_raw(source, preload=False)
    channel_types = _channel_types(raw)
    return RecordingInspection(
        source_name=source.name,
        format=FORMAT_BY_SUFFIX[source.suffix.lower()],
        source_sha256=_sha256(source),
        channel_count=len(raw.ch_names),
        eeg_channel_count=channel_types.get("eeg", 0),
        channel_names=list(raw.ch_names),
        channel_types=channel_types,
        sampling_rate_hz=float(raw.info["sfreq"]),
        duration_s=round(float(raw.times[-1]) if raw.n_times else 0.0, 4),
        highpass_hz=(float(raw.info["highpass"]) if raw.info["highpass"] is not None else None),
        lowpass_hz=(float(raw.info["lowpass"]) if raw.info["lowpass"] is not None else None),
        annotation_count=len(raw.annotations),
        digitization_point_count=len(raw.info.get("dig") or []),
        montage_present=bool(raw.info.get("dig")),
        warnings=_inspection_warnings(raw),
    )


def _qc(raw: mne.io.BaseRaw) -> RealDataQcSummary:
    eeg_names = [
        name
        for name, kind in zip(raw.ch_names, raw.get_channel_types(), strict=True)
        if kind == "eeg"
    ]
    flat_channels: list[str] = []
    alpha_relative_power: float | None = None
    if eeg_names:
        sample_limit = min(raw.n_times, int(raw.info["sfreq"] * 120))
        segment = raw.get_data(picks=eeg_names, start=0, stop=sample_limit)
        standard_deviation = np.std(segment, axis=1)
        flat_channels = [
            name
            for name, deviation in zip(eeg_names, standard_deviation, strict=True)
            if deviation < 1e-9
        ]
        if sample_limit >= 16 and raw.info["sfreq"] > 4:
            n_fft = min(1024, sample_limit)
            fmax = min(40.0, raw.info["sfreq"] / 2 - 0.01)
            if fmax > 1:
                frequencies, power = signal.welch(
                    segment,
                    fs=raw.info["sfreq"],
                    nperseg=n_fft,
                    axis=-1,
                )
                keep = (frequencies >= 1.0) & (frequencies <= fmax)
                frequencies = frequencies[keep]
                power = power[:, keep]
                mean_power = np.mean(power, axis=0)
                total = float(np.sum(mean_power))
                alpha = float(np.sum(mean_power[(frequencies >= 8) & (frequencies <= 12)]))
                alpha_relative_power = round(alpha / total, 5) if total > 0 else None
    warnings = [
        WarningMessage(
            code="qc_descriptive_not_diagnostic",
            severity="info",
            title="QC is descriptive",
            explanation=(
                "Flat channels, annotations, and alpha-band power are file-quality observations; "
                "they are not a diagnostic interpretation."
            ),
            suggestion="Review raw traces, context, and acquisition notes before excluding data.",
        )
    ]
    if flat_channels:
        warnings.append(
            WarningMessage(
                code="flat_channels_detected",
                severity="warning",
                title="Potentially flat EEG channels",
                explanation=(
                    f"{len(flat_channels)} channel(s) have near-zero variation in the first "
                    "two minutes."
                ),
                suggestion="Inspect the channels before marking them bad or excluding them.",
            )
        )
    return RealDataQcSummary(
        channel_count=len(raw.ch_names),
        eeg_channel_count=len(eeg_names),
        duration_s=round(float(raw.times[-1]) if raw.n_times else 0.0, 4),
        sampling_rate_hz=float(raw.info["sfreq"]),
        bad_channels=list(raw.info["bads"]),
        flat_channels=flat_channels,
        annotation_count=len(raw.annotations),
        alpha_relative_power=alpha_relative_power,
        warnings=warnings,
    )


def _project_from_manifest(manifest: dict[str, object], status: str) -> RealDataProject:
    return RealDataProject(
        project_id=str(manifest["project_id"]),
        schema_version=int(manifest["schema_version"]),
        migration_status=status,  # type: ignore[arg-type]
        project_name=str(manifest["project_name"]),
        source_name=str(manifest["source_name"]),
        source_format=str(manifest["source_format"]),
        working_copy_name=str(manifest["working_copy_name"]),
        imported_at=datetime.fromisoformat(str(manifest["imported_at"])),
    )


def _write_manifest(project_dir: Path, manifest: dict[str, object]) -> None:
    destination = project_dir / MANIFEST_NAME
    temporary = project_dir / f"{MANIFEST_NAME}.tmp"
    temporary.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(destination)


def _load_manifest(project_dir: Path) -> tuple[dict[str, object], str]:
    manifest_path = project_dir / MANIFEST_NAME
    if not manifest_path.exists():
        working_copy = project_dir / WORKING_COPY_NAME
        if not working_copy.exists():
            raise ValueError(
                f"Project recovery failed: neither {MANIFEST_NAME} nor {WORKING_COPY_NAME} exists"
            )
        inspection = inspect_local_recording(str(working_copy))
        manifest: dict[str, object] = {
            "schema_version": CURRENT_PROJECT_SCHEMA,
            "project_id": project_dir.name,
            "project_name": f"Recovered {inspection.source_name}",
            "source_name": inspection.source_name,
            "source_format": inspection.format,
            "source_sha256": inspection.source_sha256,
            "working_copy_name": WORKING_COPY_NAME,
            "imported_at": datetime.now(UTC).isoformat(),
            "migration_history": ["recovered_missing_manifest"],
        }
        _write_manifest(project_dir, manifest)
        return manifest, "recovered"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = int(manifest.get("schema_version", 1))
    if version > CURRENT_PROJECT_SCHEMA:
        raise ValueError(f"Project schema {version} is newer than this NeuroSignal version")
    if version < CURRENT_PROJECT_SCHEMA:
        history = list(manifest.get("migration_history", []))
        history.append(f"v{version}_to_v{CURRENT_PROJECT_SCHEMA}")
        manifest["schema_version"] = CURRENT_PROJECT_SCHEMA
        manifest.setdefault("working_copy_name", WORKING_COPY_NAME)
        manifest.setdefault("source_format", "fif")
        manifest["migration_history"] = history
        _write_manifest(project_dir, manifest)
        return manifest, "migrated"
    return manifest, "current"


def import_local_recording(
    request: LocalImportRequest, project_root: Path | None = None
) -> RealDataImportResult:
    source = _resolve_source(request.source_path)
    before_hash = _sha256(source)
    inspection = inspect_local_recording(str(source))
    root = project_root or default_project_root()
    root.mkdir(parents=True, exist_ok=True)
    project_id = f"real_{uuid.uuid4().hex[:12]}"
    project_dir = root / project_id
    project_dir.mkdir()
    raw = _read_raw(source, preload=False)
    temporary_copy = project_dir / "recording_raw.partial_raw.fif"
    raw.save(temporary_copy, overwrite=False, verbose=False)
    temporary_copy.replace(project_dir / WORKING_COPY_NAME)
    after_hash = _sha256(source)
    if after_hash != before_hash:
        raise RuntimeError("Import stopped because the source file changed while it was being read")
    now = datetime.now(UTC)
    manifest: dict[str, object] = {
        "schema_version": CURRENT_PROJECT_SCHEMA,
        "project_id": project_id,
        "project_name": request.project_name,
        "source_name": source.name,
        "source_format": inspection.format,
        "source_sha256": before_hash,
        "working_copy_name": WORKING_COPY_NAME,
        "imported_at": now.isoformat(),
        "migration_history": [],
    }
    _write_manifest(project_dir, manifest)
    working_raw = mne.io.read_raw_fif(project_dir / WORKING_COPY_NAME, preload=False, verbose=False)
    return RealDataImportResult(
        project=_project_from_manifest(manifest, "current"),
        inspection=inspection,
        qc=_qc(working_raw),
        report_available=False,
    )


def recover_project(project_id: str, project_root: Path | None = None) -> RealDataProject:
    project_dir = (project_root or default_project_root()) / project_id
    if not project_dir.is_dir():
        raise ValueError(f"Project was not found: {project_id}")
    manifest, status = _load_manifest(project_dir)
    return _project_from_manifest(manifest, status)


def _report_html(
    project: RealDataProject, inspection: RecordingInspection, qc: RealDataQcSummary
) -> str:
    warnings = [item.title for item in [*inspection.warnings, *qc.warnings]]
    alpha = "Not available" if qc.alpha_relative_power is None else f"{qc.alpha_relative_power:.3f}"
    return "".join(
        [
            "<h2>NeuroSignal — Local QC record</h2>",
            (
                "<p><strong>Educational and research use only. "
                "Not for clinical diagnosis.</strong></p>"
            ),
            "<h3>Recording</h3><ul>",
            f"<li>Source file: {html.escape(project.source_name)}</li>",
            f"<li>Format: {html.escape(inspection.format.upper())}</li>",
            f"<li>Channels: {inspection.channel_count} ({inspection.eeg_channel_count} EEG)</li>",
            f"<li>Sampling rate: {inspection.sampling_rate_hz:.2f} Hz</li>",
            f"<li>Duration: {inspection.duration_s:.2f} s</li>",
            "</ul><h3>Quality checks</h3><ul>",
            f"<li>Marked bad channels: {html.escape(', '.join(qc.bad_channels) or 'None')}</li>",
            (
                f"<li>Potentially flat channels: "
                f"{html.escape(', '.join(qc.flat_channels) or 'None')}</li>"
            ),
            f"<li>Annotations: {qc.annotation_count}</li>",
            f"<li>Relative 8–12 Hz power: {alpha}</li>",
            "</ul><h3>Warnings and caveats</h3><ul>",
            *(f"<li>{html.escape(title)}</li>" for title in warnings),
            "</ul><h3>Provenance</h3><ul>",
            f"<li>Project: {html.escape(project.project_id)}</li>",
            f"<li>Schema version: {project.schema_version}</li>",
            f"<li>Imported: {project.imported_at.isoformat()}</li>",
            "</ul>",
        ]
    )


def export_project_report(project_id: str, project_root: Path | None = None) -> ReportExportResult:
    root = project_root or default_project_root()
    project_dir = root / project_id
    project = recover_project(project_id, root)
    raw = mne.io.read_raw_fif(project_dir / project.working_copy_name, preload=False, verbose=False)
    inspection = inspect_local_recording(str(project_dir / project.working_copy_name)).model_copy(
        update={"source_name": project.source_name, "format": project.source_format}
    )
    qc = _qc(raw)
    report = mne.Report(title="NeuroSignal local EEG QC", verbose=False)
    report.add_html(_report_html(project, inspection, qc), title="QC summary")
    report_path = project_dir / REPORT_NAME
    report.save(report_path, open_browser=False, overwrite=True, verbose=False)
    return ReportExportResult(
        project_id=project_id,
        report_name=REPORT_NAME,
        download_path=f"/real-data/projects/{project_id}/report",
        generated_at=datetime.now(UTC),
    )


def eegbci_lesson_status(cache_directory: str | None = None) -> EegbciLessonStatus:
    root = _eegbci_cache_root(cache_directory)
    runs = [run for run in (1, 2) if list(root.rglob(f"S001R{run:02d}.edf"))]
    if len(runs) == 2:
        return EegbciLessonStatus(
            state="cached",
            cache_directory=str(root),
            available_runs=runs,
            message=(
                "EEGBCI subject 1 eyes-open and eyes-closed runs are cached locally. "
                "The lesson can be used offline."
            ),
        )
    return EegbciLessonStatus(
        state="not_cached",
        cache_directory=str(root),
        available_runs=runs,
        message=(
            "EEGBCI eyes-open/eyes-closed files are not both cached. Acquisition is never "
            "started automatically; download them once before using the offline lesson."
        ),
    )


def import_eegbci_run(
    request: EegbciImportRequest,
    project_root: Path | None = None,
    cache_directory: str | None = None,
) -> RealDataImportResult:
    """Open an already-cached EEGBCI run; this function never downloads data."""

    root = _eegbci_cache_root(cache_directory)
    candidates = list(root.rglob(f"S001R{request.run:02d}.edf"))
    if not candidates:
        raise ValueError(
            f"EEGBCI run R{request.run:02d} is not cached locally. Download it once before "
            "starting the offline lesson."
        )
    return import_local_recording(
        LocalImportRequest(source_path=str(candidates[0]), project_name=request.project_name),
        project_root,
    )
