from fastapi.testclient import TestClient
from neurobridge_api.main import app

client = TestClient(app)


def test_health_and_capabilities() -> None:
    assert client.get("/health").json()["status"] == "ready"
    payload = client.get("/capabilities").json()
    assert payload["modules"][0]["status"] == "available"


def test_run_round_trip() -> None:
    response = client.post("/runs", json={})
    assert response.status_code == 200
    result = response.json()
    assert result["state"] == "completed"
    assert result["provenance"]["seed"] == 42
    assert client.get(f"/runs/{result['run_id']}").status_code == 200


def test_ica_fit_and_manual_apply_contract() -> None:
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
