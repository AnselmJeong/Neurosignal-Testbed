"""Oracle tests for connectivity adapters M11-M20 (plan V12, V13, V20)."""

from __future__ import annotations

import numpy as np
import pytest
from mne_connectivity import envelope_correlation, spectral_connectivity_epochs
from neurobridge.benchmarks.contracts import MetricStatus
from neurobridge.metrics import connectivity, registry

FS = 256.0
N_EPOCHS = 60
N_TIMES = 512
ALPHA = {"alpha": (8.0, 13.0)}
CONNECTIVITY_IDS = ("M11", "M12", "M13", "M14", "M15", "M16", "M17", "M18", "M19", "M20")


def _values(result) -> np.ndarray:
    assert result.status is MetricStatus.OK, (result.reason_code, result.message)
    return np.asarray(result.values, dtype=float)


def _pair(rng: np.random.Generator, lag: int, noise: float = 0.05) -> np.ndarray:
    """Broadband x and y = x delayed by ``lag`` samples plus small independent noise."""
    pad = 32
    x = rng.standard_normal((N_EPOCHS, N_TIMES + 2 * pad))
    y = np.roll(x, lag, axis=1)
    x, y = x[:, pad:-pad], y[:, pad:-pad]
    return np.stack([x, y + noise * rng.standard_normal(x.shape)], axis=1)


def _run(metric_id: str, data: np.ndarray, **params) -> np.ndarray:
    return _values(registry.run(metric_id, data, {"sfreq": FS, "params": params}))


def test_all_connectivity_ids_registered_and_implemented() -> None:
    caps = registry.capabilities()
    for metric_id in CONNECTIVITY_IDS:
        assert caps[metric_id]["status"] == "implemented"
        assert "default" in caps[metric_id]["variants"]


# --------------------------------------------------------------------------- V12


def test_v12_independent_phases_give_finite_sample_null_plv() -> None:
    rng = np.random.default_rng(12)
    data = rng.standard_normal((N_EPOCHS, 2, N_TIMES))
    plv = _run("M14", data)[:, 1, 0]
    # E[PLV] under independence ~ sqrt(pi / (4 N)) ~ 0.11 for N = 60; never exactly 0.
    assert np.all(plv > 0)
    assert np.all(plv < 0.25)


def test_v12_identical_zero_lag_phase() -> None:
    data = _pair(np.random.default_rng(121), lag=0)
    plv = _run("M14", data)[:, 1, 0]
    pli = _run("M16", data)[:, 1, 0]
    wpli = _run("M17", data)[:, 1, 0]
    assert np.all(plv > 0.99)
    # Zero lag carries no consistent phase-lead sign: PLI/wPLI stay at the null level.
    assert np.all(pli < 0.3)
    assert np.all(wpli < 0.3)


def test_v12_constant_nonzero_lag_gives_wpli_near_one() -> None:
    # 6 samples at 256 Hz = 23.4 ms -> phase lag 67-110 deg over 8-13 Hz (same sign).
    data = _pair(np.random.default_rng(122), lag=6)
    wpli = _run("M17", data, bands=ALPHA)[0, 1, 0]
    pli = _run("M16", data, bands=ALPHA)[0, 1, 0]
    assert wpli > 0.95
    assert pli > 0.95


# --------------------------------------------------------------------------- V13


@pytest.mark.parametrize(("metric_id", "method"), [("M15", "ppc"), ("M18", "wpli2_debiased")])
def test_v13_debiased_estimators_keep_negative_values(metric_id: str, method: str) -> None:
    rng = np.random.default_rng(13)
    n = 8
    data = rng.standard_normal((N_EPOCHS, n, N_TIMES))
    full = _run(metric_id, data, bands=ALPHA)[0]
    rows, cols = np.tril_indices(n, k=-1)
    raw = spectral_connectivity_epochs(
        data,
        method=method,
        indices=(rows, cols),
        sfreq=FS,
        fmin=(8.0,),
        fmax=(13.0,),
        faverage=True,
        verbose=False,
    ).get_data(output="raveled")[:, 0]
    np.testing.assert_allclose(full[rows, cols], raw, rtol=0, atol=0)
    np.testing.assert_allclose(full[cols, rows], raw, rtol=0, atol=0)
    assert raw.min() < 0  # independent data yields negative unbiased estimates ...
    assert full[rows, cols].min() == raw.min()  # ... and they are not clipped or abs'd
    assert np.sum(full < 0) == 2 * np.sum(raw < 0)


def test_v13_ppc_is_not_plv() -> None:
    data = np.random.default_rng(131).standard_normal((N_EPOCHS, 3, N_TIMES))
    plv = _run("M14", data, bands=ALPHA)
    ppc = _run("M15", data, bands=ALPHA)
    off = ~np.eye(3, dtype=bool)
    assert not np.allclose(plv[0][off], ppc[0][off])
    assert np.all(plv[0][off] > 0)


# --------------------------------------------------------------------------- V20


def test_v20_imcoh_antisymmetric_and_channel_swap() -> None:
    data = _pair(np.random.default_rng(20), lag=6)
    m = _run("M13", data, bands=ALPHA)[0]
    assert np.isnan(m[0, 0]) and np.isnan(m[1, 1])
    assert m[1, 0] == -m[0, 1]
    assert abs(m[1, 0]) > 0.5  # a real lag gives a large signed value
    swapped = _run("M13", data[:, ::-1], bands=ALPHA)[0]
    np.testing.assert_allclose(swapped[1, 0], m[0, 1], rtol=1e-12, atol=1e-12)
    assert np.sign(swapped[1, 0]) == -np.sign(m[1, 0])
    # The filled triangle agrees with what MNE returns for the reversed pair order.
    for seed, target in ((1, 0), (0, 1)):
        raw = spectral_connectivity_epochs(
            data,
            method="imcoh",
            indices=(np.array([seed]), np.array([target])),
            sfreq=FS,
            fmin=(8.0,),
            fmax=(13.0,),
            faverage=True,
            verbose=False,
        ).get_data(output="raveled")[0, 0]
        np.testing.assert_allclose(m[seed, target], raw, rtol=1e-12, atol=1e-12)


def test_v20_shape_order_and_symmetric_fill_without_doubling() -> None:
    rng = np.random.default_rng(201)
    base = _pair(rng, lag=3)
    data = np.concatenate([base, rng.standard_normal((N_EPOCHS, 2, N_TIMES))], axis=1)
    names = ["a", "b", "c", "d"]
    res = registry.run("M14", data, {"sfreq": FS, "channel_names": names})
    full = _values(res)
    assert full.shape == (5, 4, 4)
    assert res.axes == ["band", "channel_row", "channel_col"]
    assert res.parameters["band_order"] == ["delta", "theta", "alpha", "beta", "gamma"]
    assert res.parameters["channel_names"] == names
    assert res.n_epochs == N_EPOCHS and res.n_samples == N_EPOCHS * N_TIMES
    assert res.backend_version
    assert np.all(np.isnan(np.diagonal(full, axis1=1, axis2=2)))
    off = ~np.eye(4, dtype=bool)
    np.testing.assert_array_equal(full, np.swapaxes(full, 1, 2))
    assert np.all(full[:, off] <= 1.0)  # mirrored, not A + A.T doubled
    perm = [2, 0, 3, 1]
    permuted = _run("M14", data[:, perm])
    np.testing.assert_allclose(permuted, full[:, perm][:, :, perm], rtol=1e-10, atol=1e-12)


def test_m11_pearson_signed_symmetric() -> None:
    rng = np.random.default_rng(11)
    x = rng.standard_normal((4, 1, 1024))
    data = np.concatenate(
        [x, -x + 0.1 * rng.standard_normal(x.shape), x + rng.standard_normal(x.shape)], 1
    )
    res = registry.run("M11", data, {"sfreq": FS})
    r = _values(res)
    flat = np.concatenate(list(data), axis=-1)
    expected = np.corrcoef(flat)
    off = ~np.eye(3, dtype=bool)
    np.testing.assert_allclose(r[off], expected[off], rtol=1e-12, atol=1e-12)
    assert r[1, 0] < -0.95  # sign preserved
    assert res.axes == ["channel_row", "channel_col"]
    assert np.all(np.isnan(np.diag(r)))


@pytest.mark.parametrize(("metric_id", "orth"), [("M19", False), ("M20", "pairwise")])
def test_aec_signed_raw_values_match_backend(metric_id: str, orth) -> None:
    rng = np.random.default_rng(19)
    n = 6
    data = rng.standard_normal((5, n, 1024))
    full = _run(metric_id, data, bands=ALPHA)[0]
    from mne.filter import filter_data

    filtered = filter_data(data, FS, 8.0, 13.0, verbose=False)
    raw = envelope_correlation(filtered, orthogonalize=orth, absolute=False, verbose=False)
    dense = raw.get_data(output="dense")[..., 0].mean(axis=0)
    off = ~np.eye(n, dtype=bool)
    np.testing.assert_allclose(full[off], dense[off], rtol=1e-12, atol=1e-12)
    assert full[off].min() < 0  # independent envelopes give some negative correlations


def test_aec_orthogonalization_removes_zero_lag_leakage() -> None:
    rng = np.random.default_rng(191)
    src = rng.standard_normal((5, 1, 2048))
    data = np.concatenate([src, src + 0.3 * rng.standard_normal(src.shape)], axis=1)
    plain = _run("M19", data, bands=ALPHA)[0, 1, 0]
    orth = _run("M20", data, bands=ALPHA)[0, 1, 0]
    assert plain > 0.8
    assert orth < plain - 0.3


def test_status_paths_never_fabricate_values() -> None:
    rng = np.random.default_rng(0)
    few = rng.standard_normal((2, 3, N_TIMES))
    res = registry.run("M17", few, {"sfreq": FS})
    assert res.status is MetricStatus.INSUFFICIENT_DATA
    assert res.reason_code == "too_few_epochs" and res.values is None
    bad_band = registry.run(
        "M14",
        rng.standard_normal((10, 3, N_TIMES)),
        {"sfreq": FS, "params": {"bands": {"x": (100, 200)}}},
    )
    assert bad_band.status is MetricStatus.INVALID_INPUT and bad_band.values is None
    no_fs = registry.run("M11", few, {})
    assert no_fs.status is MetricStatus.INVALID_INPUT and no_fs.reason_code == "missing_sfreq"
    one_channel = registry.run("M19", rng.standard_normal((3, 1, N_TIMES)), {"sfreq": FS})
    assert one_channel.status is MetricStatus.INSUFFICIENT_DATA


def test_fill_from_pairs_explicit_conversion() -> None:
    rows, cols = np.tril_indices(3, k=-1)
    vals = np.array([0.1, -0.2, 0.3])
    sym = connectivity.fill_from_pairs(3, rows, cols, vals, antisymmetric=False)
    anti = connectivity.fill_from_pairs(3, rows, cols, vals, antisymmetric=True)
    assert sym[1, 0] == sym[0, 1] == 0.1 and sym[2, 0] == sym[0, 2] == -0.2
    assert anti[2, 1] == 0.3 and anti[1, 2] == -0.3
    assert np.all(np.isnan(np.diag(sym)))
