"""End-to-end educational information-flow pipeline (preview recipe, CLI + API)."""

from __future__ import annotations

import contextlib
import inspect
import io
import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

pytest.importorskip("tvb")

from neurobridge import cli  # noqa: E402
from neurobridge.flow import activity_flow, effective, granger, pid, pipeline  # noqa: E402
from neurobridge.flow import concepts as concepts_mod  # noqa: E402
from neurobridge.flow import transfer_entropy as te  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
PREVIEW = REPO / "fixtures" / "recipes" / "flow-preview.json"
FULL = REPO / "fixtures" / "recipes" / "flow-full.json"

# Analysis entry points that must never see the generating coupling matrix C.
SPIED = (
    (granger, "conditional_gc"),
    (granger, "pairwise_gc"),
    (granger, "time_reversed_gc"),
    (granger, "fit_var"),
    (te, "te_matrix"),
    (te, "gaussian_te"),
    (effective, "fit_linear_state_space"),
    (effective, "compare_linear_models"),
    (activity_flow, "run_activity_flow"),
    (pid, "time_lagged_pid"),
    (pipeline, "analyze_dataset"),
)
TRUTH_KWARGS = {"C", "truth", "edges", "graph", "ground_truth", "coupling"}


def _truth_like(value: Any, C: np.ndarray) -> bool:
    if isinstance(value, np.ndarray) and value.shape == C.shape:
        return bool(np.allclose(value, C) or np.array_equal(value != 0, C > 0))
    return False


@pytest.fixture(scope="module")
def preview(tmp_path_factory) -> dict[str, Any]:
    root = tmp_path_factory.mktemp("flow-root")
    C = pipeline.load_recipe(PREVIEW).graph.coupling_matrix()
    calls: dict[str, int] = {}
    violations: list[str] = []
    mp = pytest.MonkeyPatch()
    for module, name in SPIED:
        original = getattr(module, name)

        def spy(*args, __orig=original, __name=name, **kwargs):
            calls[__name] = calls.get(__name, 0) + 1
            for key in TRUTH_KWARGS & set(kwargs):
                violations.append(f"{__name} got kwarg {key}")
            for value in (*args, *kwargs.values()):
                if _truth_like(value, C):
                    violations.append(f"{__name} received the coupling matrix")
            return __orig(*args, **kwargs)

        mp.setattr(module, name, spy)
    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            with pytest.raises(SystemExit) as exit_info:
                cli.main(["flow", "run", str(PREVIEW), "--root", str(root), "--run-id", "flow-it"])
    finally:
        mp.undo()
    paths = list(root.rglob(pipeline.RESULT_FILENAME))
    assert len(paths) == 1, err.getvalue()[-2000:]
    return {
        "exit_code": exit_info.value.code,
        "stdout": out.getvalue(),
        "result": json.loads(paths[0].read_text(encoding="utf-8")),
        "result_path": paths[0],
        "calls": calls,
        "violations": violations,
        "C": C,
    }


def test_cli_run_exits_zero_and_prints_summary(preview):
    assert preview["exit_code"] == 0
    assert "source-space evaluation" in preview["stdout"]
    assert "sensor space (no truth scoring" in preview["stdout"]
    result = preview["result"]
    assert result["kind"] == "flow-pipeline-result"
    spaces = {(d["space"], d["condition"]) for d in result["datasets"]}
    assert spaces == {
        ("source", "coupled"),
        ("source", "control"),
        ("sensor", "coupled"),
        ("sensor", "control"),
    }
    sensor = next(d for d in result["datasets"] if d["space"] == "sensor")
    assert len(sensor["channel_names"]) == 32
    assert sensor["observation"] == "eeg_forward"
    assert result["timings_s"]["total_s"] < 240


def test_every_method_is_ok_or_explained(preview):
    for ds in preview["result"]["datasets"]:
        methods = ds["methods"]
        for mid, res in methods.items():
            assert res["method_id"] == mid
            if res["status"] != "ok":
                assert res["reason_code"] and res["message"], (ds["dataset_id"], mid)
                assert "values" not in res
        level2 = methods["level2_content_decoding"]
        assert level2["status"] == "not_applicable"
        assert level2["reason_code"] == "no_stimulus_labels"
        for mid in (
            "gc_pairwise",
            "gc_conditional",
            "gc_time_reversed",
            "te_gaussian",
            "te_ksg",
            "effective_model",
            "activity_flow",
            "pid",
        ):
            assert methods[mid]["status"] == "ok", (ds["dataset_id"], mid, methods[mid])


def test_concepts_cover_every_method_in_results(preview):
    ids = set(concepts_mod.concept_ids())
    used = set()
    for ds in preview["result"]["datasets"]:
        for mid, res in ds["methods"].items():
            assert res["concept_id"] in ids
            assert concepts_mod.METHOD_CONCEPTS[mid] == res["concept_id"]
            used.add(mid)
    assert used == set(concepts_mod.METHOD_CONCEPTS)
    gc = concepts_mod.get_concept("granger_causality")
    assert gc.related_metric_id == "M27" and gc.formula
    assert concepts_mod.get_concept("transfer_entropy").related_metric_id == "M28"
    assert concepts_mod.get_concept("level2_content").applicability.status == "not_applicable"


def test_source_conditional_gc_ranks_true_edges(preview):
    coupled = next(
        s for s in preview["result"]["evaluation"]["source"] if s["condition"] == "coupled"
    )
    auc = coupled["scores"]["gc_conditional"]["edge_auc"]["auc"]
    assert auc is not None and auc > 0.7
    assert coupled["scores"]["gc_conditional"]["direction"]["status"] == "ok"
    control = next(
        s for s in preview["result"]["evaluation"]["source"] if s["condition"] == "control"
    )
    assert control["scores"]["gc_conditional"]["edge_auc"]["reason_code"] == "no_active_edges_at_G0"
    sig = control["scores"]["gc_conditional"]["significance"]
    assert sig["true_positives"] == 0 and isinstance(sig["false_positives"], int)


def test_fork_spurious_edge_weaker_conditional_than_pairwise(preview):
    coupled = next(
        s for s in preview["result"]["evaluation"]["source"] if s["condition"] == "coupled"
    )
    fork = next(f for f in coupled["fork_spurious"] if f["driver"] == "C")
    assert sorted(fork["pair"]) == ["D", "E"]
    for row in fork["directions"]:
        assert row["gc_pairwise"]["value"] is not None
        assert row["gc_conditional"]["value"] is not None
    # Observed robustly (pairwise ~0.08 vs conditional ~0.04 nats); the significance flags are
    # reported, not asserted: JR's hidden states leave part of the common input unexplained.
    assert fork["conditional_weaker_both_directions"] is True
    assert isinstance(fork["spurious_detected_pairwise"], bool)
    assert isinstance(fork["spurious_detected_conditional"], bool)


def test_truth_never_reaches_analysis_functions(preview):
    assert preview["violations"] == []
    for _, name in SPIED:
        assert preview["calls"].get(name, 0) > 0, f"{name} was never called"
    params = set(inspect.signature(pipeline.analyze_dataset).parameters)
    assert not params & TRUTH_KWARGS
    assert "edges" not in pipeline.AnalysisPlanSpec.model_fields
    isolation = preview["result"]["truth_isolation"]
    assert isolation["truth_used_by"] == ["simulate_conditions", "evaluation.evaluate_flow"]


def test_results_frozen_before_evaluation_and_saved(preview):
    result = preview["result"]
    frozen = {k: result[k] for k in ("datasets", "pid_teaching", "simulation", "preprocessing")}
    assert pipeline.payload_sha256(frozen) == result["truth_isolation"]["frozen_analysis_sha256"]
    run_dir = preview["result_path"].parent
    refs = [
        m["artifact_ref"]
        for ds in result["datasets"]
        for m in ds["methods"].values()
        if m.get("artifact_ref")
    ]
    assert refs and all((run_dir / f"{ref}.npy").exists() for ref in refs)
    gc = next(d for d in result["datasets"] if d["dataset_id"] == "source/coupled")
    values = np.load(run_dir / f"{gc['methods']['gc_conditional']['artifact_ref']}.npy")
    assert values.shape == (8, 8) and np.isnan(np.diag(values)).all()


def test_sensor_space_reports_g0_structure_without_truth(preview):
    sensor = preview["result"]["evaluation"]["sensor"]
    assert {s["condition"] for s in sensor} == {"coupled", "control"}
    for s in sensor:
        assert "not applicable" in s["truth_scoring"]
        assert "auc" not in json.dumps(s).lower()
        assert s["gc_pairwise"]["fraction_significant_bonferroni"] is not None
    display = preview["result"]["display_channels"]
    assert set(display["mapping"]) == set(pipeline.load_recipe(PREVIEW).graph.node_names)


def test_flow_concepts_cli_prints_json(capsys):
    with pytest.raises(SystemExit) as exit_info:
        cli.main(["flow", "concepts"])
    assert exit_info.value.code == 0
    catalog = json.loads(capsys.readouterr().out)
    ids = {e["id"] for e in catalog["entries"]}
    assert {"granger_causality", "transfer_entropy", "effective_model", "activity_flow"} <= ids
    assert {"pid", "level1_direction", "level2_content", "level3_computation"} <= ids
    assert {"volume_conduction", "common_input", "reference"} <= ids
    with pytest.raises(SystemExit) as exit_info:
        cli.main(["flow", "concepts", "--id", "pid"])
    assert exit_info.value.code == 0
    assert json.loads(capsys.readouterr().out)["flow_id"] == "F05"


def test_recipes_validate():
    for path in (PREVIEW, FULL):
        recipe = pipeline.load_recipe(path)
        C = recipe.graph.coupling_matrix()
        assert C.shape == (8, 8) and np.allclose(C.sum(axis=1)[C.sum(axis=1) > 0], 1.0)
    assert pipeline.load_recipe(FULL).observation.references == ["none", "average"]
