"""Educational QEEG from forward-simulated EEG and an independent synthetic cohort."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

import mne
import numpy as np
import scipy
from pydantic import BaseModel, Field
from scipy import signal

CHANNELS = "Fp1 Fp2 F7 F3 Fz F4 F8 T7 C3 Cz C4 T8 P7 P3 Pz P4 P8 O1 O2".split()
EXTRA = "AF3 AF4 FC5 FC1 FC2 FC6 CP5 CP1 CP2 CP6 PO3 PO4 Oz".split()
BANDS = {"delta": (1, 4), "theta": (4, 8), "alpha": (8, 13), "beta": (13, 30), "gamma": (30, 45)}
FS, DURATION = 128, 32
# Head coordinates: x right, y anterior, z superior; positions in meters.
SOURCES = np.array(
    [
        [-0.025, -0.045, 0.045],
        [0.025, -0.045, 0.045],
        [-0.03, 0.035, 0.04],
        [0.03, 0.035, 0.04],
        [-0.04, -0.005, 0.04],
        [0.04, -0.005, 0.04],
    ]
)


class QeegLabRecipe(BaseModel):
    seed: int = Field(default=42, ge=0, le=2**32 - 1)
    montage: Literal["19", "32"] = "19"
    reference: Literal["average", "linked_mastoids"] = "average"
    head_model: Literal["standard", "conductive_skull"] = "standard"
    alpha_amplitude: float = Field(default=18, ge=2, le=45)
    theta_amplitude: float = Field(default=9, ge=2, le=35)
    beta_amplitude: float = Field(default=7, ge=2, le=30)
    alpha_hz: float = Field(default=10, ge=8, le=12)
    right_alpha_gain: float = Field(default=1, ge=0.25, le=2.5)
    cohort_size: int = Field(default=80, ge=20, le=200)
    cohort_seed: int = Field(default=2026, ge=0, le=2**32 - 1)


@lru_cache(maxsize=4)
def geometry(montage: str, head_model: str):
    names = CHANNELS + (EXTRA if montage == "32" else [])
    info = mne.create_info(names + ["A1", "A2"], FS, "eeg")
    info.set_montage("standard_1020")
    normals = SOURCES / np.linalg.norm(SOURCES, axis=1, keepdims=True)
    src = mne.setup_volume_source_space(
        pos={"rr": SOURCES, "nn": normals}, sphere=(0.0, 0.0, 0.0, 0.09), verbose=False
    )
    conductivities = (0.33, 1.0, 0.012 if head_model == "conductive_skull" else 0.004, 0.33)
    sphere = mne.make_sphere_model(
        r0=(0.0, 0.0, 0.0), head_radius=0.09, sigmas=conductivities, verbose=False
    )
    forward = mne.make_forward_solution(
        info, trans=None, src=src, bem=sphere, meg=False, eeg=True, verbose=False
    )
    # Free orientation leadfield: explicitly project each xyz triplet onto its radial normal.
    leadfield = np.einsum("csk,sk->cs", forward["sol"]["data"].reshape(-1, 6, 3), normals)
    xyz = np.array([ch["loc"][:3] for ch in info["chs"][: len(names)]])
    radius = np.linalg.norm(xyz, axis=1)
    polar = np.arccos(np.clip(xyz[:, 2] / radius, -1, 1))
    azimuth = np.arctan2(xyz[:, 1], xyz[:, 0])
    # Azimuthal equidistant projection, one geometry shared by every atlas tile.
    projected_radius = polar / max(polar) * 0.88
    xy = np.column_stack((projected_radius * np.cos(azimuth), projected_radius * np.sin(azimuth)))
    return names, leadfield, xyz, xy, conductivities


def simulate(recipe: QeegLabRecipe, rng: np.random.Generator, *, cohort: bool = False):
    names, leadfield, *_ = geometry(recipe.montage, recipe.head_model)
    t = np.arange(FS * DURATION) / FS
    alpha, theta, beta, peak, gain = (
        recipe.alpha_amplitude,
        recipe.theta_amplitude,
        recipe.beta_amplitude,
        recipe.alpha_hz,
        recipe.right_alpha_gain,
    )
    if cohort:
        alpha, theta, beta = np.array([18, 9, 7]) * rng.lognormal(0, 0.22, 3)
        peak, gain = np.clip(rng.normal(10, 0.45), 8, 12), rng.lognormal(0, 0.12)
    amplitudes = np.array([alpha, alpha * gain, theta, theta * 0.9, beta, beta * 0.9])
    frequencies = np.array([peak, peak, 6, 6, 20, 20])
    phases = rng.uniform(0, 2 * np.pi, (6, 1))
    # Slow modulation prevents a perfectly stationary sinusoid being the entire example.
    envelope = 1 + 0.2 * np.sin(2 * np.pi * 0.3 * t + phases)
    latent = amplitudes[:, None] * envelope * np.sin(2 * np.pi * frequencies[:, None] * t + phases)
    f = np.fft.rfftfreq(len(t), 1 / FS)
    background = rng.normal(size=(6, len(t)))
    background = np.fft.irfft(np.fft.rfft(background) / np.sqrt(np.maximum(f, 0.5)), n=len(t))
    background /= np.std(background, axis=1, keepdims=True)
    latent += 5 * background
    # nAm -> Am -> volts -> microvolts. Include actual A1/A2 forward signals.
    eeg = leadfield @ (latent * 1e-9) * 1e6 + rng.normal(0, 0.7, (len(names) + 2, len(t)))
    reference = (
        eeg[: len(names)].mean(axis=0) if recipe.reference == "average" else eeg[-2:].mean(axis=0)
    )
    return eeg[: len(names)] - reference, latent


def quantify(eeg: np.ndarray):
    f, psd = signal.welch(
        eeg,
        fs=FS,
        window="hann",
        nperseg=512,
        noverlap=256,
        detrend="constant",
        scaling="density",
        axis=-1,
    )
    valid = (f >= 1) & (f < 45)
    f, psd = f[valid], psd[:, valid]
    df = 0.25
    total = psd.sum(axis=1) * df
    absolute = np.array(
        [psd[:, (f >= lo) & (f < hi)].sum(axis=1) * df for lo, hi in BANDS.values()]
    )
    relative = absolute / total
    probability = psd / psd.sum(axis=1, keepdims=True)
    cumulative = probability.cumsum(axis=1)
    alpha_mask = (f >= 8) & (f < 13)
    return {
        "frequency_hz": f,
        "psd": psd,
        "absolute": absolute,
        "relative": relative,
        "theta_beta": absolute[1] / absolute[3],
        "alpha_peak_hz": f[alpha_mask][psd[:, alpha_mask].argmax(axis=1)],
        "median_hz": f[(cumulative >= 0.5).argmax(axis=1)],
        "sef95_hz": f[(cumulative >= 0.95).argmax(axis=1)],
        "entropy": -(probability * np.log(probability)).sum(axis=1) / np.log(len(f)),
    }


def transformed(metrics):
    rel = np.clip(metrics["relative"], 1e-12, 1 - 1e-12)
    return {
        "absolute": np.log(metrics["absolute"]),
        "relative": np.log(rel / (1 - rel)),
        "theta_beta": np.log(metrics["theta_beta"])[None, :],
    }


@lru_cache(maxsize=12)
def normative_cohort(montage, reference, head_model, size, seed):
    recipe = QeegLabRecipe(montage=montage, reference=reference, head_model=head_model)
    rng = np.random.default_rng(seed)
    members = [transformed(quantify(simulate(recipe, rng, cohort=True)[0])) for _ in range(size)]
    return {key: np.stack([member[key] for member in members]) for key in members[0]}


def run_qeeg_lab(recipe: QeegLabRecipe) -> dict:
    names, leadfield, xyz, xy, conductivities = geometry(recipe.montage, recipe.head_model)
    eeg, latent = simulate(recipe, np.random.default_rng(recipe.seed))
    metrics = quantify(eeg)
    f, psd = metrics["frequency_hz"], metrics["psd"]
    cohort = normative_cohort(
        recipe.montage, recipe.reference, recipe.head_model, recipe.cohort_size, recipe.cohort_seed
    )
    norms = {}
    for key, subject in transformed(metrics).items():
        values = cohort[key]
        mean, sd = values.mean(axis=0), values.std(axis=0, ddof=1)
        norms[key] = {
            "subject": subject,
            "mean": mean,
            "sd": sd,
            "z": (subject - mean) / sd,
            "percentile": 100
            * ((values < subject).sum(axis=0) + 0.5 * (values == subject).sum(axis=0))
            / len(values),
            "cohort_values": values,
        }
    # Ensemble-averaged spectra (15 overlapping 4 s windows), not one FFT coherence.
    _, _, segments = signal.stft(
        eeg, fs=FS, window="hann", nperseg=512, noverlap=256, boundary=None, padded=False
    )
    ff = np.fft.rfftfreq(512, 1 / FS)
    segments = segments[:, (ff >= 8) & (ff < 13)]
    cross = np.einsum("cft,dft->cdf", segments, segments.conj()) / segments.shape[-1]
    autos = (np.abs(segments) ** 2).mean(axis=-1)
    coherence = (np.abs(cross) ** 2 / (autos[:, None, :] * autos[None, :, :])).mean(axis=-1)
    sos = signal.butter(4, [8, 13], btype="bandpass", fs=FS, output="sos")
    analytic = signal.hilbert(signal.sosfiltfilt(sos, eeg), axis=-1)[:, FS:-FS]
    unit_phase = np.exp(1j * np.angle(analytic))
    plv = np.abs(unit_phase @ unit_phase.conj().T / unit_phase.shape[-1])
    atlas_absolute = np.array(
        [psd[:, (f >= hz) & (f < hz + 1)].sum(axis=1) * 0.25 for hz in range(1, 45)]
    )
    total = metrics["absolute"].sum(axis=0)
    result = {
        "recipe": recipe.model_dump(),
        "channel_names": names,
        "positions_2d": xy,
        "positions_m": xyz,
        "source_positions_m": SOURCES,
        "leadfield_v_per_am": leadfield,
        "conductivities_s_m": conductivities,
        "time_s": np.arange(FS * 10) / FS,
        "eeg_uv": eeg[:, : FS * 10],
        "source_nam": latent[:, : FS * 10],
        "metrics": metrics,
        "atlas_absolute": atlas_absolute,
        "atlas_relative": atlas_absolute / total,
        "bands": [{"name": key, "low": lo, "high": hi} for key, (lo, hi) in BANDS.items()],
        "norms": norms,
        "coherence": np.clip(coherence, 0, 1),
        "plv": np.clip(plv, 0, 1),
        "frontal_alpha_asymmetry": float(
            np.log(metrics["absolute"][2, names.index("F4")])
            - np.log(metrics["absolute"][2, names.index("F3")])
        ),
        "provenance": {
            "engine": "qeeg-simulation-v1",
            "mne": mne.__version__,
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "sfreq": FS,
            "duration_s": DURATION,
            "welch_window_s": 4,
            "overlap": 0.5,
            "frequency_step_hz": 0.25,
            "welch_segments": 15,
            "normative_kind": "synthetic educational cohort; no clinical population",
        },
    }
    return _json(result)


def _json(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, dict):
        return {key: _json(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json(item) for item in value]
    return value
