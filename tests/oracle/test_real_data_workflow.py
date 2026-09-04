import hashlib
import json
from pathlib import Path

import mne
import numpy as np
from neurobridge.contracts.models import LocalImportRequest, RealDataQeegRequest
from neurobridge.real_data import (
    default_project_root,
    eegbci_lesson_status,
    export_project_report,
    import_local_recording,
    recover_project,
    run_qeeg_analysis,
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
    assert "NeuroSignal" in report


def test_project_root_prefers_new_name_and_supports_legacy_override(
    tmp_path: Path, monkeypatch
) -> None:
    current = tmp_path / "neurosignal-projects"
    legacy = tmp_path / "neurobridge-projects"
    monkeypatch.setenv("NEUROSIGNAL_PROJECTS_DIR", str(current))
    monkeypatch.setenv("NEUROBRIDGE_PROJECTS_DIR", str(legacy))
    assert default_project_root() == current

    monkeypatch.delenv("NEUROSIGNAL_PROJECTS_DIR")
    assert default_project_root() == legacy


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


def test_qeeg_run_writes_derivatives_and_preserves_working_copy(tmp_path: Path) -> None:
    source = tmp_path / "qeeg_source_raw.fif"
    names = ["Fp1", "Fp2", "F3", "F4", "C3", "C4", "O1", "O2"]
    info = mne.create_info(names, 100, "eeg")
    samples = np.arange(2000) / 100
    data = (
        np.asarray(
            [
                (8 + index) * np.sin(2 * np.pi * 6 * samples + index / 5)
                + (4 + index / 2) * np.sin(2 * np.pi * 18 * samples + index / 7)
                for index in range(len(names))
            ]
        )
        * 1e-6
    )
    raw = mne.io.RawArray(data, info, verbose=False)
    raw.set_montage("standard_1020")
    raw.save(source, overwrite=True, verbose=False)
    project_root = tmp_path / "projects"
    imported = import_local_recording(LocalImportRequest(source_path=str(source)), project_root)
    project_dir = project_root / imported.project.project_id
    working_copy = project_dir / "recording_raw.fif"
    before_hash = hashlib.sha256(working_copy.read_bytes()).hexdigest()

    result = run_qeeg_analysis(
        imported.project.project_id,
        RealDataQeegRequest(
            duration_limit_s=16,
            epoch_duration_s=2,
            lowpass_hz=40,
            connectivity_band="theta",
            ica_enabled=False,
        ),
        project_root,
    )

    assert hashlib.sha256(working_copy.read_bytes()).hexdigest() == before_hash
    assert Path(result.cleaned_fif_path).is_file()
    assert Path(result.result_json_path).is_file()
    assert len(result.band_powers) == 5
    assert result.mean_theta_beta_ratio is not None
    assert result.mean_theta_beta_ratio > 1
    assert result.coherence.band == "theta"
    assert result.plv.epoch_count >= 2
    assert len(result.coherence.values) == len(names)
    assert all(topomap.available for topomap in result.topomaps)
    assert any(warning.code == "qeeg_descriptive_not_normative" for warning in result.warnings)

    ica_result = run_qeeg_analysis(
        imported.project.project_id,
        RealDataQeegRequest(
            duration_limit_s=12,
            epoch_duration_s=2,
            lowpass_hz=40,
            ica_enabled=True,
            ica_component_count=3,
            ica_exclude_components=[0],
        ),
        project_root,
    )
    assert len(ica_result.ica_components) == 3
    assert ica_result.ica_excluded_components == [0]
    assert ica_result.run_id != result.run_id
    assert hashlib.sha256(working_copy.read_bytes()).hexdigest() == before_hash
