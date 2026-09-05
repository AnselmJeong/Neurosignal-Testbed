"""Scientific checks independent of the lesson's rendering and summaries."""

import numpy as np
import pytest
from fastapi.testclient import TestClient
from neurobridge.qeeg_lab import (
    QeegLabRecipe,
    geometry,
    quantify,
    run_qeeg_lab,
    simulate,
)
from neurobridge_api.main import app
from scipy import signal


@pytest.fixture(scope="module")
def result():
    return run_qeeg_lab(QeegLabRecipe(cohort_size=20))


def test_reproducible_partition_and_independent_norms(result):
    assert result == run_qeeg_lab(QeegLabRecipe(cohort_size=20))
    relative = np.array(result["metrics"]["relative"])
    np.testing.assert_allclose(relative.sum(axis=0), 1, atol=1e-12)
    np.testing.assert_allclose(np.array(result["atlas_relative"]).sum(axis=0), 1)
    for norm in result["norms"].values():
        cohort = np.array(norm["cohort_values"])
        subject = np.array(norm["subject"])
        np.testing.assert_allclose(norm["z"], (subject - cohort.mean(0)) / cohort.std(0, ddof=1))
        assert np.all(np.std(cohort, axis=0) > 0)
    changed = run_qeeg_lab(QeegLabRecipe(cohort_size=20, alpha_amplitude=36, seed=43))
    assert (
        result["norms"]["absolute"]["cohort_values"]
        == changed["norms"]["absolute"]["cohort_values"]
    )
    assert np.mean(changed["metrics"]["absolute"][2]) > np.mean(result["metrics"]["absolute"][2])
    assert np.mean(changed["norms"]["absolute"]["z"][2]) > np.mean(
        result["norms"]["absolute"]["z"][2]
    )


def test_parseval_band_boundaries_peak_and_scaling():
    t = np.arange(4096) / 128
    data = np.array([3 * np.sin(2 * np.pi * 10 * t)])
    metrics = quantify(data)
    assert metrics["absolute"][2, 0] == pytest.approx(4.5, abs=1e-8)
    assert metrics["relative"][2, 0] == pytest.approx(1)
    assert metrics["alpha_peak_hz"][0] == 10
    scaled = quantify(data * 2)
    np.testing.assert_allclose(scaled["absolute"], metrics["absolute"] * 4)
    np.testing.assert_allclose(scaled["relative"], metrics["relative"])


def test_reference_and_geometry_are_real_operations():
    average = QeegLabRecipe()
    mastoids = average.model_copy(update={"reference": "linked_mastoids"})
    a, _ = simulate(average, np.random.default_rng(42))
    b, _ = simulate(mastoids, np.random.default_rng(42))
    np.testing.assert_allclose(a.mean(axis=0), 0, atol=1e-12)
    np.testing.assert_allclose(a[0] - a[1], b[0] - b[1], atol=1e-12)
    assert not np.allclose(quantify(a)["absolute"], quantify(b)["absolute"])
    _, g1, _, xy, _ = geometry("19", "standard")
    _, g2, *_ = geometry("19", "conductive_skull")
    assert not np.allclose(g1, g2)
    assert xy[0, 0] < 0 < xy[1, 0]  # Fp1 left / Fp2 right
    names, g32, *_ = geometry("32", "standard")
    assert len(names) == 32 and g32.shape == (34, 6)


def test_connectivity_matches_scipy_and_stays_bounded(result):
    eeg, _ = simulate(QeegLabRecipe(), np.random.default_rng(42))
    f, expected = signal.coherence(
        eeg[0], eeg[1], fs=128, window="hann", nperseg=512, noverlap=256, detrend=False
    )
    assert result["coherence"][0][1] == pytest.approx(expected[(f >= 8) & (f < 13)].mean())
    for key in ["coherence", "plv"]:
        matrix = np.array(result[key])
        np.testing.assert_allclose(matrix, matrix.T, atol=1e-12)
        np.testing.assert_allclose(matrix.diagonal(), 1, atol=1e-12)
        assert np.all((matrix >= 0) & (matrix <= 1))
    assert np.all(
        (np.array(result["metrics"]["entropy"]) >= 0)
        & (np.array(result["metrics"]["entropy"]) <= 1)
    )


def test_api_contract_and_validation():
    client = TestClient(app)
    response = client.post(
        "/qeeg/simulate", json={"cohort_size": 20, "montage": "32", "reference": "linked_mastoids"}
    )
    assert response.status_code == 200
    assert len(response.json()["metrics"]["psd"]) == 32
    assert client.post("/qeeg/simulate", json={"cohort_size": 50000}).status_code == 422
    assert client.post("/qeeg/simulate", json={"alpha_hz": 64}).status_code == 422
