"""Read-only, bounded viewport access to imported FIF working copies."""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path

import mne
import numpy as np
from mne._fiff.constants import FIFF

from .service import WORKING_COPY_NAME, default_project_root

MAX_CHANNELS = 128
MAX_PIXELS = 2400
READ_VALUES = 262_144
MAX_SCAN_VALUES = 64_000_000


class StaleTraceRevision(ValueError):
    """The working copy changed since metadata inspection."""


def _working_copy(project_id: str, project_root: Path | None) -> Path:
    if not re.fullmatch(r"real_[a-f0-9]{12}", project_id):
        raise ValueError("Invalid imported project ID")
    root = (project_root or default_project_root()).resolve()
    project = root / project_id
    path = project / WORKING_COPY_NAME
    if project.is_symlink() or path.is_symlink() or not path.is_file():
        raise ValueError("Imported FIF working copy was not found")
    manifest_path = project / "project.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("Inspect or recover this imported project before viewing traces")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("project_id") != project_id or not manifest.get("source_sha256"):
        raise ValueError("Imported project provenance is unavailable")
    return path


def _revision(raw: mne.io.BaseRaw, path: Path) -> str:
    # Include all split FIF files; metadata/annotations live inside the FIF.
    signature = []
    for filename in raw.filenames:
        part = Path(filename)
        if part.is_symlink() or part.resolve().parent != path.parent.resolve():
            raise ValueError("Working-copy FIF parts must remain inside the imported project")
        stat = part.stat()
        signature.append((part.name, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
    return hashlib.sha256(json.dumps(signature).encode()).hexdigest()


def _annotations(raw: mne.io.BaseRaw) -> list[dict]:
    return [
        {
            "id": f"annotation-{index}",
            "label": str(label),
            "startTimeS": float(onset - raw.first_time),
            "durationS": float(duration),
            "kind": "bad-segment" if label.lower().startswith("bad") else (
                "event" if duration == 0 else "annotation"
            ),
        }
        for index, (onset, duration, label) in enumerate(zip(
            raw.annotations.onset, raw.annotations.duration, raw.annotations.description,
            strict=True,
        ))
    ]


def trace_metadata(project_id: str, project_root: Path | None = None) -> dict:
    path = _working_copy(project_id, project_root)
    with mne.io.read_raw_fif(path, preload=False, verbose=False) as raw:
        units = {FIFF.FIFF_UNIT_V: "V", FIFF.FIFF_UNIT_T: "T",
                 FIFF.FIFF_UNIT_T_M: "T/m", FIFF.FIFF_UNIT_NONE: "1"}
        types = {"eeg", "eog", "ecg", "emg", "stim", "misc"}
        channels = []
        for index, (name, kind, info) in enumerate(zip(
            raw.ch_names, raw.get_channel_types(), raw.info["chs"], strict=True,
        )):
            channels.append({
                "id": f"ch-{index}", "label": name,
                "type": kind if kind in types else "unknown",
                "unit": units.get(info["unit"], f"FIFF unit {info['unit']}"),
                "bad": name in raw.info["bads"],
            })
        return {
            "sourceId": project_id, "revision": _revision(raw, path),
            "title": "Imported FIF working copy", "startTimeS": 0,
            "durationS": raw.n_times / raw.info["sfreq"],
            "samplingRateHz": raw.info["sfreq"], "channels": channels,
            "annotations": _annotations(raw),
            "capabilities": {"canMarkBadChannels": False, "canEditAnnotations": False},
        }


def _json_values(values: np.ndarray) -> list:
    # JSON null is an unavailable sample; the browser restores NaN explicitly.
    return [float(value) if np.isfinite(value) else None for value in values]


def trace_window(
    project_id: str, *, source_revision: str, start_s: float, duration_s: float,
    channels: list[str], pixel_width: int, representation: str = "auto",
    project_root: Path | None = None,
) -> dict:
    if not math.isfinite(start_s) or not math.isfinite(duration_s) or duration_s <= 0:
        raise ValueError("Window times must be finite and duration positive")
    if not 1 <= pixel_width <= MAX_PIXELS or not 1 <= len(channels) <= MAX_CHANNELS:
        raise ValueError("Request exceeds the channel or pixel budget")
    if len(set(channels)) != len(channels) or representation not in {"auto", "points", "min-max"}:
        raise ValueError("Invalid channels or representation")
    path = _working_copy(project_id, project_root)
    with mne.io.read_raw_fif(path, preload=False, verbose=False) as raw:
        revision = _revision(raw, path)
        if source_revision != revision:
            raise StaleTraceRevision("Working copy changed; refresh trace metadata")
        available = {f"ch-{index}": index for index in range(len(raw.ch_names))}
        if any(channel not in available for channel in channels):
            raise ValueError("Unknown trace channel ID")
        picks = [available[channel] for channel in channels]
        rate = float(raw.info["sfreq"])
        end_s = min(raw.n_times / rate, start_s + duration_s)
        if start_s < 0 or start_s >= end_s:
            raise ValueError("Requested window is outside the recording")
        start = min(raw.n_times, math.ceil(start_s * rate - 1e-9))
        stop = min(raw.n_times, math.ceil(end_s * rate - 1e-9))
        count = stop - start
        if count * len(picks) > MAX_SCAN_VALUES:
            raise ValueError("Window scan budget exceeded; zoom in or select fewer channels")
        envelope = representation == "min-max" or (
            representation == "auto" and count > 2 * pixel_width
        )
        if not envelope and count > 2 * pixel_width:
            raise ValueError("Point request exceeds pixel budget; request auto or min-max")
        output = {}
        if not envelope:
            values = raw.get_data(start=start, stop=stop, picks=picks)
            times = (np.arange(start, stop) / rate).tolist()
            for channel, row in zip(channels, values, strict=True):
                output[channel] = {
                    "representation": "points", "timesS": times, "values": _json_values(row),
                }
        else:
            buckets = min(pixel_width, count)
            edges = np.floor(np.arange(buckets + 1) * count / max(1, buckets)).astype(int)
            minimum = np.full((len(picks), buckets), np.inf)
            maximum = np.full((len(picks), buckets), -np.inf)
            chunk_size = max(1, READ_VALUES // len(picks))
            for offset in range(start, stop, chunk_size):
                chunk_stop = min(stop, offset + chunk_size)
                values = raw.get_data(start=offset, stop=chunk_stop, picks=picks)
                bucket_ids = np.searchsorted(edges[1:], np.arange(offset, chunk_stop) - start,
                                             side="right")
                for index, row in enumerate(values):
                    finite = np.isfinite(row)
                    np.minimum.at(minimum[index], bucket_ids[finite], row[finite])
                    np.maximum.at(maximum[index], bucket_ids[finite], row[finite])
            times = ((start + edges[:-1]) / rate).tolist()
            for index, channel in enumerate(channels):
                output[channel] = {
                    "representation": "min-max", "bucketStartTimesS": times,
                    "minimum": _json_values(minimum[index]),
                    "maximum": _json_values(maximum[index]),
                }
        if _revision(raw, path) != revision:
            raise StaleTraceRevision("Working copy changed during the trace request")
        return {
            "sourceId": project_id, "sourceRevision": revision,
            "startTimeS": start_s, "endTimeS": end_s, "channels": output,
            "annotations": [annotation for annotation in _annotations(raw)
                            if annotation["startTimeS"] < end_s
                            and annotation["startTimeS"] + annotation["durationS"] >= start_s],
        }
