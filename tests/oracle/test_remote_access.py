import json

import pytest
from fastapi.testclient import TestClient
from neurobridge_api.remote import create_remote_app


@pytest.fixture
def client(tmp_path):
    auth = tmp_path / "credentials.json"
    auth.write_text(
        json.dumps({"username": "test", "password": "long-test-password-for-remote-access"})
    )
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<h1>NeuroSignal</h1>")
    return TestClient(create_remote_app(auth, dist))


def test_auth_guards_frontend_api_and_files(client):
    for path in ["/", "/api/health", "/api/openapi.json", "/api/real-data/eegbci/status"]:
        response = client.get(path)
        assert response.status_code == 401
        assert response.headers["www-authenticate"].startswith("Basic")
        assert response.headers["cache-control"] == "no-store"
    assert client.post("/api/qeeg/simulate", json={}).status_code == 401
    assert client.get("/api/health", auth=("test", "wrong")).status_code == 401
    assert client.get("/", headers={"authorization": "Basic !!!"}).status_code == 401


def test_authenticated_app_and_same_origin_mutations(client):
    client.auth = ("test", "long-test-password-for-remote-access")
    assert "NeuroSignal" in client.get("/").text
    assert client.get("/api/health").json()["status"] == "ready"
    assert (
        client.post(
            "/api/qeeg/simulate", json={"cohort_size": 20}, headers={"origin": "http://testserver"}
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/qeeg/simulate", json={}, headers={"origin": "https://unrelated.example"}
        ).status_code
        == 403
    )
    assert client.get("/%2e%2e/credentials.json").status_code == 404
