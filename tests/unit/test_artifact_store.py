from __future__ import annotations

import json

import numpy as np
import pytest
from neurobridge.artifacts import (
    ArtifactExistsError,
    ArtifactIntegrityError,
    ArtifactNotFoundError,
    ArtifactStore,
    UnsafeIdError,
    cache_key,
)


def _corrupt(path):
    data = bytearray(path.read_bytes())
    data[-1] ^= 0xFF
    path.write_bytes(bytes(data))


def test_roundtrip_is_float64_mmap_with_manifest(tmp_path):
    store = ArtifactStore(tmp_path)
    manifest = store.put_array(
        "exp1",
        "src",
        np.arange(6, dtype=np.int32).reshape(2, 3),
        kind="source",
        units="mV",
        axes=["node", "time"],
        versions={"numpy": np.__version__},
    )
    exp_dir = tmp_path / "benchmarks" / "exp1"
    assert (exp_dir / "src.npy").is_file() and (exp_dir / "src.json").is_file()
    assert manifest.shape == [2, 3] and manifest.dtype == "float64" and len(manifest.checksum) == 64
    on_disk = json.loads((exp_dir / "src.json").read_text())
    assert on_disk["checksum"] == manifest.checksum and on_disk["axes"] == ["node", "time"]

    loaded = store.get("exp1", "src")
    assert isinstance(loaded.array, np.memmap) and loaded.array.dtype == np.float64
    np.testing.assert_array_equal(loaded.array, np.arange(6).reshape(2, 3))
    with pytest.raises(ValueError):
        loaded.array[0, 0] = 1.0  # read-only
    assert not list(exp_dir.glob(".*tmp"))
    assert [m.artifact_id for m in store.list_artifacts("exp1")] == ["src"]


def test_checksum_mismatch_refuses_reuse(tmp_path):
    store = ArtifactStore(tmp_path)
    store.put_array("exp1", "a", np.ones(8), kind="x")
    _corrupt(tmp_path / "benchmarks" / "exp1" / "a.npy")
    assert store.exists("exp1", "a")
    assert not store.verify("exp1", "a")
    with pytest.raises(ArtifactIntegrityError, match="checksum mismatch"):
        store.get("exp1", "a")
    # a corrupt artifact may be recomputed; afterwards it verifies again
    store.put_array("exp1", "a", np.ones(8), kind="x")
    assert store.verify("exp1", "a")


def test_artifacts_are_immutable_but_idempotent(tmp_path):
    store = ArtifactStore(tmp_path)
    first = store.put_array("exp1", "a", [1.0, 2.0], kind="x")
    again = store.put_array("exp1", "a", [1.0, 2.0], kind="x")
    assert again.checksum == first.checksum and again.created_at == first.created_at
    with pytest.raises(ArtifactExistsError):
        store.put_array("exp1", "a", [1.0, 3.0], kind="x")
    np.testing.assert_array_equal(store.get("exp1", "a").array, [1.0, 2.0])


@pytest.mark.parametrize(
    "bad", ["../escape", "..", ".", "a/b", "/abs", "a\\b", "", ".hidden", "a..b", "x" * 200]
)
def test_traversal_and_unsafe_ids_rejected(tmp_path, bad):
    store = ArtifactStore(tmp_path)
    with pytest.raises(UnsafeIdError):
        store.put_array(bad, "a", [1.0], kind="x")
    with pytest.raises(UnsafeIdError):
        store.put_array("exp1", bad, [1.0], kind="x")
    with pytest.raises(UnsafeIdError):
        store.get("exp1", bad)
    assert not any(p.name != "benchmarks" for p in tmp_path.iterdir())


def test_symlinked_experiment_outside_root_rejected(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    store = ArtifactStore(tmp_path / "root")
    (tmp_path / "root" / "benchmarks").mkdir(parents=True)
    (tmp_path / "root" / "benchmarks" / "evil").symlink_to(outside, target_is_directory=True)
    with pytest.raises(UnsafeIdError):
        store.put_array("evil", "a", [1.0], kind="x")
    assert not list(outside.iterdir())


def test_experiments_are_isolated(tmp_path):
    store = ArtifactStore(tmp_path)
    store.put_array("expA", "shared", [1.0], kind="x")
    store.put_array("expB", "shared", [2.0], kind="x")
    assert store.get("expA", "shared").array[0] == 1.0
    assert store.get("expB", "shared").array[0] == 2.0
    store.put_array("expA", "only_a", [3.0], kind="x")
    with pytest.raises(ArtifactNotFoundError):
        store.get("expB", "only_a")


def test_no_pickle(tmp_path):
    store = ArtifactStore(tmp_path)
    with pytest.raises(TypeError):
        store.put_array("exp1", "obj", np.array([{"a": 1}], dtype=object), kind="x")
    # a pickled .npy smuggled in place of a committed array is refused on load
    store.put_array("exp1", "a", [1.0], kind="x")
    np.save(tmp_path / "benchmarks" / "exp1" / "a.npy", np.array([object()]), allow_pickle=True)
    with pytest.raises(ArtifactIntegrityError):
        store.get("exp1", "a")


def test_cache_key_is_canonical_and_content_addressed():
    k1 = cache_key("metric", {"b": 2, "a": [1, 2.5]}, ["p2", "p1"])
    k2 = cache_key("metric", {"a": [1, 2.5], "b": 2}, ["p1", "p2"])
    assert k1 == k2 and k1.startswith("metric-") and len(k1) == len("metric-") + 32
    assert cache_key("metric", {"a": [1, 2.5], "b": 3}, ["p1", "p2"]) != k1
    assert cache_key("metric", {"a": [1, 2.5], "b": 2}, ["p1", "p3"]) != k1
    assert cache_key("observe", {"a": [1, 2.5], "b": 2}, ["p1", "p2"]) != k1
    assert cache_key("metric", {"x": np.float64(1.5)}) == cache_key("metric", {"x": 1.5})
    with pytest.raises(ValueError):
        cache_key("metric", {"x": float("nan")})
    with pytest.raises(UnsafeIdError):
        cache_key("../stage", {})
