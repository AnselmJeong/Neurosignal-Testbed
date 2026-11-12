"""Analysis-question presets (plan §1.3).

Each preset names what is manipulated, what is held fixed, the primary metrics and contrast,
the null, and the data length it needs. Only Q1 is executable in the first vertical slice
(plan §8.1); Q2-Q7 are declared as ``planned`` metadata so catalogs can show them honestly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

__all__ = [
    "PRESETS",
    "Q1",
    "QuestionPreset",
    "get_preset",
]

PresetStatus = Literal["implemented", "planned"]


@dataclass(frozen=True)
class QuestionPreset:
    id: str
    title: str
    question: str
    status: PresetStatus
    primary_metrics: tuple[str, ...]
    secondary_metrics: tuple[str, ...] = ()
    manipulated: dict[str, str] = field(default_factory=dict)
    held_fixed: tuple[str, ...] = ()
    primary_contrasts: tuple[str, ...] = ()
    null: str = ""
    required_length: dict[str, float] = field(default_factory=dict)
    aliases: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()
    # Observation gain applied to sensor observations whose recipe gain is the contract default
    # (1.0 A·m/mV, a placeholder). None for presets that do not observe.
    observation_gain: float | None = None
    observation_gain_note: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "title": self.title,
            "question": self.question,
            "status": self.status,
            "primary_metrics": list(self.primary_metrics),
            "secondary_metrics": list(self.secondary_metrics),
            "manipulated": dict(self.manipulated),
            "held_fixed": list(self.held_fixed),
            "primary_contrasts": list(self.primary_contrasts),
            "null": self.null,
            "required_length": dict(self.required_length),
            "aliases": list(self.aliases),
            "notes": list(self.notes),
            "observation_gain": self.observation_gain,
            "observation_gain_note": self.observation_gain_note,
        }


Q1 = QuestionPreset(
    id="Q1",
    title="Q1 · What changes when the true coupling changes?",
    question=(
        "Coupling on/off (G=0 vs G>0) crossed with observation (identity probe vs EEG forward): "
        "seed-paired coupling, observation and interaction effects in source and sensor space."
    ),
    status="implemented",
    primary_metrics=("M14", "M17", "M23"),
    secondary_metrics=("welch_peak_hz", "welch_log10_power_1_45Hz"),
    manipulated={
        "G": "global coupling: exactly two levels, 0 (off) and one value > 0 (on)",
        "observation": "identity_probe and eeg_forward (source_native is always added)",
    },
    held_fixed=(
        "C, D, node parameters, input noise (same per-node realization for G on/off)",
        "seed tree per benchmark seed (reused across G levels)",
        "reference",
        "sensor_noise_std",
        "observation gain",
        "epoch_s (8 s, non-overlapping)",
        "preprocessing (none)",
        "metric parameters",
    ),
    primary_contrasts=("B-A", "D-C", "C-A", "D-B", "(D-C)-(B-A)", "source_on-source_off"),
    null=(
        "seed-paired sign-flip randomization of per-seed differences, p=(b+1)/(B+1); "
        "per-edge source tests use the max-statistic over edges (FWER) within metric x feature"
    ),
    required_length={
        "epoch_s": 8.0,
        "min_epochs_spectral": 5.0,  # neurobridge.metrics.connectivity DEFAULT_MIN_EPOCHS
        "min_duration_s": 40.0,
        "recommended_duration_s": 120.0,
        "min_seeds_for_ci": 2.0,
    },
    aliases=("jr-coupling-x-observation",),
    notes=(
        "Coupling on also shifts the JR PSD peak (~7 Hz off -> ~10.3 Hz on with the default "
        "preset): every connectivity contrast is reported next to Welch peak/power contrasts "
        "(plan §2.5).",
        "Effect direction is never forced; A > B is kept as a result.",
    ),
    observation_gain=1e-8,
    observation_gain_note=(
        "1e-8 A·m/mV (10 nA·m per mV of JR membrane-potential difference): uncalibrated "
        "order-of-magnitude choice for realistic µV-scale scalp signals. PLV/wPLI/wSMI are "
        "scale-invariant without sensor noise; recalibrate before adding sensor noise."
    ),
)


def _planned(pid: str, title: str, primary: tuple[str, ...], manipulated: str) -> QuestionPreset:
    return QuestionPreset(
        id=pid,
        title=title,
        question=title,
        status="planned",
        primary_metrics=primary,
        manipulated={"planned": manipulated},
    )


PRESETS: dict[str, QuestionPreset] = {
    "Q1": Q1,
    "Q2": _planned(
        "Q2",
        "Q2 · Does mixing or reference alone create connectivity without coupling?",
        ("M11", "M12", "M14", "M17", "M19", "M23"),
        "observation operator and reference at G=0",
    ),
    "Q3": _planned(
        "Q3",
        "Q3 · Are oscillation power/frequency/background changes distinguished from coupling?",
        ("M01", "M04", "M05", "M14", "M17"),
        "nuisance parameters with C and G fixed",
    ),
    "Q4": _planned(
        "Q4",
        "Q4 · Do pattern diversity and between-population dependence change together?",
        ("M24", "M25", "M26", "M21", "M23"),
        "local dynamics vs coupling",
    ),
    "Q5": _planned(
        "Q5",
        "Q5 · Are results stable across recording length, segment and seed?",
        (),
        "duration prefix, segment and seed",
    ),
    "Q6": _planned(
        "Q6",
        "Q6 · Does artifact removal reduce contamination while preserving neural signal?",
        ("M02", "M24", "M14"),
        "artifact injection and cleaning",
    ),
    "Q7": _planned(
        "Q7",
        "Q7 · Are directionality and PAC distinguished in known controls?",
        ("M27", "M28", "M29"),
        "directed graphs, common input, harmonics",
    ),
}


def get_preset(name: str) -> QuestionPreset:
    """Resolve a preset by ID (``Q1``) or alias (``jr-coupling-x-observation``)."""
    if name in PRESETS:
        return PRESETS[name]
    for preset in PRESETS.values():
        if name in preset.aliases:
            return preset
    raise KeyError(f"unknown question preset {name!r}")
