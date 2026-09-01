import hashlib
import json
from pathlib import Path

import mne
import numpy as np
from neurobridge.contracts.models import LocalImportRequest
from neurobridge.real_data import (
    eegbci_lesson_status,
    export_project_report,
    import_local_recording,
    recover_project,
)


def _write_recording(path: Path) -> None:
    info = mne.create_info(["F3", "F4", "C3", "C4"], 100, "eeg")
    samples = np.arange(500) / 100
    data = np.asarray([np.sin(2 * np.pi * 10 * samples + phase) for phase in range(4)]) * 8e-6
    raw = mne.io.RawArray(data, info, verbose=False)
    raw.set_annotations(mne.Annotations([1.0], [0.2], ["reviewed segment"]))
    raw.save(path, overwrite=True, verbose=False)


def test_import_to_report_preserves_source_and_avoids_simulation_language(tmp_path: Path) -> None:
    source = tmp_path / "source_raw.fif"
    _write_recording(source)
    before_hash = hashlib.sha256(source.read_bytes()).hexdigest()

    imported = import_local_recording(
        LocalImportRequest(source_path=str(source), project_name="Local test recording"),
        tmp_path / "projects",
    )
    exported = export_project_report(imported.project.project_id, tmp_path / "projects")
    report_path = tmp_path / "projects" / imported.project.project_id / exported.report_name
    report = report_path.read_text()

    assert hashlib.sha256(source.read_bytes()).hexdigest() == before_hash
    assert (tmp_path / "projects" / imported.project.project_id / "recording_raw.fif").is_file()
    assert imported.inspection.source_name == "source_raw.fif"
    assert imported.qc.alpha_relative_power is not None
    assert "truth" not in report.lower()
    assert "latent" not in report.lower()
    assert "not for clinical diagnosis" in report.lower()


def test_manifest_migration_and_missing_manifest_recovery(tmp_path: Path) -> None:
    source = tmp_path / "source_raw.fif"
    _write_recording(source)
    project_root = tmp_path / "projects"
    imported = import_local_recording(LocalImportRequest(source_path=str(source)), project_root)
    project_dir = project_root / imported.project.project_id
    manifest_path = project_dir / "project.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["schema_version"] = 1
    manifest.pop("source_format")
    manifest_path.write_text(json.dumps(manifest))

    migrated = recover_project(imported.project.project_id, project_root)
    assert migrated.schema_version == 2
    assert migrated.migration_status == "migrated"
    assert migrated.source_format == "fif"
    manifest_path.unlink()

    recovered = recover_project(imported.project.project_id, project_root)
    assert recovered.migration_status == "recovered"
    assert recovered.working_copy_name == "recording_raw.fif"


def test_eegbci_lesson_reports_missing_cache_without_downloading(tmp_path: Path) -> None:
    status = eegbci_lesson_status(str(tmp_path))

    assert status.state == "not_cached"
    assert status.available_runs == []
    assert "never started automatically" in status.message
