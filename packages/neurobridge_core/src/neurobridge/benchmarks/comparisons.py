"""Seed-paired condition comparisons (plan §4.3, §4.4, §2.5).

The independent unit is the simulation seed: per-seed summaries are differenced within seed,
the confidence interval bootstraps seeds (never epochs or edges) and the null flips the sign
of whole per-seed differences. Surrogate p-values are ``(b + 1) / (B + 1)``; the effect
direction is never forced (A > B stays a result).

Summaries
---------
* sensor and source: mean of the off-diagonal entries per feature (band or tau). A summary is
  missing (``None``) if any off-diagonal entry is non-finite; it is never replaced by 0.
* source additionally: every undirected edge ``i < j`` per feature; the per-edge p-value is the
  max-statistic (FWER) over the edges of one metric x feature x contrast.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from neurobridge.benchmarks.contracts import (
    ComparisonResult,
    ContrastDefinition,
    MetricStatus,
    PerSeedValue,
    SeedTree,
)

__all__ = [
    "INTERACTION",
    "SENSOR_CONTRASTS",
    "SOURCE_CONTRASTS",
    "compare_metric",
    "edge_values",
    "feature_labels",
    "offdiag_mean",
    "paired_stats",
]

CI_LEVEL = 0.95
SENSOR_CONTRASTS: tuple[tuple[str, str, str], ...] = (
    ("B-A", "A", "B"),
    ("D-C", "C", "D"),
    ("C-A", "A", "C"),
    ("D-B", "B", "D"),
)
# name, (a, b) of the first difference, (a, b) of the second; estimate = second - first
INTERACTION: tuple[str, tuple[str, str], tuple[str, str]] = ("(D-C)-(B-A)", ("A", "B"), ("C", "D"))
SOURCE_CONTRASTS: tuple[tuple[str, str, str], ...] = (
    ("source_on-source_off", "source_off", "source_on"),
)
COMPANION_FEATURES = ("welch_peak_hz", "welch_log10_power_1_45Hz")


def feature_labels(axes: Sequence[str], parameters: Mapping[str, Any], shape: Sequence[int]):
    """Labels for the leading (band/tau) axis of a metric value array; ``["all"]`` for 2-D."""
    if len(shape) == 2:
        return ["all"]
    lead = axes[0] if axes else "feature"
    if lead == "band" and parameters.get("band_order"):
        return [f"band={b}" for b in parameters["band_order"]]
    if lead == "tau" and parameters.get("taus_samples"):
        return [f"tau={t}" for t in parameters["taus_samples"]]
    return [f"{lead}={i}" for i in range(shape[0])]


def _as_3d(values: np.ndarray) -> np.ndarray:
    arr = np.asarray(values, dtype=np.float64)
    if arr.ndim == 2:
        arr = arr[None]
    if arr.ndim != 3 or arr.shape[1] != arr.shape[2]:
        raise ValueError(f"expected (n_features, n, n) or (n, n) values, got {arr.shape}")
    return arr


def offdiag_mean(values: np.ndarray) -> np.ndarray:
    """Mean off-diagonal value per feature; NaN where any off-diagonal entry is non-finite."""
    arr = _as_3d(values)
    n = arr.shape[1]
    mask = ~np.eye(n, dtype=bool)
    off = arr[:, mask]
    out = off.mean(axis=1)
    out[~np.all(np.isfinite(off), axis=1)] = np.nan
    return out


def edge_values(values: np.ndarray) -> tuple[np.ndarray, list[tuple[int, int]]]:
    """Values of the undirected pairs ``i < j`` per feature: ``(n_features, n_pairs)``."""
    arr = _as_3d(values)
    rows, cols = np.triu_indices(arr.shape[1], k=1)
    return arr[:, rows, cols], list(zip(rows.tolist(), cols.tolist(), strict=True))


@dataclass
class PairedStats:
    n: int
    estimate: np.ndarray
    ci_low: np.ndarray | None
    ci_high: np.ndarray | None
    p_value: np.ndarray | None
    null_family: str | None


def paired_stats(
    diffs: np.ndarray,
    *,
    n_bootstrap: int,
    n_surrogates: int,
    boot_rng: np.random.Generator,
    null_rng: np.random.Generator,
    fwer: bool = False,
) -> PairedStats:
    """Mean of per-seed differences ``diffs`` (n_seeds, k) with seed bootstrap CI and sign flips.

    The sign-flip null enumerates all non-identity flips when ``2**n - 1 <= n_surrogates``
    (exact) and otherwise draws ``n_surrogates`` random flips. ``fwer`` uses the maximum
    |statistic| over the ``k`` columns for every flip.
    """
    d = np.asarray(diffs, dtype=np.float64)
    n, k = d.shape
    estimate = d.mean(axis=0)
    if n < 2:
        return PairedStats(n, estimate, None, None, None, None)
    weights = np.zeros((n_bootstrap, n))
    draws = boot_rng.integers(0, n, size=(n_bootstrap, n))
    for row in range(n_bootstrap):
        np.add.at(weights[row], draws[row], 1.0)
    boot = (weights / n) @ d
    alpha = (1.0 - CI_LEVEL) / 2.0
    ci_low = np.quantile(boot, alpha, axis=0)
    ci_high = np.quantile(boot, 1.0 - alpha, axis=0)
    if 2**n - 1 <= n_surrogates:
        grid = ((np.arange(1, 2**n)[:, None] >> np.arange(n)) & 1).astype(np.float64)
        signs = 1.0 - 2.0 * grid  # every non-identity sign pattern
        family = f"seed_sign_flip_exact(B={signs.shape[0]})"
    else:
        signs = null_rng.choice(np.array([-1.0, 1.0]), size=(n_surrogates, n))
        family = f"seed_sign_flip_random(B={n_surrogates})"
    null = np.abs(signs @ d / n)  # (B, k)
    observed = np.abs(estimate) * (1.0 - 1e-12)
    if fwer:
        b = (null.max(axis=1)[:, None] >= observed[None, :]).sum(axis=0)
        family += "+max_statistic_fwer"
    else:
        b = (null >= observed[None, :]).sum(axis=0)
    p = (b + 1.0) / (signs.shape[0] + 1.0)
    return PairedStats(n, estimate, ci_low, ci_high, p, family)


def _f(x: Any) -> float | None:
    if x is None:
        return None
    x = float(x)
    return x if np.isfinite(x) else None


def _results(
    contrast_base: dict[str, Any],
    labels: Sequence[str],
    seeds: Sequence[int],
    a: np.ndarray,
    b: np.ndarray,
    *,
    n_bootstrap: int,
    n_surrogates: int,
    tree: SeedTree,
    rng_path: tuple[str, ...],
    test_family: str,
    fwer: bool = False,
) -> list[ComparisonResult]:
    """One ComparisonResult per column of ``a``/``b`` (n_seeds, k) arrays (NaN = missing)."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    diff = b - a
    out: list[ComparisonResult] = []
    if fwer:
        valid = np.all(np.isfinite(diff), axis=1)
        groups = [(valid, list(range(diff.shape[1])))]
    else:
        groups = [(np.isfinite(diff[:, j]), [j]) for j in range(diff.shape[1])]
    for valid, cols in groups:
        stats = None
        if valid.any():
            stats = paired_stats(
                diff[np.ix_(valid, cols)],
                n_bootstrap=n_bootstrap,
                n_surrogates=n_surrogates,
                boot_rng=tree.generator("bootstrap", *rng_path, str(cols[0])),
                null_rng=tree.generator("surrogate", *rng_path, str(cols[0])),
                fwer=fwer,
            )
        for idx, j in enumerate(cols):
            contrast = ContrastDefinition(**contrast_base, feature=labels[j])
            per_seed = [
                PerSeedValue(
                    seed=int(s),
                    value_a=_f(a[i, j]),
                    value_b=_f(b[i, j]),
                    difference=_f(diff[i, j]),
                )
                for i, s in enumerate(seeds)
            ]
            if stats is None:
                out.append(
                    ComparisonResult(
                        contrast=contrast,
                        status=MetricStatus.INSUFFICIENT_DATA,
                        reason_code="no_paired_seeds",
                        independent_n=0,
                        test_family=test_family,
                        per_seed_values=per_seed,
                    )
                )
                continue
            out.append(
                ComparisonResult(
                    contrast=contrast,
                    independent_n=stats.n,
                    estimate=float(stats.estimate[idx]),
                    ci_low=None if stats.ci_low is None else float(stats.ci_low[idx]),
                    ci_high=None if stats.ci_high is None else float(stats.ci_high[idx]),
                    ci_level=CI_LEVEL,
                    null_family=stats.null_family,
                    test_family=test_family,
                    p_value=None if stats.p_value is None else float(stats.p_value[idx]),
                    per_seed_values=per_seed,
                )
            )
    return out


def _stack(cells: Mapping[int, np.ndarray | None], seeds: Sequence[int], k: int) -> np.ndarray:
    rows = []
    for s in seeds:
        v = cells.get(s)
        rows.append(np.full(k, np.nan) if v is None else np.asarray(v, dtype=np.float64))
    return np.vstack(rows)


def _contrast_list(space: str) -> tuple[list[tuple[str, str, str]], bool]:
    if space == "sensor":
        return list(SENSOR_CONTRASTS), True
    return list(SOURCE_CONTRASTS), False


def compare_metric(
    *,
    metric_id: str,
    variant: str,
    space: str,
    seeds: Sequence[int],
    values: Mapping[str, Mapping[int, np.ndarray | None]],
    labels: Sequence[str],
    spectral: Mapping[str, Mapping[int, np.ndarray | None]] | None = None,
    n_bootstrap: int = 999,
    n_surrogates: int = 49,
    stats_seed: int = 0,
) -> dict[str, Any]:
    """Compare one metric across the conditions of ``space`` (``sensor`` or ``source``).

    ``values[condition][seed]`` is the metric value array (or None when missing);
    ``spectral[condition][seed]`` the (n_channels, 2) Welch peak/log-power summary.
    """
    tree = SeedTree(root=stats_seed)
    seeds = [int(s) for s in seeds]
    contrasts, interaction = _contrast_list(space)
    k = len(labels)
    summary: dict[str, np.ndarray] = {}
    for cond, cells in values.items():
        summary[cond] = _stack(
            {s: None if v is None else offdiag_mean(v) for s, v in cells.items()}, seeds, k
        )
    base = {"metric_id": metric_id, "variant": variant, "analysis_space": space}
    family = f"{space}:{metric_id}:{variant}:offdiag_mean:{k} feature(s):uncorrected"
    results: list[ComparisonResult] = []
    for name, ca, cb in contrasts:
        if ca not in summary or cb not in summary:
            continue
        results += _results(
            {**base, "condition_a": ca, "condition_b": cb},
            [f"{lab};summary=offdiag_mean" for lab in labels],
            seeds,
            summary[ca],
            summary[cb],
            n_bootstrap=n_bootstrap,
            n_surrogates=n_surrogates,
            tree=tree,
            rng_path=(metric_id, variant, space, name),
            test_family=family,
        )
    if interaction and all(c in summary for c in "ABCD"):
        name, (a1, b1), (a2, b2) = INTERACTION
        results += _results(
            {
                **base,
                "condition_a": f"{b1}-{a1}",
                "condition_b": f"{b2}-{a2}",
                "estimand": "paired_difference_of_differences",
            },
            [f"{lab};summary=offdiag_mean" for lab in labels],
            seeds,
            summary[b1] - summary[a1],
            summary[b2] - summary[a2],
            n_bootstrap=n_bootstrap,
            n_surrogates=n_surrogates,
            tree=tree,
            rng_path=(metric_id, variant, space, name),
            test_family=family,
        )

    edges: list[ComparisonResult] = []
    if space == "source":
        for name, ca, cb in contrasts:
            if ca not in values or cb not in values:
                continue
            for f_idx, lab in enumerate(labels):
                a_rows, b_rows, pairs = [], [], None
                for s in seeds:
                    va, vb = values[ca].get(s), values[cb].get(s)
                    for v, rows in ((va, a_rows), (vb, b_rows)):
                        if v is None:
                            rows.append(None)
                        else:
                            e, pairs = edge_values(v)
                            rows.append(e[f_idx])
                if pairs is None:
                    continue
                n_pairs = len(pairs)
                a_arr = np.vstack([np.full(n_pairs, np.nan) if r is None else r for r in a_rows])
                b_arr = np.vstack([np.full(n_pairs, np.nan) if r is None else r for r in b_rows])
                edges += _results(
                    {**base, "condition_a": ca, "condition_b": cb},
                    [f"{lab};edge=n{i:02d}-n{j:02d}" for i, j in pairs],
                    seeds,
                    a_arr,
                    b_arr,
                    n_bootstrap=n_bootstrap,
                    n_surrogates=n_surrogates,
                    tree=tree,
                    rng_path=(metric_id, variant, space, name, lab, "edges"),
                    test_family=(
                        f"source:{metric_id}:{variant}:{lab}:{n_pairs} undirected edges:"
                        "max-statistic FWER"
                    ),
                    fwer=True,
                )

    companions: list[ComparisonResult] = []
    if spectral:
        spec_summary = {
            cond: _stack(
                {s: None if v is None else np.asarray(v).mean(axis=0) for s, v in cells.items()},
                seeds,
                2,
            )
            for cond, cells in spectral.items()
        }
        pairs_c = [(name, ca, cb) for name, ca, cb in contrasts]
        for name, ca, cb in pairs_c:
            if ca not in spec_summary or cb not in spec_summary:
                continue
            for j, feat in enumerate(COMPANION_FEATURES):
                companions += _results(
                    {
                        "metric_id": feat,
                        "variant": "runner-welch",
                        "analysis_space": space,
                        "condition_a": ca,
                        "condition_b": cb,
                    },
                    ["channel_mean"],
                    seeds,
                    spec_summary[ca][:, [j]],
                    spec_summary[cb][:, [j]],
                    n_bootstrap=n_bootstrap,
                    n_surrogates=n_surrogates,
                    tree=tree,
                    rng_path=(feat, space, name),
                    test_family=f"{space}:spectral companion:{feat}:uncorrected",
                )
    return {
        "metric_id": metric_id,
        "variant": variant,
        "analysis_space": space,
        "seeds": seeds,
        "feature_labels": list(labels),
        "summary": [r.model_dump(mode="json") for r in results],
        "edges": [r.model_dump(mode="json") for r in edges],
        "companions": [r.model_dump(mode="json") for r in companions],
        "statistics": {
            "unit": "simulation seed",
            "ci": f"percentile bootstrap over seeds (B={n_bootstrap}), level {CI_LEVEL}",
            "p_value": "(b+1)/(B+1), two-sided seed sign-flip",
            "stats_seed": stats_seed,
        },
    }
