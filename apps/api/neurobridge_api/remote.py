"""Password-protected production frontend and API for an outbound HTTPS tunnel."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import secrets
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles

from neurobridge_api.main import app as scientific_api

ROOT = Path(__file__).resolve().parents[3]


def create_remote_app(
    auth_file: Path | None = None,
    dist_dir: Path | None = None,
) -> FastAPI:
    credentials = json.loads(
        (auth_file or Path(os.environ["NEUROSIGNAL_REMOTE_AUTH_FILE"])).read_text()
    )
    username, password = credentials["username"], credentials["password"]
    if not username or len(password) < 24:
        raise ValueError("Remote access requires a username and at least 24 password characters")
    expected = hashlib.sha256(f"{username}:{password}".encode()).digest()
    application = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @application.middleware("http")
    async def authenticate(request: Request, call_next):
        header = request.headers.get("authorization", "")
        try:
            scheme, encoded = header.split(" ", 1)
            decoded = base64.b64decode(encoded, validate=True)
            valid = scheme.lower() == "basic" and secrets.compare_digest(
                hashlib.sha256(decoded).digest(), expected
            )
        except (ValueError, binascii.Error):
            valid = False
        if not valid:
            response = PlainTextResponse(
                "Sign in to NeuroSignal.",
                status_code=401,
                headers={"WWW-Authenticate": 'Basic realm="NeuroSignal"'},
            )
        elif request.method not in {"GET", "HEAD", "OPTIONS"} and (
            request.headers.get("origin")
            and urlsplit(request.headers["origin"]).netloc != request.headers.get("host")
        ):
            response = PlainTextResponse("Cross-origin requests are not allowed.", status_code=403)
        else:
            response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    application.mount("/api", scientific_api)
    application.mount("/", StaticFiles(directory=dist_dir or ROOT / "apps/web/dist", html=True))
    return application
