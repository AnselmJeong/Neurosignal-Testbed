import hashlib

import mne
import numpy as np
from fastapi.testclient import TestClient
from neurobridge_api.main import app

client = TestClient(app)


def test_health_and_capabilities() -> None:
    assert client.get("/health").json()["status"] == "ready"
    payload = client.get("/capabilities").json()
    assert payload["modules"][0]["status"] == "available"


def test_neurosignal_web_origin_is_allowed() -> None:
    response = client.options(
        "/health",
        headers={
            "Origin": "http://127.0.0.1:5174",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5174"


def test_run_round_trip() -> None:
    response = client.post("/runs", json={})
    assert response.status_code == 200
    result = response.json()
    assert result["state"] == "completed"
    assert result["provenance"]["seed"] == 42
    assert client.get(f"/runs/{result['run_id']}").status_code == 200


def test_ica_fit_and_manual_apply_contract() -> None:
    simulation_response = client.post("/ica/simulate", json={})
    assert simulation_response.status_code == 200
    simulation = simulation_response.json()
    assert simulation["state"] == "completed"
    assert simulation["rank"] == 7
    assert simulation["channel_names"] == ["Fp1", "Fp2", "F7", "F8", "C3", "C4", "O1", "O2"]
    assert list(simulation["sensor_trace"]["series"]) == [
        "Fp1", "Fp2", "F7", "F8", "C3", "C4", "O1", "O2",
    ]

    fit_response = client.post("/ica/fit", json={})
    assert fit_response.status_code == 200
    fit = fit_response.json()
    assert fit["compatibility"]["rank"] == 7
    assert fit["components"][fit["blink_component_index"]]["matched_correlation"] > 0.95

    apply_response = client.post(
        "/ica/apply",
        json={
            "recipe": fit["recipe"],
            "excluded_components": [fit["blink_component_index"]],
            "compatibility_fingerprint": fit["compatibility"]["fingerprint"],
            "target_reference": fit["recipe"]["reference"],
            "target_channel_names": fit["compatibility"]["channel_names"],
        },
    )
    assert apply_response.status_code == 200
    result = apply_response.json()
    assert list(result["before_after_trace"]["series"]) == [
        f"{state} · {channel}"
        for channel in ["Fp1", "Fp2", "F7", "F8", "C3", "C4", "O1", "O2"]
        for state in ["Before", "After"]
    ]
    assert result["artifact_attenuation_db"] > 30
    assert result["neural_distortion_pct"] < 20


def test_ica_apply_rejects_incompatible_target() -> None:
    fit = client.post("/ica/fit", json={"algorithm": "fastica"}).json()
    response = client.post(
        "/ica/apply",
        json={
            "recipe": fit["recipe"],
            "excluded_components": [0],
            "compatibility_fingerprint": fit["compatibility"]["fingerprint"],
            "target_reference": "none",
            "target_channel_names": fit["compatibility"]["channel_names"],
        },
    )
    assert response.status_code == 409
    assert "incompatible" in response.json()["detail"]


def test_no_artifact_ica_has_no_blink_truth_match() -> None:
    response = client.post("/ica/fit", json={"blink_amplitude_uv": 0})
    assert response.status_code == 200
    fit = response.json()
    unmatched = [component for component in fit["components"] if component["matched_truth"] is None]

    assert fit["blink_component_index"] is None
    assert len(unmatched) == 1
    assert unmatched[0]["matched_correlation"] is None
    assert {component["matched_truth"] for component in fit["components"]} == {
        "alpha",
        "theta",
        "beta",
        None,
    }


def test_connectivity_truth_challenge_contract() -> None:
    response = client.post(
        "/connectivity/runs",
        json={"analysis_space": "latent", "surrogate_count": 20},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["estimator_backend"] == "mne-connectivity"
    assert result["spectrum"]["parameterization"]["backend"] == "specparam"
    assert result["scores"]["strongest_edge_correct"] is True
    assert result["scores"]["recall"] == 1
    assert len(result["latent_surrogate_values"]) == 20
    assert len(result["sensor_surrogate_values"]) == 20
    assert result["selected_threshold"] == result["latent_threshold"]
    assert result["truth"]["values"][0][1] == result["recipe"]["coupling_strength"]


def test_source_model_template_benchmark_contract() -> None:
    simulation_response = client.post("/source-modeling/simulate", json={})
    assert simulation_response.status_code == 200
    simulation = simulation_response.json()
    assert simulation["state"] == "completed"
    assert len(simulation["sensor_trace"]["series"]) == 14
    assert simulation["rois"][0]["frequency_hz"] == 10

    response = client.post("/source-modeling/runs", json={})
    assert response.status_code == 200
    result = response.json()
    assert result["state"] == "completed"
    assert "benchmark_passed" not in result["scores"]
    assert result["evaluation"]["mean_error_mm"] > 0
    assert len(result["rois"]) == 4
    assert len(result["candidate_positions_mm"]) == 250
    assert len(result["candidate_time_courses"]["series"]) == 250
    assert len(result["power_maps"]) == 4
    assert "estimated_positions_mm" not in result
    assert any(item["code"] == "source_leakage_caveat" for item in result["warnings"])


def test_real_data_api_import_inspect_and_report(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("NEUROSIGNAL_PROJECTS_DIR", str(tmp_path / "projects"))
    source = tmp_path / "api_source_raw.fif"
    raw = mne.io.RawArray(
        np.random.default_rng(8).normal(0, 1e-6, size=(4, 500)),
        mne.create_info(["F3", "F4", "C3", "C4"], 100, "eeg"),
        verbose=False,
    )
    raw.save(source, overwrite=True, verbose=False)
    before_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    payload = {"source_path": str(source), "project_name": "API local recording"}

    inspection = client.post("/real-data/inspect", json=payload)
    assert inspection.status_code == 200
    assert inspection.json()["source_name"] == "api_source_raw.fif"
    imported = client.post("/real-data/imports", json=payload)
    assert imported.status_code == 200
    project_id = imported.json()["project"]["project_id"]
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before_hash
    report = client.post("/reports", params={"project_id": project_id})
    assert report.status_code == 200
    downloaded = client.get(report.json()["download_path"])
    assert downloaded.status_code == 200
    assert b"truth" not in downloaded.content.lower()


def test_connectivity_preview_contract_and_invalid_band() -> None:
    response = client.post("/connectivity/simulate", json={"coupling_strength": 0})
    assert response.status_code == 200
    result = response.json()
    assert result["epoch_index"] == 0
    assert result["recipe"]["coupling_strength"] == 0
    assert len(result["latent_trace"]["series"]) == 4
    assert len(result["sensor_trace"]["series"]) == 8
    assert result["sensor_trace"]["y_unit"] == "a.u."
    assert client.post("/connectivity/simulate", json={"alpha_frequency_hz": 20}).status_code == 422
