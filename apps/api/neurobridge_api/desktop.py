"""Desktop entry point: one local server for the packaged app (API under ``/api`` + web build).

The desktop shell (Electrobun) starts this process with::

    neurosignal-desktop --port 0 --data-dir DIR --web-dir DIST --parent-pid PID --ready-stdout

The socket is bound before serving, so ``--port 0`` resolves to a free port that is announced
on stdout as exactly one line once the server accepts connections::

    NEUROSIGNAL_READY {"port": 51234, "pid": 4321, "version": "0.2.5"}

After that line fd 1 is redirected to stderr, so nothing else ever reaches stdout. The scientific
API (``neurobridge_api.main:app``, unchanged) is mounted under ``/api`` and the built web app is
served at ``/`` with an ``index.html`` fallback for client-side routes. All writable state goes
under ``--data-dir``. The process exits when SIGTERM/SIGINT arrives or when ``--parent-pid``
dies; spawned job workers are terminated on the way out (their jobs are recovered as
``interrupted`` by the next start).
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import signal
import socket
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

READY_PREFIX = "NEUROSIGNAL_READY"
SHUTDOWN_GRACE_S = 10.0
WORKER_STOP_TIMEOUT_S = 5.0


def _configure_environment(data_dir: Path) -> None:
    """Point every writable root at ``data_dir`` before scientific modules are imported."""
    data_dir.mkdir(parents=True, exist_ok=True)
    # App storage roots: the data dir is authoritative for the desktop app.
    os.environ["NEUROSIGNAL_BENCHMARK_ROOT"] = str(data_dir)
    os.environ["NEUROSIGNAL_PROJECTS_DIR"] = str(data_dir / "projects")
    # Library caches and configs: keep explicit overrides from the environment.
    defaults = {
        "NUMBA_CACHE_DIR": data_dir / "cache" / "numba",
        "MPLCONFIGDIR": data_dir / "cache" / "matplotlib",
        "MNE_DATA": data_dir / "mne_data",
        "TVB_USER_HOME": data_dir / "tvb",
    }
    for key, path in defaults.items():
        if not os.environ.get(key):
            Path(path).mkdir(parents=True, exist_ok=True)
            os.environ[key] = str(path)
    os.environ.setdefault("MPLBACKEND", "Agg")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="neurosignal-desktop", description="NeuroSignal desktop backend (local only)"
    )
    parser.add_argument("--port", type=int, default=0, help="TCP port; 0 picks a free port")
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1"])
    parser.add_argument("--data-dir", type=Path, required=True, help="writable app data root")
    parser.add_argument("--web-dir", type=Path, help="built web app (apps/web/dist)")
    parser.add_argument("--parent-pid", type=int, help="exit when this process dies")
    parser.add_argument("--ready-stdout", action="store_true", help="print the READY line")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    if args.web_dir is not None:
        args.web_dir = args.web_dir.expanduser().resolve()
        if not (args.web_dir / "index.html").is_file():
            parser.error(f"--web-dir has no index.html: {args.web_dir}")
    args.data_dir = args.data_dir.expanduser().resolve()
    return args


def _parent_alive(pid: int, original_ppid: int) -> bool:
    if pid == original_ppid and os.getppid() != pid:
        return False  # we were re-parented: the launching process is gone
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _stop_workers(timeout_s: float = WORKER_STOP_TIMEOUT_S) -> None:
    """Terminate spawned job workers so they never outlive the app."""
    children = multiprocessing.active_children()
    for child in children:
        child.terminate()
    deadline = time.monotonic() + timeout_s
    for child in children:
        child.join(max(0.0, deadline - time.monotonic()))
        if child.is_alive():
            child.kill()
            child.join(1.0)


def _hard_exit_later(delay_s: float) -> None:
    def _exit() -> None:
        time.sleep(delay_s)
        _stop_workers(1.0)
        os._exit(0)

    threading.Thread(target=_exit, name="neurosignal-hard-exit", daemon=True).start()


def build_app(web_dir: Path | None):
    """The single ASGI app: scientific API under ``/api`` and the SPA at ``/``."""
    from starlette.applications import Starlette
    from starlette.exceptions import HTTPException
    from starlette.routing import Mount
    from starlette.staticfiles import StaticFiles

    from neurobridge_api.main import app as api

    class SpaStaticFiles(StaticFiles):
        async def get_response(self, path, scope):
            try:
                return await super().get_response(path, scope)
            except HTTPException as error:
                # Client-side routes have no file extension; missing assets stay 404.
                if error.status_code != 404 or "." in Path(path).name:
                    raise
                return await super().get_response("index.html", scope)

    @asynccontextmanager
    async def lifespan(_app):
        # Mounted apps get no lifespan events; run the API's (job recovery) here.
        async with api.router.lifespan_context(api):
            yield

    routes = [Mount("/api", app=api)]
    if web_dir is not None:
        routes.append(Mount("/", app=SpaStaticFiles(directory=web_dir, html=True)))
    return Starlette(routes=routes, lifespan=lifespan)


def main(argv: list[str] | None = None) -> int:
    multiprocessing.freeze_support()  # frozen (PyInstaller) worker processes stop here
    args = _parse_args(argv)
    _configure_environment(args.data_dir)

    import uvicorn
    from neurobridge import __version__

    application = build_app(args.web_dir)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    sock.listen(128)
    port = sock.getsockname()[1]

    def announce() -> None:
        if args.ready_stdout:
            payload = {"port": port, "pid": os.getpid(), "version": __version__}
            sys.stdout.write(f"{READY_PREFIX} {json.dumps(payload)}\n")
            sys.stdout.flush()
            os.dup2(sys.stderr.fileno(), sys.stdout.fileno())  # nothing else on stdout
        else:
            print(f"NeuroSignal desktop backend on http://{args.host}:{port}", file=sys.stderr)

    class DesktopServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            if not self.should_exit:
                announce()

    config = uvicorn.Config(
        application,
        host=args.host,
        port=port,
        log_level="info",
        access_log=False,
        timeout_graceful_shutdown=5,
    )
    server = DesktopServer(config)

    if args.parent_pid:
        original_ppid = os.getppid()

        def watch_parent() -> None:
            while _parent_alive(args.parent_pid, original_ppid):
                time.sleep(1.0)
            print(f"parent {args.parent_pid} exited; shutting down", file=sys.stderr)
            server.should_exit = True
            _hard_exit_later(SHUTDOWN_GRACE_S)

        threading.Thread(target=watch_parent, name="neurosignal-parent-watch", daemon=True).start()

    # uvicorn re-raises the signal it shut down for; make that a no-op so the exit code is 0.
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: None)
    try:
        server.run(sockets=[sock])
    finally:
        _stop_workers()
        _hard_exit_later(SHUTDOWN_GRACE_S)  # never hang on leftover non-daemon threads
    return 0


if __name__ == "__main__":
    sys.exit(main())
