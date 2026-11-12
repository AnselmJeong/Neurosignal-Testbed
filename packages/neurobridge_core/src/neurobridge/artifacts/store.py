"""Immutable, checksummed benchmark artifact store.

Layout::

    <root>/benchmarks/<experiment_id>/<artifact_id>.npy    float64 array (mmap-readable)
    <root>/benchmarks/<experiment_id>/<artifact_id>.json   ArtifactManifest (commit marker)

Arrays are written with ``allow_pickle=False`` to a temporary file in the same directory and
moved into place with :func:`os.replace`; the manifest is replaced last, so an artifact is only
visible once both files are complete. The manifest stores the sha256 of the ``.npy`` file and
:meth:`ArtifactStore.get` refuses to return an artifact whose bytes no longer match it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from pydantic import ValidationError

from neurobridge.benchmarks.contracts import ArtifactManifest

__all__ = [
    "ArtifactError",
    "ArtifactExistsError",
    "ArtifactIntegrityError",
    "ArtifactNotFoundError",
    "ArtifactStore",
    "StoredArtifact",
    "UnsafeIdError",
    "cache_key",
    "canonical_json",
    "validate_id",
]

_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_CHUNK = 1 << 20


class ArtifactError(Exception):
    """Base class for artifact store errors."""


class UnsafeIdError(ArtifactError, ValueError):
    """An experiment or artifact ID is not a safe single path component."""


class ArtifactNotFoundError(ArtifactError, KeyError):
    """No committed artifact exists under the requested ID."""


class ArtifactIntegrityError(ArtifactError):
    """The stored bytes or manifest do not match; the artifact must not be reused."""


class ArtifactExistsError(ArtifactError, FileExistsError):
    """A valid artifact with different content already exists (artifacts are immutable)."""


@dataclass(frozen=True)
class StoredArtifact:
    manifest: ArtifactManifest
    array: np.ndarray


def validate_id(value: str, *, what: str = "id") -> str:
    """Return ``value`` if it is a safe single path component, else raise UnsafeIdError."""
    if not isinstance(value, str) or not _SAFE_ID.fullmatch(value) or ".." in value:
        raise UnsafeIdError(f"unsafe {what}: {value!r}")
    return value


def _json_default(obj: Any) -> Any:
    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, (set, frozenset)):
        return sorted(obj)
    raise TypeError(f"not JSON-serializable for a cache key: {type(obj).__name__}")


def canonical_json(value: Any) -> str:
    """Deterministic JSON (sorted keys, no whitespace, NaN/Inf rejected)."""
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
        default=_json_default,
    )


def cache_key(stage: str, params: Mapping[str, Any], parents: Iterable[str] = ()) -> str:
    """Content-addressed artifact ID ``<stage>-<sha256[:32]>``.

    The digest covers the stage name, the canonical JSON of ``params`` and the sorted parent
    artifact IDs, so changing any stage input yields a new key while unrelated stages keep theirs.
    Put order-sensitive roles (e.g. condition A vs B) into ``params``.
    """
    validate_id(stage, what="stage")
    parent_ids = sorted(validate_id(p, what="parent artifact id") for p in parents)
    payload = canonical_json({"stage": stage, "params": dict(params), "parents": parent_ids})
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"{stage}-{digest[:32]}"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


class ArtifactStore:
    """Per-experiment immutable array store rooted at ``<root>/benchmarks``."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root).resolve()
        self.base = self.root / "benchmarks"

    # ------------------------------------------------------------------ paths
    def experiment_dir(self, experiment_id: str, *, create: bool = False) -> Path:
        validate_id(experiment_id, what="experiment id")
        path = self.base / experiment_id
        if create:
            path.mkdir(parents=True, exist_ok=True)
        resolved = path.resolve()
        if resolved.parent != self.base.resolve():
            raise UnsafeIdError(f"experiment path escapes the store: {experiment_id!r}")
        return resolved

    def _paths(self, experiment_id: str, artifact_id: str, *, create: bool = False):
        validate_id(artifact_id, what="artifact id")
        exp_dir = self.experiment_dir(experiment_id, create=create)
        array_path = exp_dir / f"{artifact_id}.npy"
        manifest_path = exp_dir / f"{artifact_id}.json"
        for p in (array_path, manifest_path):
            if p.exists() and p.resolve().parent != exp_dir:
                raise UnsafeIdError(f"artifact path escapes the experiment: {artifact_id!r}")
        return exp_dir, array_path, manifest_path

    # ------------------------------------------------------------------ write
    def put_array(
        self,
        experiment_id: str,
        artifact_id: str,
        array: Any,
        *,
        kind: str,
        units: str | None = None,
        axes: Sequence[str] = (),
        parents: Sequence[str] = (),
        versions: Mapping[str, str] | None = None,
    ) -> ArtifactManifest:
        """Atomically commit ``array`` (cast to float64) and its manifest.

        Re-putting identical bytes returns the existing manifest. A valid artifact with different
        content raises :class:`ArtifactExistsError`; a corrupt one (checksum mismatch, broken
        manifest) is replaced, since it can never be reused anyway.
        """
        for parent in parents:
            validate_id(parent, what="parent artifact id")
        data = np.asarray(array)
        if data.dtype == object:
            raise TypeError("object arrays are not storable (no pickle)")
        data = np.ascontiguousarray(data, dtype=np.float64)
        exp_dir, array_path, manifest_path = self._paths(experiment_id, artifact_id, create=True)

        fd, tmp_name = tempfile.mkstemp(prefix=f".{artifact_id}.", suffix=".npy.tmp", dir=exp_dir)
        tmp_array = Path(tmp_name)
        tmp_manifest: Path | None = None
        try:
            with os.fdopen(fd, "wb") as fh:
                np.save(fh, data, allow_pickle=False)
                fh.flush()
                os.fsync(fh.fileno())
            checksum = _sha256_file(tmp_array)

            existing = self._read_manifest(manifest_path) if manifest_path.exists() else None
            if existing is not None and self._verify_paths(existing, array_path):
                if existing.checksum == checksum:
                    tmp_array.unlink(missing_ok=True)
                    return existing
                raise ArtifactExistsError(
                    f"artifact {experiment_id}/{artifact_id} already exists with other content"
                )

            manifest = ArtifactManifest(
                artifact_id=artifact_id,
                kind=kind,
                shape=list(data.shape),
                dtype="float64",
                units=units,
                axes=list(axes),
                checksum=checksum,
                parents=list(parents),
                versions=dict(versions or {}),
            )
            fd_m, tmp_m_name = tempfile.mkstemp(
                prefix=f".{artifact_id}.", suffix=".json.tmp", dir=exp_dir
            )
            tmp_manifest = Path(tmp_m_name)
            with os.fdopen(fd_m, "w", encoding="utf-8") as fh:
                fh.write(manifest.model_dump_json(indent=2) + "\n")
                fh.flush()
                os.fsync(fh.fileno())
            # Drop a stale manifest first so a crash between the replaces never pairs an old
            # manifest with new bytes as "valid"; the new manifest is the commit marker.
            manifest_path.unlink(missing_ok=True)
            os.replace(tmp_array, array_path)
            os.replace(tmp_manifest, manifest_path)
            _fsync_dir(exp_dir)
            return manifest
        finally:
            tmp_array.unlink(missing_ok=True)
            if tmp_manifest is not None:
                tmp_manifest.unlink(missing_ok=True)

    # ------------------------------------------------------------------ read
    @staticmethod
    def _read_manifest(path: Path) -> ArtifactManifest | None:
        try:
            return ArtifactManifest.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, ValidationError):
            return None

    @staticmethod
    def _verify_paths(manifest: ArtifactManifest, array_path: Path) -> bool:
        if not array_path.is_file():
            return False
        return _sha256_file(array_path) == manifest.checksum

    def exists(self, experiment_id: str, artifact_id: str) -> bool:
        """True if a manifest is committed (does not verify the checksum)."""
        _, _, manifest_path = self._paths(experiment_id, artifact_id)
        return manifest_path.is_file()

    def verify(self, experiment_id: str, artifact_id: str) -> bool:
        """True only if the artifact is committed and its bytes match the manifest checksum."""
        _, array_path, manifest_path = self._paths(experiment_id, artifact_id)
        if not manifest_path.is_file():
            return False
        manifest = self._read_manifest(manifest_path)
        if manifest is None or manifest.artifact_id != artifact_id:
            return False
        return self._verify_paths(manifest, array_path)

    def get_manifest(self, experiment_id: str, artifact_id: str) -> ArtifactManifest:
        _, _, manifest_path = self._paths(experiment_id, artifact_id)
        if not manifest_path.is_file():
            raise ArtifactNotFoundError(f"{experiment_id}/{artifact_id}")
        manifest = self._read_manifest(manifest_path)
        if manifest is None or manifest.artifact_id != artifact_id:
            raise ArtifactIntegrityError(f"unreadable manifest for {experiment_id}/{artifact_id}")
        return manifest

    def get(self, experiment_id: str, artifact_id: str, *, mmap: bool = True) -> StoredArtifact:
        """Load a committed artifact after verifying its checksum.

        Raises :class:`ArtifactNotFoundError` if absent and :class:`ArtifactIntegrityError` on
        checksum, shape or dtype mismatch. With ``mmap=True`` the array is a read-only memmap.
        """
        manifest = self.get_manifest(experiment_id, artifact_id)
        _, array_path, _ = self._paths(experiment_id, artifact_id)
        if not array_path.is_file():
            raise ArtifactIntegrityError(f"array file missing for {experiment_id}/{artifact_id}")
        actual = _sha256_file(array_path)
        if actual != manifest.checksum:
            raise ArtifactIntegrityError(
                f"checksum mismatch for {experiment_id}/{artifact_id}: "
                f"expected {manifest.checksum}, found {actual}"
            )
        array = np.load(array_path, mmap_mode="r" if mmap else None, allow_pickle=False)
        if list(array.shape) != manifest.shape or array.dtype != np.float64:
            raise ArtifactIntegrityError(f"shape/dtype mismatch for {experiment_id}/{artifact_id}")
        return StoredArtifact(manifest=manifest, array=array)

    def list_artifacts(self, experiment_id: str) -> list[ArtifactManifest]:
        """Committed manifests of one experiment (unverified; use :meth:`get` before reuse)."""
        exp_dir = self.experiment_dir(experiment_id)
        if not exp_dir.is_dir():
            return []
        out: list[ArtifactManifest] = []
        for path in sorted(exp_dir.glob("*.json")):
            if path.name.startswith(".") or not _SAFE_ID.fullmatch(path.stem):
                continue
            manifest = self._read_manifest(path)
            if manifest is not None and manifest.artifact_id == path.stem:
                out.append(manifest)
        return out
