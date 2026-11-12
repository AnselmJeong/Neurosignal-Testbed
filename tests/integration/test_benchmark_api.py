"""HTTP contract of the ``/benchmarks`` router (plan §5.4, §5.5).

Uses a small Q1 recipe (4 nodes, 2 seeds, 40 s) run by real spawned worker processes under a
per-test storage root (``NEUROSIGNAL_BENCHMARK_ROOT``).
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from neurobridge.jobs.manager import JobManager
from neurobridge_api.main import app
from neurobridge_api.routes import benchmarks

REPO = Path(__file__).resolve().parents[2]
PREVIEW = REPO / "fixtures" / "recipes" / "jr-core-preview.json"
SEEDS = [100, 101]
N_NODES = 4
PRIMARY = {"M14", "M17", "M23"}
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}

client = TestClient(app)


def _small_recipe() -> dict:
    from neurobridge.simulation.tvb_jr import default_alpha_preset

    data = json.loads(PREVIEW.read_text())
    small = default_alpha_preset(n_nodes=N_NODES, seed=SEEDS[0], duration_s=40.0, burn_in_s=2.0)
    data["simulation"].update(
        n_nodes=N_NODES,
        C=small.C,
        D=small.D,
        duration_s=40.0,
        burn_in_s=2.0,
        seeds={"root": SEEDS[0]},
    )
    data["observations"]["identity_probe"]["n_sensors"] = N_NODES
    data["observations"]["eeg_forward"]["n_sensors"] = 16
    data["benchmark"]["seeds"] = SEEDS
    data["benchmark"]["budget"]["n_bootstrap"] = 199
    return data


@pytest.fixture
def root(tmp_path, monkeypatch) -> Path:
    monkeypatch.setenv(benchmarks.ROOT_ENV, str(tmp_path))
    return tmp_path


def _wait_idle(job_id: str, timeout_s: float = 900.0) -> dict:
    """Poll until the job is terminal and its worker process has exited."""
    deadline = time.monotonic() + timeout_s
    while True:
        job = client.get(f"/benchmarks/jobs/{job_id}").json()
        worker = job["worker"]
        if job["state"] in TERMINAL and (worker is None or not worker["alive"]):
            return job
        assert time.monotonic() < deadline, f"job {job_id} still {job['state']}"
        time.sleep(1.0)


def test_capabilities_list_29_metric_ids(root) -> None:
    payload = client.get("/benchmarks/capabilities").json()
    assert len(payload["metric_ids"]) == 29
    assert set(payload["metrics"]) == set(payload["metric_ids"])
    assert PRIMARY <= {m for m, e in payload["metrics"].items() if e["status"] == "implemented"}
    assert "core" in payload["dependency_groups"]
    assert client.get("/capabilities").status_code == 200  # existing route untouched


def test_validate_rejects_bad_specs(root) -> None:
    bad_schema = _small_recipe()
    bad_schema["benchmark"]["metrics"][0]["id"] = "M99"
    assert client.post("/benchmarks/validate", json=bad_schema).status_code == 422
    injected = _small_recipe()
    injected["tasks"] = [{"target": "os:system"}]  # extra fields (task targets) are refused
    assert client.post("/benchmarks/validate", json=injected).status_code == 422

    bad_science = _small_recipe()
    bad_science["benchmark"]["factors"]["G"] = [5.0, 10.0]
    report = client.post("/benchmarks/validate", json=bad_science)
    assert report.status_code == 200 and report.json()["ok"] is False
    assert client.post("/benchmarks/experiments", json=bad_science).status_code == 422

    good = client.post("/benchmarks/validate", json=_small_recipe()).json()
    assert good["ok"] and good["cost"]["n_simulations"] == len(SEEDS) * 2
    assert good["experiment_id"].startswith("jr-")


def test_unsafe_and_unknown_ids(root) -> None:
    assert client.get("/benchmarks/jobs/..evil").status_code == 422
    assert client.get("/benchmarks/jobs/%2E%2E%2Fetc").status_code in (404, 422)
    assert client.get("/benchmarks/experiments/..%2F..%2Fetc").status_code in (404, 422)
    assert client.get("/benchmarks/experiments/.hidden").status_code == 422
    window = client.get(
        "/benchmarks/artifacts/x/window", params={"experiment_id": "../../etc", "stop": 10}
    )
    assert window.status_code == 422
    assert client.get("/benchmarks/jobs/job-missing").status_code == 404
    assert client.get("/benchmarks/experiments/jr-missing").status_code == 404
    assert not (root / "benchmarks" / "jr-missing").exists()  # lookups never create dirs
    assert client.post("/benchmarks/jobs/job-missing/cancel").status_code == 404


def test_restart_marks_running_job_interrupted(root) -> None:
    mgr = JobManager(root)
    job = mgr.create("jr-orphan", total_tasks=3)
    mgr.start(job.job_id)  # worker "died": job stays running
    fresh = FastAPI()
    fresh.include_router(benchmarks.router)
    with TestClient(fresh) as restarted:  # lifespan startup runs recover()
        payload = restarted.get(f"/benchmarks/jobs/{job.job_id}").json()
    assert payload["state"] == "interrupted"


def test_experiment_cancel_resume_analyses_window_export(root, monkeypatch) -> None:
    recipe = _small_recipe()
    created = client.post("/benchmarks/experiments", json=recipe)
    assert created.status_code == 202, created.text
    exp_id, job_id = created.json()["experiment_id"], created.json()["job_id"]
    assert created.json()["job"]["state"] in ("queued", "running")

    cancel = client.post(f"/benchmarks/jobs/{job_id}/cancel")
    assert cancel.status_code == 200 and cancel.json()["cancel_requested"]
    assert _wait_idle(job_id)["state"] == "cancelled"

    resumed = client.post(f"/benchmarks/experiments/{exp_id}/resume")
    assert resumed.status_code == 202, resumed.text
    assert resumed.json()["job_id"] == job_id
    assert client.post(f"/benchmarks/experiments/{exp_id}/resume").status_code == 409
    final = _wait_idle(job_id)
    assert final["state"] == "completed", final["failures"]
    assert final["tasks"]["failed"] == 0

    exp = client.get(f"/benchmarks/experiments/{exp_id}").json()
    labels = {c["label"] for c in exp["conditions"]}
    assert labels == {"A", "B", "C", "D", "source_off", "source_on"}
    rows = exp["metric_results"]
    assert {r["metric_id"] for r in rows} == PRIMARY
    assert all(r["status"] == "ok" for r in rows)
    assert {c["metric_id"] for c in exp["comparisons"]} == PRIMARY
    assert exp["artifacts"] and exp["recipe"]["benchmark"]["seeds"] == SEEDS

    source_id = next(iter(exp["observations"].values()))["source_artifact_id"]
    win = client.get(
        f"/benchmarks/artifacts/{source_id}/window",
        params={"experiment_id": exp_id, "start": 256, "stop": 512, "channels": [0, 2]},
    )
    assert win.status_code == 200, win.text
    body = win.json()
    assert body["units"] == "mV" and body["sfreq"] == 256
    assert [c["index"] for c in body["channels"]] == [0, 2]
    assert len(body["data"]) == 2 and len(body["data"][0]) == 256
    monkeypatch.setattr(benchmarks, "MAX_WINDOW_SAMPLES", 100)
    too_long = client.get(
        f"/benchmarks/artifacts/{source_id}/window",
        params={"experiment_id": exp_id, "start": 0, "stop": 101},
    )
    assert too_long.status_code == 422
    epochs_id = next(a["artifact_id"] for a in exp["artifacts"] if len(a["shape"]) == 3)
    assert (
        client.get(
            f"/benchmarks/artifacts/{epochs_id}/window", params={"experiment_id": exp_id}
        ).status_code
        == 422
    )

    analyses = client.post(
        f"/benchmarks/experiments/{exp_id}/analyses",
        json={"metrics": [{"id": "M14"}]},
    )
    assert analyses.status_code == 202, analyses.text
    rerun = _wait_idle(analyses.json()["job_id"])
    assert rerun["state"] == "completed" and rerun["tasks"]["completed"] == 0
    assert rerun["tasks"]["reused"] == rerun["tasks"]["total"]
    assert (
        client.post(
            f"/benchmarks/experiments/{exp_id}/analyses", json={"metrics": [{"id": "M99"}]}
        ).status_code
        == 422
    )

    export = client.post(f"/benchmarks/experiments/{exp_id}/exports")
    assert export.status_code == 201
    files = export.json()["files"]
    assert set(files) == {"results.json", "summary.csv", "recipe.json"}
    assert all(Path(f["path"]).is_file() and f["bytes"] > 0 for f in files.values())
