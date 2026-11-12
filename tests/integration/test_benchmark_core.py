"""End-to-end Q1 benchmark on a small JR network (plan §8.1; V06, V07, V09, V21, V23).

One module-scoped run (4 nodes, 2 seeds, 40 s, 8 s epochs) is interrupted by an injected
observation failure, resumed, then re-analysed with another metric and with altered truth.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from neurobridge import cli
from neurobridge.artifacts.store import ArtifactStore
from neurobridge.benchmarks import runner, tasks
from neurobridge.benchmarks.planner import BenchmarkRecipe
from neurobridge.forward.observation import checksum
from neurobridge.jobs.manager import JobManager
from neurobridge.module_registry.registry import capability_manifest

REPO = Path(__file__).resolve().parents[2]
PREVIEW = REPO / "fixtures" / "recipes" / "jr-core-preview.json"
SEEDS = [100, 101]
PRIMARY = {"M14", "M17", "M23"}
N_NODES = 4


def _small_recipe() -> dict:
    data = json.loads(PREVIEW.read_text())
    from neurobridge.simulation.tvb_jr import default_alpha_preset

    small = default_alpha_preset(n_nodes=N_NODES, seed=SEEDS[0], duration_s=40.0, burn_in_s=2.0)
    sim = data["simulation"]
    sim.update(
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


def _boom(params, inputs):  # injected interruption
    raise RuntimeError("simulated worker interruption")


@pytest.fixture(scope="module")
def bench(tmp_path_factory):
    root = tmp_path_factory.mktemp("bench")
    recipe = _small_recipe()
    mp = pytest.MonkeyPatch()
    mp.setattr(tasks, "observe", _boom)
    try:
        first = runner.run_experiment(recipe, root, inline=True)
    finally:
        mp.undo()
    resumed = runner.resume_experiment(root, first.experiment_id, inline=True)
    results = runner.collect_results(root, first.experiment_id)
    return SimpleNamespace(root=root, recipe=recipe, first=first, resumed=resumed, results=results)


def test_registry_lists_benchmark_modules():
    ids = {m.id for m in capability_manifest().modules}
    assert {"simulation.tvb-jr", "benchmark.factorial"} <= ids


def test_validation_flags_short_preview_recipe(tmp_path):
    report = runner.validate(PREVIEW)
    assert report["ok"]
    assert not any("insufficient_data" in w for w in report["warnings"])
    short = json.loads(PREVIEW.read_text())
    short["simulation"]["duration_s"] = 32.0
    short_path = tmp_path / "short-preview.json"
    short_path.write_text(json.dumps(short))
    short_report = runner.validate(short_path)
    assert any("M14" in w and "insufficient_data" in w for w in short_report["warnings"])
    assert report["cost"]["n_simulations"] == 3 * 2
    bad = json.loads(PREVIEW.read_text())
    bad["benchmark"]["factors"]["G"] = [5.0, 10.0]
    assert not runner.validate(BenchmarkRecipe.model_validate(bad))["ok"]


def test_interrupted_run_resumes_with_reuse(bench):
    plan = bench.first.plan
    n_sims = sum(1 for t in plan.tasks if t.stage == "simulate")
    assert n_sims == len(SEEDS) * 2  # JR once per (seed, G), shared by all observations
    assert bench.first.job.state == "failed"
    assert bench.first.job.tasks.completed == n_sims
    assert bench.resumed.job_id == bench.first.job_id
    assert bench.resumed.job.state == "completed"
    assert bench.resumed.job.tasks.reused == n_sims
    assert bench.resumed.job.tasks.failed == 0


def test_four_conditions_and_primary_metrics_ok(bench):
    labels = {c["label"] for c in bench.results["conditions"]}
    assert labels == {"A", "B", "C", "D", "source_off", "source_on"}
    rows = bench.results["metric_results"]
    for label in labels:
        for mid in PRIMARY:
            cell = [r for r in rows if r["condition"] == label and r["metric_id"] == mid]
            assert len(cell) == len(SEEDS)
            assert all(r["status"] == "ok" for r in cell), cell
    store = ArtifactStore(bench.root)
    arr = store.get(bench.first.experiment_id, rows[0]["artifact_id"]).array
    assert arr.ndim == 3 and np.isnan(np.diagonal(arr, axis1=1, axis2=2)).all()


def test_source_checksum_identical_across_observations(bench):
    store = ArtifactStore(bench.root)
    by_source: dict[str, set[str]] = {}
    kinds: dict[str, set[str]] = {}
    for meta in bench.results["observations"].values():
        by_source.setdefault(meta["source_artifact_id"], set()).add(meta["source_checksum"])
        kinds.setdefault(meta["source_artifact_id"], set()).add(meta["kind"])
    assert len(by_source) == len(SEEDS) * 2
    for sid, sums in by_source.items():
        assert sums == {checksum(store.get(bench.first.experiment_id, sid).array)}
        assert kinds[sid] == {"identity_probe", "eeg_forward", "source_native"}


def test_seed_paired_comparisons(bench):
    comps = {(c["metric_id"], c["analysis_space"]): c for c in bench.results["comparisons"]}
    for mid in PRIMARY:
        sensor = comps[(mid, "sensor")]
        pairs = {
            (r["contrast"]["condition_a"], r["contrast"]["condition_b"]) for r in sensor["summary"]
        }
        assert {("A", "B"), ("C", "D"), ("A", "C"), ("B", "D"), ("B-A", "D-C")} <= pairs
        for r in sensor["summary"] + sensor["companions"]:
            assert r["status"] == "ok"
            assert r["independent_n"] == len(SEEDS)
            assert sorted(p["seed"] for p in r["per_seed_values"]) == SEEDS
            assert r["p_value"] >= 1.0 / (2 ** len(SEEDS))  # (b+1)/(B+1), exact sign flips
            assert r["ci_low"] <= r["estimate"] <= r["ci_high"]
        feats = {r["contrast"]["metric_id"] for r in sensor["companions"]}
        assert feats == {"welch_peak_hz", "welch_log10_power_1_45Hz"}
        source = comps[(mid, "source")]
        assert {r["contrast"]["condition_b"] for r in source["summary"]} == {"source_on"}
        n_pairs = N_NODES * (N_NODES - 1) // 2
        assert len(source["edges"]) == n_pairs * len(source["feature_labels"])
        assert all("max-statistic FWER" in r["test_family"] for r in source["edges"])
    evals = bench.results["evaluation"]
    assert {e["metric_id"] for e in evals} == PRIMARY
    assert all(e["analysis_space"] == "source" for e in evals)


def test_rerun_other_metric_reuses_signals(bench, monkeypatch):
    exp = bench.first.experiment_id
    store = ArtifactStore(bench.root)
    before = {m.artifact_id for m in store.list_artifacts(exp)}
    monkeypatch.setattr(tasks, "simulate", _boom)  # any re-simulation would fail the job
    handle = runner.rerun_analyses(bench.root, exp, [{"id": "M11"}, {"id": "M14"}], inline=True)
    assert handle.job.state == "completed", handle.job.failures
    new = [t for t in handle.plan.tasks if t.output not in before]
    assert all(t.stage in {"metric", "compare", "evaluate"} for t in new)
    assert all(t.params["metric_id"] == "M11" for t in new)
    assert handle.job.tasks.completed == len(new)
    sims = [t for t in handle.plan.tasks if t.stage == "simulate"]
    assert sims and all(t.output in before for t in sims)


def test_truth_isolation(bench):
    exp = bench.first.experiment_id
    plan = runner.load_plan(bench.root, exp)
    for t in plan.tasks:
        if t.stage in {"observe", "epoch", "spectral", "metric", "compare"}:
            blob = json.dumps(t.params)
            assert "planted_edges" not in blob and "truth" not in blob
            assert "simulation" not in t.params  # C/D only reach the simulate task
    metrics = [m.model_dump() for m in plan.metrics]
    rdir = tasks.run_dir(bench.root, exp)
    metric_ids = sorted({a for u in plan.units for a in u.metrics.values()})
    before = {a: (rdir / "metrics" / f"{a}.json").read_bytes() for a in metric_ids}
    eval_before = {a.artifact_id for a in plan.analyses if a.kind == "evaluate"}

    tpath = tasks.truth_path(bench.root, exp)
    truth = json.loads(tpath.read_text())
    truth["planted_edges"] = [[0, 1]]
    tpath.write_text(json.dumps(truth))
    handle = runner.rerun_analyses(bench.root, exp, metrics, inline=True)
    assert handle.job.state == "completed"
    after_ids = sorted({a for u in handle.plan.units for a in u.metrics.values()})
    assert after_ids == metric_ids
    assert {a: (rdir / "metrics" / f"{a}.json").read_bytes() for a in metric_ids} == before
    eval_after = {a.artifact_id for a in handle.plan.analyses if a.kind == "evaluate"}
    assert eval_after.isdisjoint(eval_before)
    ev = runner.collect_results(bench.root, exp)["evaluation"][0]
    assert ev["conditions"][0]["per_seed"][0]["n_edges"] == 1


def test_cli_resume_and_export(bench, tmp_path, capsys):
    exp = bench.first.experiment_id
    with pytest.raises(SystemExit) as exc:
        cli.main(["benchmark", "resume", exp, "--root", str(bench.root)])
    assert exc.value.code == 0
    assert "seed-paired effects" in capsys.readouterr().out
    with pytest.raises(SystemExit) as exc:
        cli.main(["benchmark", "export", exp, "--root", str(bench.root), "--out", str(tmp_path)])
    assert exc.value.code == 0
    rows = list(csv.DictReader((tmp_path / "summary.csv").open()))
    assert rows and {r["status"] for r in rows} == {"ok"}
    assert json.loads((tmp_path / "recipe.json").read_text())["kind"] == "jr-benchmark"
    job = JobManager(bench.root).get(
        json.loads((tmp_path / "results.json").read_text())["job"]["job_id"]
    )
    assert job.state == "completed"
