import json
import math

import numpy as np
import pytest
from neurobridge.benchmarks.contracts import (
    IN_SCOPE_METRIC_IDS,
    SEED_STREAMS,
    ArtifactManifest,
    BenchmarkSpec,
    ComparisonResult,
    ContrastDefinition,
    JobManifest,
    JRSimulationSpec,
    MetricResult,
    MetricSpec,
    MetricStatus,
    ObservationSpec,
    PerSeedValue,
    SeedTree,
    TaskCounts,
)
from pydantic import ValidationError


def test_jr_defaults_follow_plan_protocol():
    spec = JRSimulationSpec()
    assert spec.n_nodes == 32
    assert spec.dt_ms == 0.1220703125
    assert (spec.monitor_hz, spec.output_fs) == (1024, 256)
    assert (spec.burn_in_s, spec.duration_s) == (10.0, 120.0)
    assert spec.steps_per_monitor == 8
    assert spec.decimation == 4
    assert len(spec.C) == 32 and all(len(row) == 32 for row in spec.C)
    assert all(v == 0.0 for row in spec.C for v in row)


def test_coupling_orientation_is_target_by_source():
    # A single directed edge 0 -> 1 is stored at C[target=1][source=0].
    C = [[0.0, 0.0], [0.7, 0.0]]
    spec = JRSimulationSpec(n_nodes=2, C=C, G=1.0)
    assert spec.C[1][0] == 0.7
    assert spec.C[0][1] == 0.0
    assert "C[target][source]" in JRSimulationSpec.__doc__
    restored = JRSimulationSpec.model_validate_json(spec.model_dump_json())
    assert restored == spec


@pytest.mark.parametrize(
    "kwargs",
    [
        {"n_nodes": 3, "C": [[0.0] * 2] * 2},
        {"n_nodes": 2, "C": [[0.0, 0.0], [0.0]]},
        {"n_nodes": 2, "D": [[0.0, -1.0], [0.0, 0.0]]},
        {"n_nodes": 2, "C": [[0.0, math.nan], [0.0, 0.0]]},
        {"duration_s": -1.0},
        {"duration_s": 0.0},
        {"burn_in_s": -0.5},
        {"output_fs": 300},
        {"dt_ms": 0.3},
        {"dt_ms": 2.0},
        {"G": -0.1},
        {"unknown_field": 1},
    ],
)
def test_jr_spec_rejects_invalid_settings(kwargs):
    with pytest.raises(ValidationError):
        JRSimulationSpec(**kwargs)


def test_jr_spec_accepts_other_integer_step_dt():
    spec = JRSimulationSpec(dt_ms=0.9765625 / 4)
    assert spec.steps_per_monitor == 4


def test_observation_spec_rules():
    assert ObservationSpec().kind == "identity_probe"
    mixed = ObservationSpec(kind="schematic_mixed", n_sensors=2, mixing=[[1.0, 0.2], [0.3, 1.0]])
    assert mixed.mixing[0][1] == 0.2
    with pytest.raises(ValidationError):
        ObservationSpec(kind="schematic_mixed", n_sensors=2)
    with pytest.raises(ValidationError):
        ObservationSpec(kind="identity_probe", n_sensors=1, mixing=[[1.0]])
    with pytest.raises(ValidationError):
        ObservationSpec(kind="schematic_mixed", n_sensors=3, mixing=[[1.0, 0.0], [0.0, 1.0]])
    with pytest.raises(ValidationError):
        ObservationSpec(sensor_noise_std=-1e-6)
    with pytest.raises(ValidationError):
        ObservationSpec(gain=0.0)
    with pytest.raises(ValidationError):
        ObservationSpec(reference="linked_mastoid")


def test_seed_tree_is_deterministic_and_order_independent():
    a = SeedTree(root=7)
    b = SeedTree(root=7)
    forward = [a.seed_for(s) for s in SEED_STREAMS]
    backward = [b.seed_for(s) for s in reversed(SEED_STREAMS)][::-1]
    assert forward == backward
    assert len(set(forward)) == len(SEED_STREAMS)
    assert all(0 <= seed < 2**63 for seed in forward)
    assert a.stream_seeds() == SeedTree.model_validate_json(a.model_dump_json()).stream_seeds()
    np.testing.assert_array_equal(
        a.generator("input", "node", 3).normal(size=5),
        b.generator("input", "node", 3).normal(size=5),
    )


def test_seed_tree_keys_are_independent():
    tree = SeedTree(root=11)
    assert tree.seed_for("input") != tree.seed_for("sensor_noise")
    assert tree.seed_for("input", "node", 0) != tree.seed_for("input", "node", 1)
    assert tree.seed_for("input") != SeedTree(root=12).seed_for("input")
    # Using other streams first must not shift a stream's seed.
    before = SeedTree(root=11).seed_for("bootstrap")
    tree.generator("surrogate").normal(size=100)
    assert tree.seed_for("bootstrap") == before
    with pytest.raises(ValueError):
        tree.seed_for("not_a_stream")


def test_seed_tree_known_value_is_stable():
    # Guards the derivation scheme against accidental changes.
    assert SeedTree(root=0).seed_for("input") == 5173518367062510167
    assert SeedTree(root=0).seed_for("input", "node", 1) == 4997868921895492414
    assert SeedTree(root=0).stream_seeds().keys() == set(SEED_STREAMS)


def test_metric_result_status_rules():
    ok = MetricResult(
        metric_id="M14",
        status="ok",
        values=np.eye(2, dtype=np.float32),
        axes=["channel", "channel"],
    )
    assert ok.status is MetricStatus.OK
    assert ok.values == [[1.0, 0.0], [0.0, 1.0]]
    assert json.loads(ok.model_dump_json())["status"] == "ok"
    peak_absent = MetricResult(metric_id="M04", status="ok", values=[None, 10.0])
    assert peak_absent.values == [None, 10.0]
    with pytest.raises(ValidationError):
        MetricResult(metric_id="M14", status="ok")
    with pytest.raises(ValidationError):
        MetricResult(metric_id="M14", status="failed")
    with pytest.raises(ValidationError):
        MetricResult(metric_id="M14", status="failed", reason_code="x", values=0.0)
    with pytest.raises(ValidationError):
        MetricResult(metric_id="M14", status="ok", values=["0.5"])
    with pytest.raises(ValidationError):
        MetricResult(metric_id="M14", status="ok", values=True)
    failed = MetricResult.from_status("M29", "unsupported_dependency", "dependency_missing")
    assert failed.values is None and failed.reason_code == "dependency_missing"
    assert {s.value for s in MetricStatus} == {
        "ok",
        "not_applicable",
        "insufficient_data",
        "invalid_input",
        "unsupported_dependency",
        "failed",
        "cancelled",
    }


def test_metric_and_benchmark_specs():
    assert len(IN_SCOPE_METRIC_IDS) == 29
    with pytest.raises(ValidationError):
        MetricSpec(id="M07")
    plv = MetricSpec(id="M14", variant="alpha")
    spec = BenchmarkSpec(
        question_preset="Q1",
        factors={"coupling": ["off", "on"], "observation": ["identity_probe", "eeg_forward"]},
        held_fixed={"reference": "none"},
        seeds=[1, 2, 3],
        metrics=[plv, MetricSpec(id="M17"), MetricSpec(id="M23")],
        profile="core-comparison",
    )
    assert BenchmarkSpec.model_validate_json(spec.model_dump_json()) == spec
    with pytest.raises(ValidationError):
        BenchmarkSpec(question_preset="Q1", seeds=[1, 1], metrics=[plv])
    with pytest.raises(ValidationError):
        BenchmarkSpec(question_preset="Q1", seeds=[1], metrics=[plv, plv])
    with pytest.raises(ValidationError):
        BenchmarkSpec(question_preset="Q1", seeds=[1], metrics=[plv], profile="fast")
    with pytest.raises(ValidationError):
        BenchmarkSpec(
            question_preset="Q1",
            seeds=[1],
            metrics=[plv],
            factors={"G": [0.0]},
            held_fixed={"G": 1.0},
        )


def test_artifact_manifest_rules():
    manifest = ArtifactManifest(
        artifact_id="a1",
        kind="source_timeseries",
        shape=[32, 30720],
        units="mV",
        axes=["source", "time"],
        checksum="0" * 64,
        parents=["spec"],
        versions={"tvb": "2.9"},
    )
    assert ArtifactManifest.model_validate_json(manifest.model_dump_json()) == manifest
    with pytest.raises(ValidationError):
        ArtifactManifest(artifact_id="a", kind="k", shape=[2], checksum="xyz")
    with pytest.raises(ValidationError):
        ArtifactManifest(artifact_id="a", kind="k", shape=[2, 3], axes=["x"], checksum="0" * 64)


def test_comparison_and_job_manifest_rules():
    contrast = ContrastDefinition(
        metric_id="M14", analysis_space="source", condition_a="A", condition_b="B"
    )
    result = ComparisonResult(
        contrast=contrast,
        independent_n=2,
        estimate=0.1,
        ci_low=0.05,
        ci_high=0.15,
        per_seed_values=[
            PerSeedValue(seed=1, value_a=0.2, value_b=0.3, difference=0.1),
            PerSeedValue(seed=2, value_a=0.2, value_b=0.3, difference=0.1),
        ],
    )
    assert result.contrast.pairing == "seed_paired"
    with pytest.raises(ValidationError):
        ComparisonResult(contrast=contrast, independent_n=2, estimate=0.1, ci_low=1, ci_high=0)
    with pytest.raises(ValidationError):
        ComparisonResult(contrast=contrast, independent_n=0, status="insufficient_data")
    with pytest.raises(ValidationError):
        ContrastDefinition(metric_id="M14", analysis_space="s", condition_a="A", condition_b="A")

    job = JobManifest(
        job_id="j1",
        experiment_id="e1",
        state="running",
        tasks=TaskCounts(total=4, completed=1, reused=1),
    )
    assert JobManifest.model_validate_json(job.model_dump_json()) == job
    with pytest.raises(ValidationError):
        TaskCounts(total=1, completed=1, failed=1)
    with pytest.raises(ValidationError):
        JobManifest(job_id="j", experiment_id="e", state="paused")
    with pytest.raises(ValidationError):
        JobManifest(
            job_id="j", experiment_id="e", state="completed", tasks=TaskCounts(total=1, failed=1)
        )
