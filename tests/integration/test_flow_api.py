"""HTTP contract of the ``/flow`` router (information-flow pipeline).

The real run uses a shortened preview recipe (20 s, 16 sensors) executed by a spawned worker
process under a per-module storage root (``NEUROSIGNAL_BENCHMARK_ROOT``).
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from neurobridge.benchmarks.contracts import MetricStatus
from neurobridge.flow import concepts as concepts_mod
from neurobridge.jobs.manager import JobManager
from neurobridge_api.main import app
from neurobridge_api.routes import benchmarks, flow

REPO = Path(__file__).resolve().parents[2]
PREVIEW = REPO / "fixtures" / "recipes" / "flow-preview.json"
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
HANGUL = re.compile(r"[가-힣]")
CORE_METHODS = (
    "gc_pairwise",
    "gc_conditional",
    "gc_time_reversed",
    "te_gaussian",
    "te_ksg",
    "effective_model",
    "activity_flow",
    "pid",
)
STATUSES = {s.value for s in MetricStatus}

client = TestClient(app)


def _small_recipe() -> dict[str, Any]:
    data = json.loads(PREVIEW.read_text())
    data["title"] = "flow API test (20 s)"
    data["simulation"].update(duration_s=20.0, burn_in_s=2.0)
    data["observation"]["n_sensors"] = 16
    data["methods"]["gc"]["max_order"] = 8
    return data


@pytest.fixture
def root(tmp_path, monkeypatch) -> Path:
    monkeypatch.setenv(benchmarks.ROOT_ENV, str(tmp_path))
    return tmp_path


def _wait_idle(run_id: str, timeout_s: float = 600.0) -> dict[str, Any]:
    """Poll until the run is terminal and its worker process has exited."""
    deadline = time.monotonic() + timeout_s
    while True:
        payload = client.get(f"/flow/runs/{run_id}", params={"include_result": False}).json()
        worker = payload["job"]["worker"]
        if payload["state"] in TERMINAL and (worker is None or not worker["alive"]):
            return payload
        assert time.monotonic() < deadline, f"flow run {run_id} still {payload['state']}"
        time.sleep(1.0)


def test_concepts_cover_every_method_in_korean(root) -> None:
    payload = client.get("/flow/concepts").json()
    entries = {e["id"]: e for e in payload["entries"]}
    assert set(payload["method_concepts"]) >= set(CORE_METHODS)
    assert set(payload["method_concepts"].values()) <= set(entries)
    methods = {e["id"] for e in payload["entries"] if e["kind"] == "method"}
    assert methods == {
        "granger_causality",
        "transfer_entropy",
        "effective_model",
        "activity_flow",
        "pid",
    }
    for entry in entries.values():
        assert HANGUL.search(entry["title"] + entry["intuition"]), entry["id"]
    assert HANGUL.search(payload["summary"])
    assert entries["level2_content"]["applicability"]["status"] == "not_applicable"
    assert set(entries) == set(concepts_mod.concept_ids())
    one = client.get("/flow/concepts/transfer_entropy")
    assert one.status_code == 200 and one.json()["related_metric_id"] == "M28"
    assert client.get("/flow/concepts/nope").status_code == 404


def test_validate_rejects_bad_recipes(root) -> None:
    unknown_node = _small_recipe()
    unknown_node["analysis"]["control_pairs"].append(["P1", "Z"])
    assert client.post("/flow/validate", json=unknown_node).status_code == 422
    injected = _small_recipe()
    injected["tasks"] = [{"target": "os:system"}]  # extra fields (task targets) are refused
    assert client.post("/flow/validate", json=injected).status_code == 422
    negative = _small_recipe()
    negative["simulation"]["duration_s"] = -1
    assert client.post("/flow/validate", json=negative).status_code == 422
    assert client.post("/flow/runs", json=negative).status_code == 422

    too_long = _small_recipe()
    too_long["simulation"]["duration_s"] = 900.0
    report = client.post("/flow/validate", json=too_long).json()
    assert report["ok"] is False and report["errors"]
    assert client.post("/flow/runs", json=too_long).status_code == 422

    good = client.post("/flow/validate", json=_small_recipe())
    assert good.status_code == 200
    body = good.json()
    assert body["ok"] and body["errors"] == []
    assert body["cost"]["n_datasets"] == 4 and body["cost"]["dataset_channels"] == [8, 16]
    assert body["cost"]["estimated_wall_s"] > 0 and len(body["recipe_sha256"]) == 64
    assert not (root / "flow" / "benchmarks").exists() or not any(
        p.name.startswith("flow-") for p in (root / "flow" / "benchmarks").iterdir()
    )  # validation never creates runs


def test_unsafe_and_unknown_ids(root) -> None:
    assert client.get("/flow/runs/..evil").status_code == 422
    assert client.get("/flow/runs/.hidden").status_code == 422
    assert client.get("/flow/runs/..%2F..%2Fetc").status_code in (404, 422)
    assert client.post("/flow/runs/..evil/cancel").status_code == 422
    assert client.get("/flow/runs/flow-missing").status_code == 404
    assert client.post("/flow/runs/flow-missing/cancel").status_code == 404
    assert not (root / "flow" / "benchmarks" / "flow-missing").exists()
    assert client.get("/flow/runs").json() == {"runs": []}
    assert client.get("/health").status_code == 200  # existing routes untouched
    assert client.get("/benchmarks/jobs/job-missing").status_code == 404


def test_restart_marks_orphaned_run_interrupted(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv(benchmarks.ROOT_ENV, str(tmp_path))
    flow_root = tmp_path / "flow"
    run_dir = flow_root / "benchmarks" / "flow-orphan"
    (run_dir / "_run").mkdir(parents=True)
    (run_dir / "_run" / "recipe.json").write_text(json.dumps(_small_recipe()))
    (run_dir / "_run" / "meta.json").write_text(json.dumps({"run_id": "flow-orphan"}))
    mgr = JobManager(flow_root)
    job = mgr.create("flow-orphan", total_tasks=1)
    mgr.start(job.job_id)  # worker "died": job stays running
    flow._RECOVERED.discard(flow_root.resolve())
    payload = client.get("/flow/runs/flow-orphan").json()
    assert payload["state"] == "interrupted" and payload["result"] is None


def test_cancel_stops_run(root) -> None:
    created = client.post("/flow/runs", json=_small_recipe())
    assert created.status_code == 202, created.text
    run_id = created.json()["run_id"]
    cancel = client.post(f"/flow/runs/{run_id}/cancel")
    assert cancel.status_code == 200 and cancel.json()["cancel_requested"]
    final = _wait_idle(run_id, timeout_s=180.0)
    assert final["state"] == "cancelled"
    assert final["has_result"] is False and final["result"] is None


def test_real_run_returns_all_method_results(root) -> None:
    created = client.post("/flow/runs", json=_small_recipe())
    assert created.status_code == 202, created.text
    body = created.json()
    run_id, job_id = body["run_id"], body["job_id"]
    assert re.fullmatch(r"flow-[0-9a-f]{10}-[0-9a-f]{6}", run_id)
    assert body["job"]["state"] in ("queued", "running") and body["job"]["worker"]["pid"]

    listed = client.get("/flow/runs").json()["runs"]
    assert [r["run_id"] for r in listed] == [run_id]

    final = _wait_idle(run_id)
    assert final["state"] == "completed", final["job"]["failures"]
    assert final["job"]["job_id"] == job_id and final["job"]["tasks"]["completed"] == 1

    result = client.get(f"/flow/runs/{run_id}").json()["result"]
    assert result["run_id"] == run_id and result["kind"] == "flow-pipeline-result"
    ids = {d["dataset_id"] for d in result["datasets"]}
    assert ids == {"source/coupled", "source/control", "sensor-none/coupled", "sensor-none/control"}
    for dataset in result["datasets"]:
        methods = dataset["methods"]
        for method_id in CORE_METHODS:
            assert methods[method_id]["status"] in STATUSES, (dataset["dataset_id"], method_id)
            assert methods[method_id]["concept_id"]
        assert methods["level2_content_decoding"]["status"] == "not_applicable"
    source = next(d for d in result["datasets"] if d["dataset_id"] == "source/coupled")
    for method_id in ("gc_conditional", "te_gaussian", "effective_model", "pid"):
        assert source["methods"][method_id]["status"] == "ok", method_id
    assert len(result["truth_isolation"]["frozen_analysis_sha256"]) == 64
    assert result["evaluation"]
    assert (root / "flow" / "benchmarks" / run_id / "flow_result.json").is_file()

    listed = client.get("/flow/runs").json()["runs"]
    assert listed[0]["state"] == "completed" and listed[0]["has_result"] is True
    done_cancel = client.post(f"/flow/runs/{run_id}/cancel").json()
    assert done_cancel["state"] == "completed" and done_cancel["active"] is False
