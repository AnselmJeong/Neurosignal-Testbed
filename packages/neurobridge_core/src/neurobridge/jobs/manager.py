"""Persistent benchmark job index (stdlib sqlite3) storing :class:`JobManifest` JSON.

The index lives at ``<root>/benchmarks/jobs.sqlite`` and is shared by the API process and worker
processes. Every read-modify-write runs inside ``BEGIN IMMEDIATE`` so concurrent writers (e.g. a
cancel request arriving while the worker records a task) never lose updates.

Lifecycle: ``create`` (queued) -> ``start`` (running) -> ``mark_task``/``update_stage`` ->
``finish`` (completed | failed | cancelled). After a server restart call :meth:`recover`: jobs
left ``queued`` or ``running`` become ``interrupted`` — never ``completed``. :meth:`resume` puts a
non-running job back to ``queued`` so a worker can rerun it, reusing committed artifacts.
"""

from __future__ import annotations

import os
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from neurobridge.artifacts.store import validate_id
from neurobridge.benchmarks.contracts import JobFailure, JobManifest, JobState, TaskCounts

__all__ = ["ACTIVE_STATES", "TERMINAL_STATES", "JobManager", "JobNotFoundError", "TaskOutcome"]

TaskOutcome = Literal["completed", "failed", "skipped", "reused"]
ACTIVE_STATES: tuple[JobState, ...] = ("queued", "running")
TERMINAL_STATES: tuple[JobState, ...] = ("completed", "failed", "cancelled", "interrupted")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    state TEXT NOT NULL,
    manifest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_experiment ON jobs (experiment_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state);
"""


class JobNotFoundError(KeyError):
    """No job with the requested ID exists in the index."""


class JobManager:
    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root).resolve()
        self.db_path = self.root / "benchmarks" / "jobs.sqlite"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA)

    # ------------------------------------------------------------------ sqlite
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0, isolation_level=None)
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")
        finally:
            conn.close()

    @staticmethod
    def _load(conn: sqlite3.Connection, job_id: str) -> JobManifest:
        row = conn.execute("SELECT manifest FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            raise JobNotFoundError(job_id)
        return JobManifest.model_validate_json(row[0])

    @staticmethod
    def _save(conn: sqlite3.Connection, job: JobManifest) -> JobManifest:
        job = job.model_copy(update={"updated_at": datetime.now(UTC)})
        job = JobManifest.model_validate(job.model_dump())  # re-run contract validators
        conn.execute(
            "UPDATE jobs SET state = ?, manifest = ?, updated_at = ? WHERE job_id = ?",
            (job.state, job.model_dump_json(), job.updated_at.isoformat(), job.job_id),
        )
        return job

    # ------------------------------------------------------------------ API
    def create(
        self,
        experiment_id: str,
        *,
        total_tasks: int = 0,
        job_id: str | None = None,
        stage: str | None = None,
    ) -> JobManifest:
        validate_id(experiment_id, what="experiment id")
        job_id = validate_id(job_id or f"job-{uuid.uuid4().hex}", what="job id")
        job = JobManifest(
            job_id=job_id,
            experiment_id=experiment_id,
            stage=stage,
            tasks=TaskCounts(total=total_tasks),
        )
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO jobs (job_id, experiment_id, state, manifest, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    job.job_id,
                    job.experiment_id,
                    job.state,
                    job.model_dump_json(),
                    job.created_at.isoformat(),
                    job.updated_at.isoformat(),
                ),
            )
        return job

    def get(self, job_id: str) -> JobManifest:
        conn = self._connect()
        try:
            return self._load(conn, job_id)
        finally:
            conn.close()

    def list(
        self, experiment_id: str | None = None, *, states: tuple[str, ...] | None = None
    ) -> list[JobManifest]:
        query = "SELECT manifest FROM jobs"
        clauses: list[str] = []
        args: list[str] = []
        if experiment_id is not None:
            clauses.append("experiment_id = ?")
            args.append(experiment_id)
        if states:
            clauses.append(f"state IN ({','.join('?' * len(states))})")
            args.extend(states)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at, job_id"
        conn = self._connect()
        try:
            rows = conn.execute(query, args).fetchall()
        finally:
            conn.close()
        return [JobManifest.model_validate_json(r[0]) for r in rows]

    def start(self, job_id: str, *, total_tasks: int | None = None) -> JobManifest:
        """Mark a queued job running and reset its per-run counts/failures."""
        with self._tx() as conn:
            job = self._load(conn, job_id)
            if job.state != "queued":
                raise ValueError(f"job {job_id} is {job.state}, not queued")
            total = job.tasks.total if total_tasks is None else total_tasks
            return self._save(
                conn,
                job.model_copy(
                    update={
                        "state": "running",
                        "tasks": TaskCounts(total=total),
                        "failures": [],
                        "completed_artifact_ids": [],
                    }
                ),
            )

    def update_stage(self, job_id: str, stage: str | None) -> JobManifest:
        with self._tx() as conn:
            job = self._load(conn, job_id)
            return self._save(conn, job.model_copy(update={"stage": stage}))

    def mark_task(
        self,
        job_id: str,
        task_id: str,
        outcome: TaskOutcome,
        *,
        artifact_id: str | None = None,
        reason_code: str | None = None,
        message: str | None = None,
    ) -> JobManifest:
        """Count one task outcome. ``failed`` requires ``reason_code``; failed and skipped tasks
        with a reason are appended to ``failures``; completed/reused artifacts are recorded."""
        if outcome not in ("completed", "failed", "skipped", "reused"):
            raise ValueError(f"unknown task outcome: {outcome!r}")
        if outcome == "failed" and not reason_code:
            raise ValueError("a failed task needs a reason_code")
        with self._tx() as conn:
            job = self._load(conn, job_id)
            counts = job.tasks.model_dump()
            counts[outcome] += 1
            if (
                sum(counts[k] for k in ("completed", "failed", "skipped", "reused"))
                > counts["total"]
            ):
                counts["total"] += 1
            update: dict = {"tasks": TaskCounts(**counts)}
            if outcome in ("completed", "reused") and artifact_id is not None:
                if artifact_id not in job.completed_artifact_ids:
                    update["completed_artifact_ids"] = [*job.completed_artifact_ids, artifact_id]
            if reason_code and outcome in ("failed", "skipped"):
                failure = JobFailure(task_id=task_id, reason_code=reason_code, message=message)
                update["failures"] = [*job.failures, failure]
            return self._save(conn, job.model_copy(update=update))

    def request_cancel(self, job_id: str) -> JobManifest:
        """Set the cooperative cancel flag; a queued job that never started is cancelled now."""
        with self._tx() as conn:
            job = self._load(conn, job_id)
            if job.state in TERMINAL_STATES:
                return job
            update: dict = {"cancel_requested": True}
            if job.state == "queued":
                update["state"] = "cancelled"
            return self._save(conn, job.model_copy(update=update))

    def is_cancel_requested(self, job_id: str) -> bool:
        return self.get(job_id).cancel_requested

    def finish(self, job_id: str, state: JobState | None = None) -> JobManifest:
        """Close a running job. Default state: cancelled if a cancel was requested and tasks
        remain, failed if any task failed, otherwise completed."""
        with self._tx() as conn:
            job = self._load(conn, job_id)
            if state is None:
                t = job.tasks
                done = t.completed + t.failed + t.skipped + t.reused
                if job.cancel_requested and done < t.total:
                    state = "cancelled"
                elif t.failed:
                    state = "failed"
                else:
                    state = "completed"
            return self._save(conn, job.model_copy(update={"state": state}))

    def recover(self) -> list[str]:
        """Startup recovery: queued/running jobs (no live worker) become ``interrupted``.

        Call only when no worker of this index is alive (e.g. at API startup)."""
        recovered: list[str] = []
        with self._tx() as conn:
            rows = conn.execute(
                "SELECT job_id FROM jobs WHERE state IN (?, ?)", ACTIVE_STATES
            ).fetchall()
            for (job_id,) in rows:
                job = self._load(conn, job_id)
                self._save(conn, job.model_copy(update={"state": "interrupted"}))
                recovered.append(job_id)
        return recovered

    def resume(self, job_id: str) -> JobManifest:
        """Re-queue an interrupted/cancelled/failed job (clears the cancel flag)."""
        with self._tx() as conn:
            job = self._load(conn, job_id)
            if job.state in ACTIVE_STATES:
                raise ValueError(f"job {job_id} is still {job.state}")
            if job.state == "completed":
                raise ValueError(f"job {job_id} already completed")
            return self._save(
                conn, job.model_copy(update={"state": "queued", "cancel_requested": False})
            )
