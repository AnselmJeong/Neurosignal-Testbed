"""Oracle checks V01-V05 (plan §7.1) for the TVB Jansen-Rit generator.

The non-slow subset uses short runs (a few seconds of simulated time); V03 is slow.
Tolerances are stated next to each assertion. Parameters are never tuned to force a value:
V01 only reports the PSD peak.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

import numpy as np
import pytest
from scipy import signal

pytest.importorskip("tvb.simulator")

from neurobridge.benchmarks.contracts import (  # noqa: E402
    BenchmarkSpec,
    InputNoiseSpec,
    JRSimulationSpec,
    ObservationSpec,
)
from neurobridge.simulation.tvb_jr import (  # noqa: E402
    JRSimulationResult,
    chain_graph,
    default_alpha_preset,
    fork_graph,
    psd_peak_hz,
    simulate_jr,
    unidirectional_pair,
    with_coupling,
)

RECIPES = Path(__file__).parents[2] / "fixtures" / "recipes"
BURN_IN_S = 2.0
SHORT_S = 16.0


@cache
def _single_node(seed: int = 0) -> JRSimulationResult:
    spec = default_alpha_preset(1, G=0.0, seed=seed, duration_s=SHORT_S, burn_in_s=BURN_IN_S)
    return simulate_jr(spec)


@cache
def _pair(G: float, seed: int = 0) -> JRSimulationResult:
    spec = unidirectional_pair(G=G, seed=seed, duration_s=6.0, burn_in_s=BURN_IN_S)
    return simulate_jr(spec)


def test_v01_single_node_baseline_is_finite_and_reports_psd_peak(record_property) -> None:
    result = _single_node()
    assert result.v.shape == (1, int(SHORT_S * 256))
    assert result.v.dtype == np.float64
    assert result.fs == 256.0
    assert np.all(np.isfinite(result.v))
    assert result.v.std() > 0  # not collapsed to a fixed point under noisy input
    meta = result.metadata
    assert meta["variable"] == "y1 - y2" and meta["units"] == "mV"
    assert meta["steps_per_monitor"] == 8 and meta["monitor_hz"] == 1024
    assert meta["resampling"]["method"] == "scipy.signal.resample_poly"
    assert meta["validated"] is False
    peak = float(psd_peak_hz(result.v, result.fs)[0])
    record_property("v01_psd_peak_hz", peak)
    print(f"V01 single-node PSD peak: {peak:.2f} Hz")
    assert 1.0 <= peak <= 45.0  # reported, not tuned; only checks the search band


def test_v02_deterministic_dt_halving_converges() -> None:
    base = default_alpha_preset(
        1, G=0.0, duration_s=8.0, burn_in_s=BURN_IN_S, input_noise=InputNoiseSpec(std=0.0)
    )
    runs = []
    for dt in (base.dt_ms, base.dt_ms / 2):
        res = simulate_jr(base.model_copy(update={"dt_ms": dt}))
        assert res.metadata["integrator"] == "HeunDeterministic"
        runs.append(res.v[0])
    a, b = runs
    freqs, pa = signal.welch(a, fs=256, nperseg=2048)
    _, pb = signal.welch(b, fs=256, nperseg=2048)
    band = (freqs >= 1) & (freqs <= 45)
    # Tolerances: same peak bin (0.125 Hz); band PSD relative L1 difference < 2 %;
    # total power within 1 %; trajectory max deviation < 5 % of its peak-to-peak range.
    assert freqs[band][np.argmax(pa[band])] == freqs[band][np.argmax(pb[band])]
    assert np.abs(pa[band] - pb[band]).sum() / pa[band].sum() < 0.02
    assert abs(a.var() - b.var()) / a.var() < 0.01
    assert np.abs(a - b).max() < 0.05 * np.ptp(a)


def test_v04_direction_edge_0_to_1_changes_only_node_1() -> None:
    off, on = _pair(0.0), _pair(10.0)
    # Same seed → same per-node input realization; coupling only through C[1, 0].
    assert off.metadata["seeds"] == on.metadata["seeds"]
    np.testing.assert_allclose(on.v[0], off.v[0], rtol=0, atol=1e-12)
    diff = on.v[1] - off.v[1]
    rel = np.sqrt(np.mean(diff**2)) / off.v[1].std()
    assert rel > 0.1, f"coupling on/off should change node 1 (relative RMS change {rel:.3g})"


def test_v04_tvb_orientation_matches_target_source_contract() -> None:
    spec = unidirectional_pair(G=10.0)
    meta_C = np.asarray(spec.C)
    assert meta_C[1, 0] == 1.0 and meta_C[0, 1] == 0.0
    chain = np.asarray(chain_graph(3).C)
    assert chain[1, 0] == chain[2, 1] == 1.0 and chain[2, 0] == 0.0
    fork = np.asarray(fork_graph().C)
    assert fork[1, 0] == fork[2, 0] == 1.0 and fork[2, 1] == fork[1, 2] == 0.0


def test_v05_same_seed_rerun_is_reproducible_and_seeds_differ() -> None:
    first = _pair(10.0)
    again = simulate_jr(unidirectional_pair(G=10.0, seed=0, duration_s=6.0, burn_in_s=BURN_IN_S))
    # Same locked environment: equal to numerical tolerance.
    np.testing.assert_allclose(again.v, first.v, rtol=1e-12, atol=1e-12)
    other = _pair(10.0, seed=1)
    assert not np.allclose(other.v, first.v)
    node_seeds = first.metadata["seeds"]["input"]
    assert len(set(node_seeds)) == len(node_seeds)


def test_v05_node_noise_is_independent_and_per_node_seeded() -> None:
    spec = default_alpha_preset(4, G=0.0, seed=0, duration_s=SHORT_S, burn_in_s=BURN_IN_S)
    result = simulate_jr(spec)
    # Node 0's input stream does not depend on network size: matches the 1-node run.
    np.testing.assert_allclose(result.v[0], _single_node().v[0], rtol=1e-12, atol=1e-12)
    corr = np.corrcoef(result.v)
    off_diag = np.abs(corr[~np.eye(4, dtype=bool)])
    # Independent narrow-band processes over 16 s: sample |r| stays small (tolerance 0.35/0.2).
    assert off_diag.max() < 0.35, corr
    assert off_diag.mean() < 0.2, corr


def test_resampling_is_anti_aliased_and_burn_in_discarded() -> None:
    result = _single_node()
    meta = result.metadata
    assert meta["burn_in_s"] == BURN_IN_S and meta["duration_s"] == SHORT_S
    assert meta["resampling"]["down"] == 4
    freqs, pxx = signal.welch(result.v[0], fs=result.fs, nperseg=1024)
    # Polyphase FIR suppresses content near the new Nyquist (no raw every-4th picking).
    assert pxx[freqs > 120].mean() < 1e-3 * pxx[(freqs > 1) & (freqs < 45)].max()


def test_invalid_node_params_rejected() -> None:
    with pytest.raises(ValueError, match="input_noise.mean"):
        simulate_jr(default_alpha_preset(1, G=0.0, node_params={"mu": 0.1}, duration_s=1.0))
    with pytest.raises(ValueError, match="unknown JansenRit"):
        simulate_jr(default_alpha_preset(1, G=0.0, node_params={"bogus": 1.0}, duration_s=1.0))


def test_with_coupling_keeps_everything_but_G() -> None:
    spec = default_alpha_preset(8, G=10.0, seed=7)
    off = with_coupling(spec, 0.0)
    assert off.G == 0.0
    assert off.model_dump(exclude={"G"}) == spec.model_dump(exclude={"G"})


@pytest.mark.parametrize(
    ("name", "n_nodes", "duration", "n_seeds", "profile"),
    [
        ("jr-core-preview.json", 8, 40.0, 3, "preview"),
        ("jr-core-comparison.json", 32, 120.0, 30, "core-comparison"),
    ],
)
def test_recipe_fixtures_match_contracts(name, n_nodes, duration, n_seeds, profile) -> None:
    recipe = json.loads((RECIPES / name).read_text())
    assert recipe["status"] == "unvalidated_starting_values"
    bench = BenchmarkSpec.model_validate(recipe["benchmark"])
    sim = JRSimulationSpec.model_validate(recipe["simulation"])
    observations = {k: ObservationSpec.model_validate(v) for k, v in recipe["observations"].items()}
    assert bench.profile == profile and len(bench.seeds) == n_seeds
    assert {m.id for m in bench.metrics} == {"M14", "M17", "M23"}
    assert sim.n_nodes == n_nodes and sim.duration_s == duration and sim.burn_in_s == 10.0
    assert sim.output_fs == 256 and sim.monitor_hz == 1024
    assert set(observations) == {"identity_probe", "eeg_forward"}
    assert set(recipe["calibration_seeds"]).isdisjoint(bench.seeds)
    expected = default_alpha_preset(n_nodes, G=10.0, seed=bench.seeds[0], duration_s=duration)
    assert sim.C == expected.C and sim.D == expected.D


@pytest.mark.slow
def test_v03_stochastic_dt_halving_converges_in_distribution() -> None:
    """dt vs dt/2 with independent noise realizations: seed-averaged peak and alpha power agree."""
    seeds = range(5)
    stats = {}
    for factor in (1, 2):
        peaks, alpha = [], []
        for seed in seeds:
            spec = default_alpha_preset(1, G=0.0, seed=seed, duration_s=60.0, burn_in_s=10.0)
            res = simulate_jr(spec.model_copy(update={"dt_ms": spec.dt_ms / factor}))
            freqs, pxx = signal.welch(res.v[0], fs=res.fs, nperseg=2048)
            band = (freqs >= 1) & (freqs <= 45)
            peaks.append(freqs[band][np.argmax(pxx[band])])
            alpha.append(pxx[(freqs >= 4) & (freqs <= 13)].sum())
        stats[factor] = (np.mean(peaks), np.mean(alpha))
    (p1, a1), (p2, a2) = stats[1], stats[2]
    assert abs(p1 - p2) <= 0.5  # Hz
    assert abs(a1 - a2) / a1 < 0.15  # seed-averaged 4-13 Hz power within 15 %
