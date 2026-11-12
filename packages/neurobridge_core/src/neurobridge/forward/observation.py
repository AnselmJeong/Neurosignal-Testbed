"""Observation operators for the JR benchmark (plan §2.1–§2.2).

Contract (units in brackets)::

    v(t)                                      [mV]   JR pyramidal PSP, (n_sources, n_times)
    q(t) = gain × (v(t) − baseline)           [A·m]  equivalent current dipole moment
    unreferenced(t) = T × q(t) + noise(t)     [V]    T = transfer matrix of the observation kind
    recording(t) = R × unreferenced(t)        [V]

Kinds:

* ``source_native`` – returns ``v`` itself (a copy, mV). Source space, not EEG sensors; no
  transfer, reference or sensor noise is applied.
* ``identity_probe`` – ``T = PROBE_GAIN_V_PER_AM × I``; one virtual probe per source, no scalp
  positions. Requires ``n_sensors == n_sources``.
* ``schematic_mixed`` – ``T = PROBE_GAIN_V_PER_AM × M`` with the explicit, documented
  ``ObservationSpec.mixing`` matrix ``M`` [sensor][source] (dimensionless).
* ``eeg_forward`` – ``T = L``, the 10–20 sphere-model leadfield from
  :func:`neurobridge.forward.geometry.head_geometry` in V/(A·m).

Reference ``none`` keeps the reference implied by the transfer (the forward model's infinity
reference, or the probes' own reference); it is labelled as such, never as "no reference".
``average`` applies ``R = I − 11ᵀ/n``.

Sensor noise is white Gaussian with the absolute std ``ObservationSpec.sensor_noise_std`` [V],
drawn from the SeedTree ``sensor_noise`` stream. It is never rescaled to the signal RMS and no
z-scoring is applied. The transfer ``T``, reference ``R`` and noise covariance are returned as
separate artifacts.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from numpy.typing import ArrayLike, NDArray

from neurobridge.benchmarks.contracts import ObservationSpec, SeedTree
from neurobridge.forward.geometry import head_geometry

# Fixed virtual probe gain for identity_probe / schematic_mixed. Chosen once, of the same order as
# the mean |L| of the 32×32 template leadfield (~25 V/(A·m)); never tuned per condition.
PROBE_GAIN_V_PER_AM = 25.0

REFERENCE_LABELS = {
    "source_native": "not applicable (source space)",
    "identity_probe": "probe-native reference (reference='none')",
    "schematic_mixed": "probe-native reference (reference='none')",
    "eeg_forward": "forward-model reference (infinity, sphere model; reference='none')",
}
AVERAGE_REFERENCE_LABEL = "common average reference"


@dataclass(frozen=True)
class ObservationResult:
    """Observed data plus the operators that produced it, kept as separate artifacts."""

    kind: str
    analysis_space: Literal["source", "sensor"]
    data: NDArray[np.float64]  # (n_channels, n_times)
    units: str
    channel_names: tuple[str, ...]
    reference: str
    reference_label: str
    transfer: NDArray[np.float64] | None  # T (n_sensors, n_sources); L for eeg_forward
    transfer_units: str | None
    reference_matrix: NDArray[np.float64] | None  # R (n_sensors, n_sensors)
    noise_cov: NDArray[np.float64] | None  # covariance of the unreferenced sensor noise
    noise_cov_units: str | None
    noise: NDArray[np.float64] | None  # unreferenced noise realization (V)
    gain: float
    gain_units: str
    baseline: float
    baseline_units: str
    sensor_noise_std: float
    sensor_noise_seed: int | None
    sensor_positions: NDArray[np.float64] | None = None  # head frame, m; eeg_forward only
    source_positions: NDArray[np.float64] | None = None
    source_orientations: NDArray[np.float64] | None = None
    metadata: dict[str, object] = field(default_factory=dict)

    @property
    def leadfield(self) -> NDArray[np.float64] | None:
        """Physical leadfield L; only defined for ``eeg_forward``."""
        return self.transfer if self.kind == "eeg_forward" else None

    def artifacts(self) -> dict[str, NDArray[np.float64]]:
        """Arrays to persist as separate artifacts (observed data, T/L, R, noise covariance)."""
        out: dict[str, NDArray[np.float64]] = {"observed": self.data}
        for name, value in (
            ("leadfield" if self.kind == "eeg_forward" else "transfer", self.transfer),
            ("reference_matrix", self.reference_matrix),
            ("noise_cov", self.noise_cov),
        ):
            if value is not None:
                out[name] = value
        return out


def checksum(array: ArrayLike) -> str:
    """sha256 over dtype, shape and C-ordered bytes."""
    arr = np.ascontiguousarray(array)
    digest = hashlib.sha256(f"{arr.dtype.str}{arr.shape}".encode())
    digest.update(arr.tobytes())
    return digest.hexdigest()


def reference_matrix(reference: str, n_sensors: int) -> NDArray[np.float64]:
    if reference == "none":
        return np.eye(n_sensors)
    if reference == "average":
        return np.eye(n_sensors) - np.full((n_sensors, n_sensors), 1.0 / n_sensors)
    raise ValueError(f"unknown reference {reference!r}")


def _transfer(
    spec: ObservationSpec, n_sources: int
) -> tuple[NDArray[np.float64], tuple[str, ...], dict[str, object]]:
    extra: dict[str, object] = {}
    if spec.kind == "identity_probe":
        if spec.n_sensors != n_sources:
            raise ValueError("identity_probe needs n_sensors == n_sources (one probe per source)")
        names = tuple(f"probe{i:02d}" for i in range(n_sources))
        return PROBE_GAIN_V_PER_AM * np.eye(n_sources), names, extra
    if spec.kind == "schematic_mixed":
        mixing = np.asarray(spec.mixing, dtype=np.float64)
        if mixing.shape != (spec.n_sensors, n_sources):
            raise ValueError(
                f"mixing shape {mixing.shape} != (n_sensors, n_sources) "
                f"({spec.n_sensors}, {n_sources})"
            )
        names = tuple(f"mix{i:02d}" for i in range(spec.n_sensors))
        extra["mixing"] = mixing
        return PROBE_GAIN_V_PER_AM * mixing, names, extra
    if spec.kind == "eeg_forward":
        geom = head_geometry(spec.n_sensors, n_sources)
        extra.update(
            sensor_positions=geom.sensor_positions,
            source_positions=geom.source_positions,
            source_orientations=geom.source_orientations,
            montage=geom.montage,
            coordinate_frame=geom.coordinate_frame,
            head_radius_m=geom.head_radius_m,
            sigmas=geom.sigmas,
        )
        return np.array(geom.leadfield), geom.channel_names, extra
    raise ValueError(f"unknown observation kind {spec.kind!r}")


def schematic_mixing(n_sensors: int, n_sources: int, *, spread: float = 0.5) -> list[list[float]]:
    """Documented schematic mixing: unit diagonal plus ``spread**|i-j|`` off-diagonal decay.

    Row ``i`` (sensor) weights source ``j`` by ``spread ** |i·(n_sources-1)/(n_sensors-1) − j|``,
    so equal counts give a symmetric banded Toeplitz matrix. Intended as a mathematical mixing
    contrast, not a physical head model.
    """
    if not 0.0 <= spread < 1.0:
        raise ValueError("spread must be in [0, 1)")
    centre = np.linspace(0.0, n_sources - 1, n_sensors) if n_sensors > 1 else np.zeros(1)
    distance = np.abs(centre[:, None] - np.arange(n_sources)[None, :])
    return (spread**distance).tolist()


def observe(
    v_mV: ArrayLike,
    spec: ObservationSpec,
    seeds: SeedTree,
    *,
    seed_path: tuple[str | int, ...] = (),
) -> ObservationResult:
    """Apply one observation model to source activity ``v_mV`` (n_sources, n_times) in mV.

    The input is never modified. Sensor noise uses ``seeds.generator('sensor_noise', *seed_path)``.
    """
    v = np.array(v_mV, dtype=np.float64, copy=True)
    if v.ndim != 2 or v.shape[1] == 0:
        raise ValueError("v_mV must be a 2-D (n_sources, n_times) array")
    if not np.all(np.isfinite(v)):
        raise ValueError("v_mV must be finite")
    n_sources, n_times = v.shape

    common: dict[str, Any] = dict(
        gain=spec.gain,
        gain_units=spec.gain_units,
        baseline=spec.baseline,
        baseline_units=spec.baseline_units,
        sensor_noise_std=spec.sensor_noise_std,
    )
    if spec.kind == "source_native":
        if spec.reference != "none" or spec.sensor_noise_std != 0.0:
            raise ValueError("source_native takes no reference and no sensor noise")
        return ObservationResult(
            kind=spec.kind,
            analysis_space="source",
            data=v,
            units="mV",
            channel_names=tuple(f"source{i:02d}" for i in range(n_sources)),
            reference="none",
            reference_label=REFERENCE_LABELS["source_native"],
            transfer=None,
            transfer_units=None,
            reference_matrix=None,
            noise_cov=None,
            noise_cov_units=None,
            noise=None,
            sensor_noise_seed=None,
            **common,
        )

    transfer, names, extra = _transfer(spec, n_sources)
    n_sensors = transfer.shape[0]
    q = spec.gain * (v - spec.baseline)  # A·m
    unreferenced = transfer @ q
    noise_seed = seeds.seed_for("sensor_noise", *seed_path)
    noise = None
    if spec.sensor_noise_std > 0:
        rng = np.random.default_rng(noise_seed)
        noise = spec.sensor_noise_std * rng.standard_normal((n_sensors, n_times))
        unreferenced = unreferenced + noise
    ref = reference_matrix(spec.reference, n_sensors)
    recording = ref @ unreferenced if spec.reference != "none" else unreferenced
    label = AVERAGE_REFERENCE_LABEL if spec.reference == "average" else REFERENCE_LABELS[spec.kind]
    meta = {k: val for k, val in extra.items() if not k.startswith(("sensor_", "source_"))}
    meta["transfer_definition"] = {
        "identity_probe": f"{PROBE_GAIN_V_PER_AM} V/(A·m) × I",
        "schematic_mixed": f"{PROBE_GAIN_V_PER_AM} V/(A·m) × mixing",
        "eeg_forward": "sphere-model fixed-orientation leadfield",
    }[spec.kind]
    return ObservationResult(
        kind=spec.kind,
        analysis_space="sensor",
        data=recording,
        units="V",
        channel_names=names,
        reference=spec.reference,
        reference_label=label,
        transfer=transfer,
        transfer_units="V/(A·m)",
        reference_matrix=ref,
        noise_cov=spec.sensor_noise_std**2 * np.eye(n_sensors),
        noise_cov_units="V^2",
        noise=noise,
        sensor_noise_seed=noise_seed,
        sensor_positions=extra.get("sensor_positions"),  # type: ignore[arg-type]
        source_positions=extra.get("source_positions"),  # type: ignore[arg-type]
        source_orientations=extra.get("source_orientations"),  # type: ignore[arg-type]
        metadata=meta,
        **common,
    )
