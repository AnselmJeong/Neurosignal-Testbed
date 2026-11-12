"""Jansen-Rit network generator on top of TVB (plan §2.1, §2.3, §2.4).

Output contract
    ``v = y1 - y2`` (mV) per node, ``n_nodes x n_samples`` float64 at ``spec.output_fs``.

Pipeline
    TVB ``JansenRit`` + ``SigmoidalJansenRit`` coupling (global strength ``G``) +
    ``HeunStochastic`` (``HeunDeterministic`` when the input-noise std is 0) →
    ``TemporalAverage`` monitor at ``spec.monitor_hz`` (an integer number of steps) →
    anti-aliased polyphase resampling (``scipy.signal.resample_poly``) to ``spec.output_fs`` →
    burn-in discarded.

Conventions
    * ``C[target, source]`` and ``D[target, source]`` (ms). TVB uses the same orientation
      (``weights[target, source]``, verified in docs/benchmarks/p0-environment.md), so the
      adapter passes the matrices through unchanged; ``tract_lengths = D`` at speed 1 mm/ms.
    * External input ``p_i(t) = mean + std * xi_i(t)`` enters the y4 equation, so the
      additive TVB noise on y4 has intensity ``nsig = (A a std)^2 / 2``.
    * Each node draws its noise from its own generator seeded by
      ``SeedTree.seed_for("input", "node", i)``; the realization does not depend on the state,
      on ``G``/``C``/``D`` or on the number of nodes, so coupling on/off reuse the same input.
    * Initial states come from ``SeedTree.generator("initial_state", "node", i)``.

All starting values here (presets, initial-state box) are proposals, not validated physiology.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from importlib import metadata as importlib_metadata
from typing import Any

import numpy as np
from scipy import signal

from neurobridge.benchmarks.contracts import InputNoiseSpec, JRSimulationSpec, SeedTree

STATE_VARIABLES = ("y0", "y1", "y2", "y3", "y4", "y5")
NOISY_STATE_INDEX = 4  # y4 carries the external input p(t)

# Uniform box for random initial states (unvalidated; transients are removed by burn-in).
INITIAL_STATE_BOX: dict[str, tuple[float, float]] = {
    "y0": (0.0, 0.2),
    "y1": (0.0, 30.0),
    "y2": (0.0, 30.0),
    "y3": (-1.0, 1.0),
    "y4": (-1.0, 1.0),
    "y5": (-1.0, 1.0),
}

# Monitor samples simulated past the requested end so the resampling filter has no edge there.
TAIL_PAD_S = 0.25

JR_PARAM_NAMES = ("A", "B", "a", "b", "v0", "nu_max", "r", "J", "a_1", "a_2", "a_3", "a_4")


@dataclass
class JRSimulationResult:
    v: np.ndarray  # (n_nodes, n_samples) float64, mV
    fs: float
    node_ids: list[str]
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def n_samples(self) -> int:
        return int(self.v.shape[1])

    @property
    def times_s(self) -> np.ndarray:
        """Seconds after the end of the burn-in."""
        return np.arange(self.n_samples) / self.fs


def tvb_version() -> str:
    try:
        return importlib_metadata.version("tvb-library")
    except importlib_metadata.PackageNotFoundError:  # pragma: no cover - optional dependency
        return "unknown"


def _require_tvb():
    try:
        from tvb.datatypes import connectivity
        from tvb.simulator import coupling, integrators, models, monitors, noise, simulator
    except ImportError as exc:  # pragma: no cover - depends on optional group
        raise ImportError(
            "TVB is required for the Jansen-Rit generator; install the 'simulation' "
            "dependency group (tvb-library)."
        ) from exc
    return coupling, integrators, models, monitors, noise, simulator, connectivity


def _make_node_noise_class(noise_module):
    class PerNodeAdditive(noise_module.Additive):
        """Additive white noise whose y4 increments come from one generator per node."""

        def bind_generators(self, generators: list[np.random.Generator], block: int) -> None:
            self._node_generators = generators
            self._block = int(block)
            self._buffer = np.empty((0, len(generators)))
            self._cursor = 0

        def _refill(self) -> None:
            columns = [gen.standard_normal(self._block) for gen in self._node_generators]
            self._buffer = np.stack(columns, axis=1)
            self._cursor = 0

        def white(self, shape):
            nsv, n_nodes, n_modes = shape
            if self._cursor >= self._buffer.shape[0]:
                self._refill()
            draws = self._buffer[self._cursor]
            self._cursor += 1
            out = np.zeros(shape)
            out[NOISY_STATE_INDEX, :, :] = draws[:n_nodes, np.newaxis]
            return np.sqrt(self.dt) * out

    return PerNodeAdditive


def noise_intensity(model_A: float, model_a: float, noise: InputNoiseSpec) -> float:
    """TVB additive ``nsig`` on y4 that realizes input std ``noise.std`` (1/ms per sqrt(ms))."""
    return 0.5 * (model_A * model_a * noise.std) ** 2


def _initial_history(spec: JRSimulationSpec, horizon: int) -> np.ndarray:
    state = np.empty((len(STATE_VARIABLES), spec.n_nodes))
    for node in range(spec.n_nodes):
        rng = spec.seeds.generator("initial_state", "node", node)
        for k, name in enumerate(STATE_VARIABLES):
            lo, hi = INITIAL_STATE_BOX[name]
            state[k, node] = rng.uniform(lo, hi)
    # Constant history over the delay horizon: shape (horizon, nsv, n_nodes, n_modes).
    return np.broadcast_to(
        state[np.newaxis, :, :, np.newaxis], (horizon,) + state.shape + (1,)
    ).copy()


def simulate_jr(spec: JRSimulationSpec, duration_s: float | None = None) -> JRSimulationResult:
    """Integrate the JR network described by ``spec`` and return ``v = y1 - y2`` at output_fs."""
    coupling, integrators, models, monitors, noise_mod, simulator, connectivity = _require_tvb()
    duration = float(spec.duration_s if duration_s is None else duration_s)
    if not np.isfinite(duration) or duration <= 0:
        raise ValueError("duration_s must be positive")
    if "mu" in spec.node_params:
        raise ValueError("set the mean input via input_noise.mean, not node_params['mu']")
    unknown = set(spec.node_params) - set(JR_PARAM_NAMES)
    if unknown:
        raise ValueError(f"unknown JansenRit parameters: {sorted(unknown)}")

    n = spec.n_nodes
    C = np.asarray(spec.C, dtype=float)
    D = np.asarray(spec.D, dtype=float)

    model = models.JansenRit(
        mu=np.array([spec.input_noise.mean]),
        **{name: np.array([float(value)]) for name, value in spec.node_params.items()},
    )
    model.variables_of_interest = ("y1", "y2")

    conn = connectivity.Connectivity(
        weights=C.copy(),  # TVB weights[target, source] == external C[target, source]
        tract_lengths=D.copy(),
        speed=np.array([1.0]),  # mm/ms → delays (ms) equal D
        centres=np.zeros((n, 3)),
        region_labels=np.array([f"n{i:02d}" for i in range(n)]),
    )
    conn.configure()

    coupler = coupling.SigmoidalJansenRit(a=np.array([float(spec.G)]))

    dt = spec.dt_ms
    stochastic = spec.input_noise.std > 0
    nsig_y4 = 0.0
    if stochastic:
        node_noise_cls = _make_node_noise_class(noise_mod)
        nsig = np.zeros(len(STATE_VARIABLES))
        nsig_y4 = noise_intensity(float(model.A[0]), float(model.a[0]), spec.input_noise)
        nsig[NOISY_STATE_INDEX] = nsig_y4
        node_noise = node_noise_cls(nsig=nsig)
        node_noise.bind_generators(
            [spec.seeds.generator("input", "node", i) for i in range(n)],
            block=max(1, spec.steps_per_monitor * spec.monitor_hz),  # ~1 s of steps per refill
        )
        integrator = integrators.HeunStochastic(dt=dt, noise=node_noise)
    else:
        integrator = integrators.HeunDeterministic(dt=dt)

    monitor = monitors.TemporalAverage(period=spec.monitor_period_ms)

    sim = simulator.Simulator(
        model=model,
        connectivity=conn,
        coupling=coupler,
        integrator=integrator,
        monitors=(monitor,),
        # TVB horizon = max(rint(delays / dt)) + 1 over all entries (Connectivity.set_idelays).
        initial_conditions=_initial_history(spec, int(np.rint(D / dt).max()) + 1),
        simulation_length=(spec.burn_in_s + duration + TAIL_PAD_S) * 1000.0,
    )
    sim.configure()
    # TVB advances current_step by (history length - 1) when initial conditions are given, which
    # shifts the monitor's averaging grid with the delay horizon. The seeded history is constant
    # in time, so restarting the step counter at 0 keeps the time origin and monitor grid
    # identical for every C/D (node outputs at G=0 do not depend on the delay matrix).
    sim.current_step = 0

    started = time.perf_counter()
    ((monitor_t_ms, monitor_data),) = sim.run()
    integration_s = time.perf_counter() - started

    v_monitor = (monitor_data[:, 0, :, 0] - monitor_data[:, 1, :, 0]).T.astype(np.float64)
    if not np.all(np.isfinite(v_monitor)):
        raise FloatingPointError("JR integration produced non-finite values")

    q = spec.decimation
    v_out_full = signal.resample_poly(v_monitor, up=1, down=q, axis=1, padtype="line")
    start = int(round(spec.burn_in_s * spec.output_fs))
    n_out = int(round(duration * spec.output_fs))
    v_out = np.ascontiguousarray(v_out_full[:, start : start + n_out], dtype=np.float64)
    if v_out.shape[1] != n_out:
        raise RuntimeError(f"expected {n_out} output samples, got {v_out.shape[1]}")

    seeds = spec.seeds
    meta: dict[str, Any] = {
        "generator": "tvb.JansenRit",
        "tvb_version": tvb_version(),
        "preset": spec.preset,
        "preset_version": spec.version,
        "validated": False,
        "units": "mV",
        "variable": "y1 - y2",
        "dt_ms": dt,
        "integrator": type(integrator).__name__,
        "monitor": "TemporalAverage",
        "monitor_period_ms": spec.monitor_period_ms,
        "monitor_hz": spec.monitor_hz,
        "steps_per_monitor": spec.steps_per_monitor,
        "first_monitor_time_ms": float(monitor_t_ms[0]),
        "resampling": {
            "method": "scipy.signal.resample_poly",
            "up": 1,
            "down": q,
            "padtype": "line",
        },
        "output_fs": spec.output_fs,
        "burn_in_s": spec.burn_in_s,
        "duration_s": duration,
        "tail_pad_s": TAIL_PAD_S,
        "coupling": {
            "kind": "SigmoidalJansenRit",
            "G": spec.G,
            **{k: float(getattr(coupler, k)[0]) for k in ("cmin", "cmax", "midpoint", "r")},
        },
        "C": C.tolist(),
        "D": D.tolist(),
        "orientation": "C[target, source]",
        "node_params": {k: float(getattr(model, k)[0]) for k in JR_PARAM_NAMES},
        "input_noise": spec.input_noise.model_dump(),
        "noise_nsig_y4": nsig_y4,
        "seed_root": seeds.root,
        "seeds": {
            "input": [seeds.seed_for("input", "node", i) for i in range(n)],
            "initial_state": [seeds.seed_for("initial_state", "node", i) for i in range(n)],
        },
        "initial_state_box": {k: list(v) for k, v in INITIAL_STATE_BOX.items()},
        "integration_wall_s": integration_s,
    }
    return JRSimulationResult(
        v=v_out, fs=float(spec.output_fs), node_ids=[f"n{i:02d}" for i in range(n)], metadata=meta
    )


# --------------------------------------------------------------------------- presets

PRESET_NOTE = "starting values per plan §2.4; not validated physiology"


def _row_normalize(C: np.ndarray) -> np.ndarray:
    """Normalization rule: each node's total incoming weight is 1 (rows with no input stay 0)."""
    out = np.array(C, dtype=float)
    sums = out.sum(axis=1, keepdims=True)
    np.divide(out, sums, out=out, where=sums > 0)
    return out


def ring_lattice(n_nodes: int, k: int = 2) -> np.ndarray:
    """Symmetric ring lattice: each node receives from its ``k`` nearest neighbours per side."""
    C = np.zeros((n_nodes, n_nodes))
    for target in range(n_nodes):
        for hop in range(1, k + 1):
            if hop >= n_nodes:
                break
            C[target, (target - hop) % n_nodes] = 1.0
            C[target, (target + hop) % n_nodes] = 1.0
    np.fill_diagonal(C, 0.0)
    return _row_normalize(C)


def _spec(
    n: int,
    C: np.ndarray,
    D: np.ndarray,
    *,
    preset: str,
    G: float,
    seed: int,
    duration_s: float,
    burn_in_s: float,
    **overrides: Any,
) -> JRSimulationSpec:
    return JRSimulationSpec(
        preset=preset,
        n_nodes=n,
        C=C.tolist(),
        D=D.tolist(),
        G=G,
        duration_s=duration_s,
        burn_in_s=burn_in_s,
        seeds=SeedTree(root=seed),
        **overrides,
    )


def default_alpha_preset(
    n_nodes: int = 32,
    *,
    G: float = 10.0,
    delay_ms: float = 8.0,
    seed: int = 0,
    duration_s: float = 120.0,
    burn_in_s: float = 10.0,
    **overrides: Any,
) -> JRSimulationSpec:
    """Alpha-range JR network: row-normalized ring lattice (k=2), constant edge delay."""
    C = ring_lattice(n_nodes, k=2)
    D = np.where(C > 0, delay_ms, 0.0)
    return _spec(
        n_nodes,
        C,
        D,
        preset="jr-alpha-default",
        G=G,
        seed=seed,
        duration_s=duration_s,
        burn_in_s=burn_in_s,
        **overrides,
    )


def unidirectional_pair(
    *,
    G: float = 10.0,
    delay_ms: float = 8.0,
    seed: int = 0,
    duration_s: float = 32.0,
    burn_in_s: float = 10.0,
    **overrides: Any,
) -> JRSimulationSpec:
    """Two nodes with a single edge 0 → 1 (``C[1, 0] = 1``)."""
    C = np.zeros((2, 2))
    C[1, 0] = 1.0
    D = np.where(C > 0, delay_ms, 0.0)
    return _spec(
        2,
        C,
        D,
        preset="jr-unidirectional-pair",
        G=G,
        seed=seed,
        duration_s=duration_s,
        burn_in_s=burn_in_s,
        **overrides,
    )


def chain_graph(
    n_nodes: int = 3,
    *,
    G: float = 10.0,
    delay_ms: float = 8.0,
    seed: int = 0,
    duration_s: float = 32.0,
    burn_in_s: float = 10.0,
    **overrides: Any,
) -> JRSimulationSpec:
    """Directed chain 0 → 1 → … → n-1 (nodes 0 and n-1 linked only indirectly)."""
    C = np.zeros((n_nodes, n_nodes))
    for i in range(1, n_nodes):
        C[i, i - 1] = 1.0
    D = np.where(C > 0, delay_ms, 0.0)
    return _spec(
        n_nodes,
        C,
        D,
        preset="jr-chain",
        G=G,
        seed=seed,
        duration_s=duration_s,
        burn_in_s=burn_in_s,
        **overrides,
    )


def fork_graph(
    *,
    G: float = 10.0,
    delay_ms: float = 8.0,
    seed: int = 0,
    duration_s: float = 32.0,
    burn_in_s: float = 10.0,
    **overrides: Any,
) -> JRSimulationSpec:
    """Common driver 0 → 1 and 0 → 2; nodes 1 and 2 share input but have no direct edge."""
    C = np.zeros((3, 3))
    C[1, 0] = 1.0
    C[2, 0] = 1.0
    D = np.where(C > 0, delay_ms, 0.0)
    return _spec(
        3,
        C,
        D,
        preset="jr-fork",
        G=G,
        seed=seed,
        duration_s=duration_s,
        burn_in_s=burn_in_s,
        **overrides,
    )


def with_coupling(spec: JRSimulationSpec, G: float) -> JRSimulationSpec:
    """Same spec (C, D, seeds, noise) with a different global coupling; G=0 is condition A."""
    return spec.model_copy(update={"G": float(G)})


def psd_peak_hz(
    v: np.ndarray, fs: float, fmin: float = 1.0, fmax: float = 45.0, nperseg_s: float = 4.0
) -> np.ndarray:
    """Welch PSD peak frequency per node within [fmin, fmax] (reporting helper)."""
    nperseg = min(int(nperseg_s * fs), v.shape[-1])
    freqs, pxx = signal.welch(v, fs=fs, nperseg=nperseg, axis=-1)
    band = (freqs >= fmin) & (freqs <= fmax)
    return freqs[band][np.argmax(pxx[..., band], axis=-1)]


__all__ = [
    "INITIAL_STATE_BOX",
    "JRSimulationResult",
    "PRESET_NOTE",
    "chain_graph",
    "default_alpha_preset",
    "fork_graph",
    "noise_intensity",
    "psd_peak_hz",
    "ring_lattice",
    "simulate_jr",
    "tvb_version",
    "unidirectional_pair",
    "with_coupling",
]
