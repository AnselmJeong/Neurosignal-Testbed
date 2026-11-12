"""Parametrized head geometry for the JR benchmark observation models.

Electrodes reuse the QEEG lab's 32-channel list (19 standard 10–20 + 13 extra) and MNE's
``standard_1020`` montage. Sources are deterministic intracranial points with fixed radial
orientations in the MNE head frame (x right, y anterior, z superior; metres). The head is a
concentric four-layer sphere (``mne.make_sphere_model``); this is a template, not an
individual anatomical model.

The fixed-orientation leadfield ``L`` has shape (n_sensors, n_sources) in V per A·m and keeps the
forward solution's own (infinity) reference. Results are cached per geometry.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from functools import lru_cache

import mne
import numpy as np
from numpy.typing import NDArray

from neurobridge.qeeg_lab import CHANNELS, EXTRA

ELECTRODES_32: tuple[str, ...] = tuple(CHANNELS + EXTRA)
MONTAGE = "standard_1020"
HEAD_RADIUS_M = 0.09
# MNE default sphere: (brain, CSF, skull, scalp) conductivities in S/m, same as the QEEG lab.
SPHERE_SIGMAS: tuple[float, float, float, float] = (0.33, 1.0, 0.004, 0.33)
# Brain compartment radius of MNE's default sphere is 0.90 × head radius (0.081 m here).
SOURCE_SHELL_M: tuple[float, float] = (0.050, 0.065)
LEADFIELD_UNITS = "V/(A·m)"
COORDINATE_FRAME = "head"


@dataclass(frozen=True)
class HeadGeometry:
    """Sensors, sources and the fixed-orientation leadfield of one parametrization."""

    channel_names: tuple[str, ...]
    sensor_positions: NDArray[np.float64]  # (n_sensors, 3) m, head frame
    source_positions: NDArray[np.float64]  # (n_sources, 3) m, head frame
    source_orientations: NDArray[np.float64]  # (n_sources, 3) unit vectors
    leadfield: NDArray[np.float64]  # (n_sensors, n_sources) V/(A·m)
    head_radius_m: float
    sigmas: tuple[float, float, float, float]
    montage: str = MONTAGE
    coordinate_frame: str = COORDINATE_FRAME
    leadfield_units: str = LEADFIELD_UNITS

    @property
    def n_sensors(self) -> int:
        return len(self.channel_names)

    @property
    def n_sources(self) -> int:
        return int(self.source_positions.shape[0])


def electrode_names(n_sensors: int = 32) -> tuple[str, ...]:
    """First ``n_sensors`` names of the shared 32-electrode list (19 → classic 10–20)."""
    if not 1 <= n_sensors <= len(ELECTRODES_32):
        raise ValueError(f"n_sensors must be in 1..{len(ELECTRODES_32)} for the 10–20 montage")
    return ELECTRODES_32[:n_sensors]


def source_layout(n_sources: int) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Deterministic intracranial positions (m) and radial unit orientations.

    Points follow a Fibonacci spiral over the upper head (polar angle 15°–105°) with radius
    alternating between the two ``SOURCE_SHELL_M`` shells, so any count is reproducible.
    """
    if n_sources < 1:
        raise ValueError("n_sources must be >= 1")
    k = np.arange(n_sources, dtype=np.float64)
    golden = np.pi * (3.0 - np.sqrt(5.0))
    cos_lo, cos_hi = np.cos(np.deg2rad(15.0)), np.cos(np.deg2rad(105.0))
    cos_polar = cos_lo + (cos_hi - cos_lo) * (k + 0.5) / n_sources
    sin_polar = np.sqrt(1.0 - cos_polar**2)
    azimuth = golden * k
    unit = np.column_stack((sin_polar * np.cos(azimuth), sin_polar * np.sin(azimuth), cos_polar))
    radius = np.where(k % 2 == 0, SOURCE_SHELL_M[1], SOURCE_SHELL_M[0])
    return unit * radius[:, None], unit.copy()


def _readonly(array: NDArray[np.float64]) -> NDArray[np.float64]:
    array = np.ascontiguousarray(array, dtype=np.float64)
    array.setflags(write=False)
    return array


@lru_cache(maxsize=8)
def head_geometry(n_sensors: int = 32, n_sources: int = 32) -> HeadGeometry:
    """Build (and cache) the sphere-model geometry and fixed-orientation leadfield."""
    names = electrode_names(n_sensors)
    rr, nn = source_layout(n_sources)
    info = mne.create_info(list(names), 256.0, "eeg")
    info.set_montage(MONTAGE)
    with warnings.catch_warnings():
        # Template geometry needs no FreeSurfer subject; silence the SUBJECTS_DIR notice.
        warnings.filterwarnings("ignore", message=".*SUBJECTS_DIR.*")
        src = mne.setup_volume_source_space(
            pos={"rr": rr, "nn": nn},
            sphere=(0.0, 0.0, 0.0, HEAD_RADIUS_M),
            mindist=0.0,
            verbose=False,
        )
    if int(src[0]["nuse"]) != n_sources:
        raise RuntimeError("MNE dropped sources from the volume source space")
    sphere = mne.make_sphere_model(
        r0=(0.0, 0.0, 0.0), head_radius=HEAD_RADIUS_M, sigmas=SPHERE_SIGMAS, verbose=False
    )
    forward = mne.make_forward_solution(
        info, trans=None, src=src, bem=sphere, meg=False, eeg=True, verbose=False
    )
    gain = np.asarray(forward["sol"]["data"], dtype=np.float64)
    if gain.shape != (n_sensors, 3 * n_sources):
        raise RuntimeError(f"unexpected free-orientation gain shape {gain.shape}")
    # Free-orientation xyz triplets projected onto each source's fixed radial orientation.
    leadfield = np.einsum("csk,sk->cs", gain.reshape(n_sensors, n_sources, 3), nn)
    sensors = np.array([ch["loc"][:3] for ch in info["chs"]], dtype=np.float64)
    return HeadGeometry(
        channel_names=names,
        sensor_positions=_readonly(sensors),
        source_positions=_readonly(rr),
        source_orientations=_readonly(nn),
        leadfield=_readonly(leadfield),
        head_radius_m=HEAD_RADIUS_M,
        sigmas=SPHERE_SIGMAS,
    )
