#!/usr/bin/env python3
"""Start/stop a password-protected temporary Cloudflare URL without changing LAN bindings."""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".remote-access"
AUTH = STATE / "credentials.json"
RUN = STATE / "run.json"
PYTHON = ROOT / ".venv/bin/python"
PORT = 8765


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def stop():
    if not RUN.exists():
        print("Remote access is not running.")
        return
    state = json.loads(RUN.read_text())
    for key, marker in [("tunnel_pid", "cloudflared"), ("server_pid", "neurobridge_api.remote")]:
        pid = state[key]
        command = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True
        ).stdout
        if marker in command:
            os.kill(pid, signal.SIGTERM)
    RUN.unlink()
    print("Remote access stopped. Local development servers were not changed.")


def start():
    if RUN.exists():
        prior = json.loads(RUN.read_text())
        if alive(prior["server_pid"]) and alive(prior["tunnel_pid"]):
            print(json.dumps(prior, indent=2))
            return
        stop()
    cloudflared = shutil.which("cloudflared")
    if not cloudflared:
        raise SystemExit("Install cloudflared first: brew install cloudflared")
    if not (ROOT / "apps/web/dist/index.html").exists():
        raise SystemExit("Build the web client first: npm --prefix apps/web run build")
    STATE.mkdir(mode=0o700, exist_ok=True)
    STATE.chmod(0o700)
    if not AUTH.exists():
        # Credentials never appear in command-line arguments, logs or source control.
        fd = os.open(AUTH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump({"username": "neurosignal", "password": secrets.token_urlsafe(24)}, handle)
    AUTH.chmod(0o600)
    env = {**os.environ, "NEUROSIGNAL_REMOTE_AUTH_FILE": str(AUTH)}
    with (STATE / "server.log").open("w") as log:
        server = subprocess.Popen(
            [
                str(PYTHON),
                "-m",
                "uvicorn",
                "neurobridge_api.remote:create_remote_app",
                "--factory",
                "--host",
                "127.0.0.1",
                "--port",
                str(PORT),
                "--no-access-log",
            ],
            cwd=ROOT,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    tunnel = None
    try:
        ready = False
        for _ in range(60):
            if server.poll() is not None:
                raise RuntimeError("Remote server stopped; inspect .remote-access/server.log")
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=1)
            except urllib.error.HTTPError as error:
                if error.code == 401:
                    ready = True
                    break
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.2)
        if not ready:
            raise RuntimeError("The protected server did not become ready")
        log_path = STATE / "tunnel.log"
        with log_path.open("w") as log:
            tunnel = subprocess.Popen(
                [
                    cloudflared,
                    "tunnel",
                    "--no-autoupdate",
                    "--protocol",
                    "http2",
                    "--url",
                    f"http://127.0.0.1:{PORT}",
                ],
                cwd=ROOT,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        for _ in range(100):
            if tunnel.poll() is not None:
                raise RuntimeError("Tunnel stopped; inspect .remote-access/tunnel.log")
            match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", log_path.read_text())
            if match:
                state = {
                    "url": match[0],
                    "server_pid": server.pid,
                    "tunnel_pid": tunnel.pid,
                    "credentials_file": str(AUTH),
                    "temporary": True,
                }
                RUN.write_text(json.dumps(state, indent=2))
                print(json.dumps(state, indent=2))
                return
            time.sleep(0.3)
        raise RuntimeError("Cloudflare did not assign a URL; inspect .remote-access/tunnel.log")
    except BaseException:
        if tunnel is not None:
            tunnel.terminate()
        server.terminate()
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "stop", "status"])
    args = parser.parse_args()
    if args.action == "start":
        start()
    elif args.action == "stop":
        stop()
    else:
        print(RUN.read_text() if RUN.exists() else "Remote access is not running.")
