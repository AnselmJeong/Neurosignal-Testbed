"""Oracle tests V06 (observation-only change) and V08 (forward/reference) for P3."""

from __future__ import annotations

import warnings

import mne
import numpy as np
import pytest
from neurobridge.benchmarks.contracts import ObservationSpec, SeedTree
from neurobridge.forward import (
    ELECTRODES_32,
    PROBE_GAIN_V_PER_AM,
    checksum,
    head_geometry,
    observe,
    schematic_mixing,
)

N_SOURCES = 16
N_TIMES = 2048
GAIN = 1e-8  # A·m per mV (fixed calibration constant for the test)
BASELINE = 2.5  # mV


def _sources(n_sources: int = N_SOURCES, n_times: int = N_TIMES) -> np.ndarray:
    rng = np.random.default_rng(1234)
    return BASELINE + rng.standard_normal((n_sources, n_times))


def _spec(kind: str, **kw) -> ObservationSpec:
    n_sensors = kw.pop("n_sensors", N_SOURCES if kind in ("identity_probe",) else 32)
    if kind == "schematic_mixed" and "mixing" not in kw:
        kw["mixing"] = schematic_mixing(n_sensors, N_SOURCES)
    return ObservationSpec(kind=kind, n_sensors=n_sensors, gain=GAIN, baseline=BASELINE, **kw)


def _offdiag_abs_corr(data: np.ndarray) -> float:
    corr = np.corrcoef(data)
    return float(np.abs(corr[~np.eye(len(corr), dtype=bool)]).mean())


# ----------------------------------------------------------------------------- V06


@pytest.mark.parametrize(
    "kind", ["source_native", "identity_probe", "schematic_mixed", "eeg_forward"]
)
@pytest.mark.parametrize("reference", ["none", "average"])
def test_v06_source_input_unchanged(kind: str, reference: str) -> None:
    if kind == "source_native" and reference == "average":
        pytest.skip("source_native has no reference")
    v = _sources()
    before = checksum(v)
    noise = 0.0 if kind == "source_native" else 1e-7
    result = observe(v, _spec(kind, reference=reference, sensor_noise_std=noise), SeedTree(root=7))
    assert checksum(v) == before
    assert not np.shares_memory(result.data, v)


def test_v06_source_native_is_source_space_copy() -> None:
    v = _sources()
    result = observe(v, _spec("source_native"), SeedTree(root=0))
    assert result.analysis_space == "source"
    assert result.units == "mV"
    assert result.transfer is None and result.reference_matrix is None
    assert "EEG" not in result.reference_label and result.sensor_positions is None
    np.testing.assert_array_equal(result.data, v)
    with pytest.raises(ValueError):
        observe(v, _spec("source_native", reference="average"), SeedTree(root=0))


# ----------------------------------------------------------------------------- V08


def _independent_leadfield(geom) -> np.ndarray:
    """Recompute the fixed-orientation leadfield through MNE's dipole forward path."""
    info = mne.create_info(list(geom.channel_names), 256.0, "eeg")
    info.set_montage("standard_1020")
    n = geom.n_sources
    dip = mne.Dipole(
        np.zeros(n), geom.source_positions, np.ones(n), geom.source_orientations, np.ones(n)
    )
    sphere = mne.make_sphere_model(r0=(0.0, 0.0, 0.0), head_radius=0.09, verbose=False)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fwd, _ = mne.make_forward_dipole(dip, sphere, info, verbose=False)
    return np.asarray(fwd["sol"]["data"], dtype=np.float64)


@pytest.mark.parametrize("reference", ["none", "average"])
def test_v08_independent_lq_matches_observe(reference: str) -> None:
    v = _sources()
    result = observe(v, _spec("eeg_forward", reference=reference), SeedTree(root=3))
    geom = head_geometry(32, N_SOURCES)
    leadfield = _independent_leadfield(geom)
    lf_scale = np.abs(leadfield).max()
    np.testing.assert_allclose(result.leadfield, leadfield, rtol=0, atol=1e-6 * lf_scale)

    q = GAIN * (v - BASELINE)  # A·m, computed independently of observe()
    for transfer, tol in ((result.leadfield, 1e-12), (leadfield, 1e-6)):
        expected = np.einsum("cs,st->ct", transfer, q)
        if reference == "average":
            expected = expected - expected.mean(axis=0, keepdims=True)
        scale = np.abs(expected).max()
        np.testing.assert_allclose(result.data, expected, rtol=0, atol=tol * scale)
    assert result.noise is None
    np.testing.assert_array_equal(result.noise_cov, np.zeros((32, 32)))


def test_v08_coordinates_units_and_labels() -> None:
    geom = head_geometry(32, N_SOURCES)
    assert geom.channel_names == ELECTRODES_32 and len(set(geom.channel_names)) == 32
    info = mne.create_info(list(ELECTRODES_32), 256.0, "eeg")
    info.set_montage(mne.channels.make_standard_montage("standard_1020"))
    head_pos = info.get_montage().get_positions()
    assert head_pos["coord_frame"] == "head"
    expected = np.array([head_pos["ch_pos"][name] for name in geom.channel_names])
    np.testing.assert_allclose(geom.sensor_positions, expected, atol=1e-12)
    brain_radius = 0.9 * geom.head_radius_m
    assert np.all(np.linalg.norm(geom.source_positions, axis=1) < brain_radius)
    np.testing.assert_allclose(np.linalg.norm(geom.source_orientations, axis=1), 1.0)
    radial = geom.source_positions / np.linalg.norm(geom.source_positions, axis=1, keepdims=True)
    np.testing.assert_allclose(geom.source_orientations, radial, atol=1e-12)
    assert geom.coordinate_frame == "head" and geom.leadfield_units == "V/(A·m)"

    result = observe(_sources(), _spec("eeg_forward"), SeedTree(root=0))
    assert result.units == "V" and result.transfer_units == "V/(A·m)"
    assert result.gain_units == "A·m/mV" and result.baseline_units == "mV"
    assert result.reference == "none" and "forward" in result.reference_label
    assert "no reference" not in result.reference_label
    assert set(result.artifacts()) == {"observed", "leadfield", "reference_matrix", "noise_cov"}


@pytest.mark.parametrize("kind", ["identity_probe", "schematic_mixed", "eeg_forward"])
def test_v08_average_reference_sum_zero_and_rank(kind: str) -> None:
    result = observe(
        _sources(), _spec(kind, reference="average", sensor_noise_std=1e-7), SeedTree(root=5)
    )
    n = result.data.shape[0]
    scale = np.abs(result.data).max()
    assert np.abs(result.data.sum(axis=0)).max() < 1e-10 * scale * n
    assert np.linalg.matrix_rank(result.data) <= n - 1
    np.testing.assert_allclose(result.reference_matrix.sum(axis=1), 0.0, atol=1e-12)
    assert result.reference_label == "common average reference"


def test_v08_identity_vs_forward_correlation_structure() -> None:
    v = _sources()
    probe = observe(v, _spec("identity_probe"), SeedTree(root=1))
    forward = observe(v, _spec("eeg_forward"), SeedTree(root=1))
    np.testing.assert_allclose(probe.transfer, PROBE_GAIN_V_PER_AM * np.eye(N_SOURCES))
    assert probe.sensor_positions is None
    assert _offdiag_abs_corr(probe.data) < 0.05
    assert _offdiag_abs_corr(forward.data) > 0.3


def test_source_and_sensor_counts_are_independent() -> None:
    v = _sources(16)
    forward = observe(v, _spec("eeg_forward", n_sensors=32), SeedTree(root=2))
    assert forward.data.shape == (32, N_TIMES) and forward.leadfield.shape == (32, 16)
    v24 = _sources(24)
    forward19 = observe(v24, _spec("eeg_forward", n_sensors=19), SeedTree(root=2))
    assert forward19.data.shape == (19, N_TIMES) and forward19.leadfield.shape == (19, 24)
    with pytest.raises(ValueError):
        observe(v, _spec("identity_probe", n_sensors=32), SeedTree(root=2))


def test_sensor_noise_is_absolute_and_seeded() -> None:
    std = 2e-7
    quiet = _sources() * 0.0 + BASELINE  # q = 0 → recording is pure noise
    loud = _sources() * 50.0
    a = observe(quiet, _spec("eeg_forward", sensor_noise_std=std), SeedTree(root=9))
    b = observe(loud, _spec("eeg_forward", sensor_noise_std=std), SeedTree(root=9))
    c = observe(quiet, _spec("eeg_forward", sensor_noise_std=std), SeedTree(root=10))
    np.testing.assert_array_equal(a.noise, b.noise)  # never rescaled to signal RMS
    assert not np.array_equal(a.noise, c.noise)
    assert a.noise.std() == pytest.approx(std, rel=0.02)
    np.testing.assert_allclose(a.noise_cov, std**2 * np.eye(32))
    np.testing.assert_allclose(a.data, a.noise)
    assert a.sensor_noise_seed == SeedTree(root=9).seed_for("sensor_noise")
