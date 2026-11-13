"""Desktop entry (``neurobridge_api.desktop``) as the Electrobun shell starts it.

Each test starts a real subprocess with ``--port 0 --ready-stdout``, reads the single READY line
and talks HTTP to 127.0.0.1 only. Library caches (numba, matplotlib) are shared across the
servers of this module so only the first start pays the cold-cache cost.
"""

from __future__ import annotations

import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[2]
PREVIEW = REPO / "fixtures" / "recipes" / "flow-preview.json"
READY = re.compile(r'^NEUROSIGNAL_READY \{"port": (\d+), "pid": (\d+), "version": "([^"]+)"\}$')
INDEX = "<!doctype html><title>NeuroSignal desktop test</title>"
READY_TIMEOUT_S = 240.0


class Backend:
    def __init__(self, proc: subprocess.Popen[str], port: int, ready_line: str) -> None:
        self.proc, self.port, self.ready_line = proc, port, ready_line

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    def get(self, path: str) -> tuple[int, str, str]:
        try:
            with urllib.request.urlopen(self.url(path), timeout=30) as response:
                return response.status, response.headers["content-type"], response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.headers["content-type"], error.read().decode()

    def post(self, path: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        request = urllib.request.Request(
            self.url(path),
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def stop(self) -> int:
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
        return self.proc.wait(timeout=60)


@pytest.fixture(scope="module")
def shared_env(tmp_path_factory) -> dict[str, str]:
    caches = tmp_path_factory.mktemp("desktop-caches")
    skip = ("NEUROSIGNAL_", "NEUROBRIDGE_")
    env = {k: v for k, v in os.environ.items() if not k.startswith(skip)}
    env.update(NUMBA_CACHE_DIR=str(caches / "numba"), MPLCONFIGDIR=str(caches / "matplotlib"))
    return env


@pytest.fixture(scope="module")
def web_dir(tmp_path_factory) -> Path:
    web = tmp_path_factory.mktemp("web")
    (web / "assets").mkdir()
    (web / "index.html").write_text(INDEX)
    (web / "assets" / "app.js").write_text("console.log('ok')")
    return web


def _start(
    data_dir: Path, web_dir: Path, env: dict[str, str], parent_pid: int | None = None
) -> Backend:
    command = [
        sys.executable, "-m", "neurobridge_api.desktop",
        "--port", "0", "--host", "127.0.0.1",
        "--data-dir", str(data_dir), "--web-dir", str(web_dir), "--ready-stdout",
    ]
    if parent_pid is not None:
        command += ["--parent-pid", str(parent_pid)]
    proc = subprocess.Popen(
        command, cwd=REPO, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
    )
    lines: queue.Queue[str] = queue.Queue()
    threading.Thread(target=lambda: lines.put(proc.stdout.readline()), daemon=True).start()
    try:
        line = lines.get(timeout=READY_TIMEOUT_S).rstrip("\n")
    except queue.Empty:
        proc.kill()
        pytest.fail("desktop backend printed no READY line")
    match = READY.match(line)
    assert match, f"unexpected first stdout line: {line!r} (exit {proc.poll()})"
    assert int(match.group(2)) == proc.pid
    return Backend(proc, int(match.group(1)), line)


@pytest.fixture(scope="module")
def backend(tmp_path_factory, web_dir, shared_env):
    server = _start(tmp_path_factory.mktemp("data"), web_dir, shared_env, parent_pid=os.getpid())
    yield server
    assert server.stop() == 0


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_ready_line_reports_port_pid_and_version(backend) -> None:
    from neurobridge import __version__

    assert backend.port > 0
    assert json.loads(backend.ready_line.split(" ", 1)[1]) == {
        "port": backend.port, "pid": backend.proc.pid, "version": __version__
    }


def test_api_is_mounted_under_api(backend) -> None:
    status, content_type, body = backend.get("/api/health")
    assert status == 200 and json.loads(body)["status"] == "ready"
    status, _, body = backend.get("/api/flow/concepts")
    assert status == 200 and json.loads(body)["entries"]
    status, content_type, _ = backend.get("/api/no-such-route")
    assert status == 404 and content_type == "application/json"  # API 404s never become HTML


def test_static_web_with_spa_fallback(backend) -> None:
    assert backend.get("/") == (200, "text/html; charset=utf-8", INDEX)
    assert backend.get("/some/spa/route") == (200, "text/html; charset=utf-8", INDEX)
    status, _, body = backend.get("/assets/app.js")
    assert status == 200 and body == "console.log('ok')"
    assert backend.get("/assets/missing.js")[0] == 404  # missing assets stay 404


def test_spawned_worker_runs_in_data_dir_and_sigterm_stops_everything(
    tmp_path, web_dir, shared_env
) -> None:
    data_dir = tmp_path / "data"
    server = _start(data_dir, web_dir, shared_env)
    try:
        recipe = json.loads(PREVIEW.read_text())
        recipe["title"] = "desktop worker test"
        recipe["simulation"].update(duration_s=20.0, burn_in_s=2.0)
        recipe["observation"]["n_sensors"] = 16
        status, created = server.post("/api/flow/runs", recipe)
        assert status == 202, created
        run_id, worker_pid = created["run_id"], created["job"]["worker"]["pid"]
        deadline = time.monotonic() + 180
        while True:  # "running" is written by the worker itself, so the spawned child works
            status, _, body = server.get(f"/api/flow/runs/{run_id}?include_result=false")
            state = json.loads(body)["state"]
            if state == "running":
                break
            assert state == "queued" and time.monotonic() < deadline, state
            time.sleep(0.5)
        assert (data_dir / "flow" / "benchmarks" / run_id).is_dir()
        assert (data_dir / "flow" / "benchmarks" / "jobs.sqlite").is_file()
        assert (data_dir / "benchmarks" / "jobs.sqlite").is_file()
        assert _alive(worker_pid)
    finally:
        returncode = server.stop()
    assert returncode == 0
    assert server.proc.stdout.read() == ""  # the READY line was the only stdout output
    assert not _alive(worker_pid)  # job workers never outlive the backend

    restarted = _start(data_dir, web_dir, shared_env)
    try:
        status, _, body = restarted.get(f"/api/flow/runs/{run_id}?include_result=false")
        assert status == 200 and json.loads(body)["state"] == "interrupted"
    finally:
        assert restarted.stop() == 0


def test_backend_exits_when_parent_pid_dies(tmp_path, web_dir, shared_env) -> None:
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
    try:
        server = _start(tmp_path / "data", web_dir, shared_env, parent_pid=parent.pid)
        assert server.get("/api/health")[0] == 200
    finally:
        parent.kill()
        parent.wait()  # reap it: a zombie still answers kill(pid, 0)
    assert server.proc.wait(timeout=30) == 0
