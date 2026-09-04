import hashlib
import os

import mne
import numpy as np
import pytest
from fastapi.testclient import TestClient
from neurobridge.contracts.models import LocalImportRequest
from neurobridge.real_data import import_local_recording
from neurobridge.real_data.trace import trace_metadata, trace_window
from neurobridge_api.main import app


@pytest.fixture
def recording(tmp_path, monkeypatch):
    source = tmp_path / "source_raw.fif"
    times = np.arange(4000) / 200
    data = np.array([np.sin(times * 12), np.cos(times * 7), np.zeros(4000)]) * 1e-5
    data[0, 1337] = 0.005
    data[1, 702] = -0.007
    raw = mne.io.RawArray(data, mne.create_info(["Cz", "EOG", "STI"], 200,
                                              ["eeg", "eog", "stim"]),
                          first_samp=400, verbose=False)
    raw.info["bads"] = ["EOG"]
    raw.set_annotations(mne.Annotations([1, 3], [0, 0.5], ["stimulus", "BAD movement"]))
    raw.save(source, overwrite=False, verbose=False)
    root = tmp_path / "projects"
    imported = import_local_recording(LocalImportRequest(source_path=str(source)), root)
    monkeypatch.setenv("NEUROSIGNAL_PROJECTS_DIR", str(root))
    return source, root, imported.project.project_id


def test_points_envelope_and_annotations_match_mne_without_changing_files(recording):
    source, root, project_id = recording
    working = root / project_id / "recording_raw.fif"
    paths = [source, working, root / project_id / "project.json"]
    hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]
    metadata = trace_metadata(project_id, root)
    assert metadata["startTimeS"] == 0
    assert metadata["channels"][0]["unit"] == "V"
    assert metadata["channels"][1]["bad"]
    assert metadata["annotations"][0]["startTimeS"] == pytest.approx(1)
    assert metadata["annotations"][1]["kind"] == "bad-segment"
    client = TestClient(app)
    params = {"source_revision": metadata["revision"], "start_s": 2.125,
              "duration_s": 0.5, "channels": ["ch-1", "ch-0"], "pixel_width": 100,
              "representation": "points"}
    response = client.get(f"/real-data/projects/{project_id}/trace-window", params=params)
    assert response.status_code == 200, response.text
    with mne.io.read_raw_fif(working, preload=False, verbose=False) as raw:
        assert not raw.preload
        expected = raw.get_data(start=425, stop=525, picks=[1, 0])
        for index, channel in enumerate(["ch-1", "ch-0"]):
            series = response.json()["channels"][channel]
            np.testing.assert_array_equal(series["values"], expected[index])
            np.testing.assert_array_equal(series["timesS"], np.arange(425, 525) / 200)
        result = trace_window(project_id, source_revision=metadata["revision"], start_s=0,
                              duration_s=20, channels=["ch-0", "ch-1"], pixel_width=37,
                              project_root=root)
        expected = raw.get_data(picks=[0, 1])
        for index, channel in enumerate(["ch-0", "ch-1"]):
            series = result["channels"][channel]
            assert len(series["minimum"]) == 37
            for bucket in range(37):
                values = expected[index, bucket * 4000 // 37:(bucket + 1) * 4000 // 37]
                assert series["minimum"][bucket] == values.min()
                assert series["maximum"][bucket] == values.max()
    assert hashes == [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]


def test_invalid_requests_and_revision_change_are_explicit(recording):
    _, root, project_id = recording
    metadata = trace_metadata(project_id, root)
    params = {"source_revision": metadata["revision"], "start_s": 0,
              "duration_s": 2, "channels": ["ch-0"], "pixel_width": 100}
    client = TestClient(app)
    endpoint = f"/real-data/projects/{project_id}/trace-window"
    for override in [{"channels": ["missing"]}, {"pixel_width": 2401}, {"start_s": -1},
                     {"duration_s": "nan"}, {"representation": "points"},
                     {"channels": ["ch-0", "ch-0"]}]:
        assert client.get(endpoint, params=params | override).status_code == 422
    working = root / project_id / "recording_raw.fif"
    stat = working.stat()
    os.utime(working, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    assert client.get(endpoint, params=params).status_code == 409
    assert trace_metadata(project_id, root)["revision"] != metadata["revision"]
    with pytest.raises(ValueError, match="Invalid imported"):
        trace_metadata("../escape", root)


def test_viewport_reads_are_chunked_and_never_preload(recording, monkeypatch):
    _, root, project_id = recording
    metadata = trace_metadata(project_id, root)
    original = mne.io.BaseRaw.get_data
    reads = []

    def observed(raw, *args, **kwargs):
        assert not raw.preload
        reads.append((kwargs["start"], kwargs["stop"], kwargs["picks"]))
        return original(raw, *args, **kwargs)

    monkeypatch.setattr(mne.io.BaseRaw, "get_data", observed)
    monkeypatch.setattr("neurobridge.real_data.trace.READ_VALUES", 128)
    trace_window(project_id, source_revision=metadata["revision"], start_s=5, duration_s=3,
                 channels=["ch-1"], pixel_width=20, project_root=root)
    assert len(reads) > 1
    assert all(1000 <= start < stop <= 1600 and stop - start <= 128 and picks == [1]
               for start, stop, picks in reads)
