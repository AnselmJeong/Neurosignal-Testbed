from __future__ import annotations

import os

import numpy as np
import pytest
from neurobridge.artifacts import ArtifactStore
from neurobridge.jobs import JobManager, TaskSpec, run_inline, start_process

# --- tiny task functions, imported by name ("<this module>:<function>") in the worker ---------


def make_ones(params, inputs):
    return np.ones(int(params["n"]))


def add_inputs(params, inputs):
    return sum(np.asarray(a) for a in inputs.values()) + float(params.get("offset", 0.0))


def boom(params, inputs):
    raise RuntimeError("planned failure")


def cancel_self(params, inputs):
    JobManager(params["root"]).request_cancel(params["job_id"])
    return np.zeros(2)


def thread_env(params, inputs):
    return np.array([float(os.environ["OMP_NUM_THREADS"]), float(os.environ["MKL_NUM_THREADS"])])


def _t(name: str) -> str:
    return f"{__name__}:{name}"


def _tasks():
    return [
        TaskSpec(task_id="t1", target=_t("make_ones"), params={"n": 3}, output="a1"),
        TaskSpec(task_id="t2", target=_t("make_ones"), params={"n": 3}, output="a2"),
        TaskSpec(task_id="t3", target=_t("add_inputs"), inputs=["a1", "a2"], output="a3"),
    ]


# --- manager -----------------------------------------------------------------------------------


def test_index_persists_and_lists(tmp_path):
    mgr = JobManager(tmp_path)
    job = mgr.create("exp1", total_tasks=2, stage="simulate")
    mgr.create("exp2")
    assert (tmp_path / "benchmarks" / "jobs.sqlite").is_file()
    again = JobManager(tmp_path).get(job.job_id)
    assert again.state == "queued" and again.tasks.total == 2 and again.stage == "simulate"
    assert [j.job_id for j in mgr.list("exp1")] == [job.job_id]
    assert len(mgr.list()) == 2 and len(mgr.list(states=("running",))) == 0
    with pytest.raises(KeyError):
        mgr.get("job-missing")
    with pytest.raises(ValueError):
        mgr.create("../exp")


def test_restart_recovery_marks_interrupted_never_completed(tmp_path):
    mgr = JobManager(tmp_path)
    queued = mgr.create("exp1", total_tasks=2)
    running = mgr.create("exp1", total_tasks=2)
    done = mgr.create("exp1", total_tasks=1)
    mgr.start(running.job_id)
    mgr.mark_task(running.job_id, "t1", "completed", artifact_id="a1")
    mgr.start(done.job_id)
    mgr.mark_task(done.job_id, "t1", "completed", artifact_id="x")
    mgr.finish(done.job_id)

    restarted = JobManager(tmp_path)  # simulated server restart
    assert sorted(restarted.recover()) == sorted([queued.job_id, running.job_id])
    r = restarted.get(running.job_id)
    assert (
        r.state == "interrupted" and r.tasks.completed == 1 and r.completed_artifact_ids == ["a1"]
    )
    assert restarted.get(queued.job_id).state == "interrupted"
    assert restarted.get(done.job_id).state == "completed"
    assert restarted.recover() == []


def test_mark_task_requires_reason_for_failure(tmp_path):
    mgr = JobManager(tmp_path)
    job = mgr.create("exp1", total_tasks=1)
    mgr.start(job.job_id)
    with pytest.raises(ValueError):
        mgr.mark_task(job.job_id, "t1", "failed")
    with pytest.raises(ValueError):
        mgr.mark_task(job.job_id, "t1", "exploded")  # type: ignore[arg-type]


# --- worker ------------------------------------------------------------------------------------


def test_run_inline_completes_and_commits(tmp_path):
    mgr = JobManager(tmp_path)
    job = mgr.create("exp1")
    final = run_inline(tmp_path, job.job_id, _tasks())
    assert final.state == "completed"
    assert final.tasks.model_dump() == {
        "total": 3,
        "completed": 3,
        "failed": 0,
        "skipped": 0,
        "reused": 0,
    }
    assert final.completed_artifact_ids == ["a1", "a2", "a3"]
    stored = ArtifactStore(tmp_path).get("exp1", "a3")
    np.testing.assert_array_equal(stored.array, [2.0, 2.0, 2.0])
    assert stored.manifest.parents == ["a1", "a2"]


def test_resume_skips_completed_tasks_and_recomputes_corrupt(tmp_path):
    mgr = JobManager(tmp_path)
    store = ArtifactStore(tmp_path)
    job = mgr.create("exp1")
    store.put_array("exp1", "a1", np.ones(3), kind="array")  # committed before the "crash"
    mgr.start(job.job_id, total_tasks=3)
    JobManager(tmp_path).recover()
    assert mgr.get(job.job_id).state == "interrupted"

    mgr.resume(job.job_id)
    final = run_inline(tmp_path, job.job_id, _tasks())
    assert final.state == "completed"
    assert (final.tasks.reused, final.tasks.completed) == (1, 2)

    # resume again with a corrupted a2: a1/a3 reused, a2 recomputed (never reused)
    a2 = tmp_path / "benchmarks" / "exp1" / "a2.npy"
    data = bytearray(a2.read_bytes())
    data[-1] ^= 0xFF
    a2.write_bytes(bytes(data))
    job2 = mgr.create("exp1")
    final2 = run_inline(tmp_path, job2.job_id, _tasks())
    assert (final2.tasks.reused, final2.tasks.completed) == (2, 1)
    assert store.verify("exp1", "a2")


def test_cancel_mid_job_keeps_committed_artifacts(tmp_path):
    mgr = JobManager(tmp_path)
    job = mgr.create("exp1")
    tasks = [
        TaskSpec(task_id="t1", target=_t("make_ones"), params={"n": 2}, output="c1"),
        TaskSpec(
            task_id="t2",
            target=_t("cancel_self"),
            params={"root": str(tmp_path), "job_id": job.job_id},
            output="c2",
        ),
        TaskSpec(task_id="t3", target=_t("make_ones"), params={"n": 2}, output="c3"),
    ]
    final = run_inline(tmp_path, job.job_id, tasks)
    assert final.state == "cancelled" and final.cancel_requested
    assert (final.tasks.total, final.tasks.completed) == (3, 2)
    store = ArtifactStore(tmp_path)
    assert store.verify("exp1", "c1") and store.verify("exp1", "c2")
    assert not store.exists("exp1", "c3")

    # resume after cancel reuses both committed artifacts and finishes the rest
    mgr.resume(job.job_id)
    tasks[1] = TaskSpec(task_id="t2", target=_t("make_ones"), params={"n": 2}, output="c2")
    resumed = run_inline(tmp_path, job.job_id, tasks)
    assert resumed.state == "completed" and (resumed.tasks.reused, resumed.tasks.completed) == (
        2,
        1,
    )


def test_cancel_before_start(tmp_path):
    mgr = JobManager(tmp_path)
    job = mgr.create("exp1")
    assert mgr.request_cancel(job.job_id).state == "cancelled"
    assert run_inline(tmp_path, job.job_id, _tasks()).state == "cancelled"
    assert not ArtifactStore(tmp_path).exists("exp1", "a1")


def test_partial_failure_keeps_counts_and_continues_independent_tasks(tmp_path):
    mgr = JobManager(tmp_path)
    job = mgr.create("exp1")
    tasks = [
        TaskSpec(task_id="ok1", target=_t("make_ones"), params={"n": 1}, output="p1"),
        TaskSpec(task_id="bad", target=_t("boom"), output="p2"),
        TaskSpec(task_id="dep", target=_t("add_inputs"), inputs=["p2"], output="p3"),
        TaskSpec(task_id="ok2", target=_t("make_ones"), params={"n": 1}, output="p4"),
        TaskSpec(task_id="missing", target="neurobridge.no_such_module:fn", output="p5"),
    ]
    final = run_inline(tmp_path, job.job_id, tasks)
    assert final.state == "failed"
    assert final.tasks.model_dump() == {
        "total": 5,
        "completed": 2,
        "failed": 2,
        "skipped": 1,
        "reused": 0,
    }
    reasons = {f.task_id: f.reason_code for f in final.failures}
    assert reasons == {
        "bad": "task_exception",
        "dep": "dependency_unavailable",
        "missing": "task_exception",
    }
    assert "planned failure" in next(f.message for f in final.failures if f.task_id == "bad")
    assert final.completed_artifact_ids == ["p1", "p4"]
    assert JobManager(tmp_path).get(job.job_id).tasks.failed == 2


def test_task_specs_validated(tmp_path):
    with pytest.raises(ValueError):
        TaskSpec(task_id="t", target="not a target", output="o")
    with pytest.raises(ValueError):
        TaskSpec(task_id="t", target=_t("make_ones"), output="../o")
    mgr = JobManager(tmp_path)
    job = mgr.create("exp1")
    out_of_order = list(reversed(_tasks()))
    with pytest.raises(ValueError, match="before it is produced"):
        run_inline(tmp_path, job.job_id, out_of_order)


def test_spawned_process_worker_with_thread_caps(tmp_path, monkeypatch):
    monkeypatch.setenv("OMP_NUM_THREADS", "8")
    mgr = JobManager(tmp_path)
    job = mgr.create("exp1")
    tasks = [
        *_tasks(),
        TaskSpec(task_id="env", target=_t("thread_env"), output="env"),
    ]
    proc = start_process(tmp_path, job.job_id, [t.model_dump() for t in tasks])
    proc.join(timeout=120)
    assert proc.exitcode == 0
    assert os.environ["OMP_NUM_THREADS"] == "8"  # parent env restored
    final = mgr.get(job.job_id)
    assert final.state == "completed" and final.tasks.completed == 4
    np.testing.assert_array_equal(ArtifactStore(tmp_path).get("exp1", "env").array, [1.0, 1.0])
