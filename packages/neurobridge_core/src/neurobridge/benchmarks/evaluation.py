"""Truth-aware evaluation, source space only (plan §4.5).

Runs after the metrics are frozen and is the only consumer of generation truth. JR ``C`` is a
direct-connection truth: the summary contrasts direct edges with non-edges (mean difference and
AUC) in native source space. Sensors carry no node-level truth here; asking for a sensor
evaluation raises.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np
from scipy.stats import rankdata

from neurobridge.benchmarks.comparisons import edge_values

__all__ = ["direct_edge_mask", "evaluate_source_metric"]


def direct_edge_mask(truth: Mapping[str, Any], n_nodes: int) -> np.ndarray:
    """Undirected direct-edge indicator for pairs ``i < j`` (edge if either direction planted)."""
    planted = truth.get("planted_edges")
    adj = np.zeros((n_nodes, n_nodes), dtype=bool)
    if planted is not None:
        for target, source in planted:
            adj[int(target), int(source)] = True
    else:
        adj = np.asarray(truth["C"], dtype=np.float64) != 0
    np.fill_diagonal(adj, False)
    und = adj | adj.T
    rows, cols = np.triu_indices(n_nodes, k=1)
    return und[rows, cols]


def _auc(pos: np.ndarray, neg: np.ndarray) -> float | None:
    if pos.size == 0 or neg.size == 0:
        return None
    ranks = rankdata(np.concatenate([pos, neg]))
    u = ranks[: pos.size].sum() - pos.size * (pos.size + 1) / 2.0
    return float(u / (pos.size * neg.size))


def evaluate_source_metric(
    *,
    metric_id: str,
    variant: str,
    analysis_space: str,
    labels: Sequence[str],
    values: Mapping[str, Mapping[int, np.ndarray]],
    coupling: Mapping[str, float],
    truth: Mapping[str, Any],
) -> dict[str, Any]:
    """Direct edge vs non-edge summary per source condition, feature and seed."""
    if analysis_space != "source":
        raise ValueError("truth-aware evaluation is defined for native source space only")
    conditions = []
    for cond, cells in values.items():
        g = float(coupling[cond])
        rows = []
        for seed, v in sorted(cells.items()):
            e, _ = edge_values(v)
            mask = direct_edge_mask(truth, np.asarray(v).shape[-1])
            for f_idx, lab in enumerate(labels):
                vals = e[f_idx]
                ok = np.isfinite(vals)
                pos, neg = vals[mask & ok], vals[~mask & ok]
                rows.append(
                    {
                        "seed": int(seed),
                        "feature": lab,
                        "n_edges": int(pos.size),
                        "n_non_edges": int(neg.size),
                        "mean_edge": float(pos.mean()) if pos.size else None,
                        "mean_non_edge": float(neg.mean()) if neg.size else None,
                        "difference": (
                            float(pos.mean() - neg.mean()) if pos.size and neg.size else None
                        ),
                        "auc_edge_vs_non_edge": _auc(pos, neg),
                    }
                )
        by_feature = []
        for lab in labels:
            feats = [r for r in rows if r["feature"] == lab]
            diffs = [r["difference"] for r in feats if r["difference"] is not None]
            aucs = [
                r["auc_edge_vs_non_edge"] for r in feats if r["auc_edge_vs_non_edge"] is not None
            ]
            by_feature.append(
                {
                    "feature": lab,
                    "n_seeds": len(diffs),
                    "mean_difference": float(np.mean(diffs)) if diffs else None,
                    "mean_auc": float(np.mean(aucs)) if aucs else None,
                }
            )
        conditions.append(
            {
                "condition": cond,
                "G": g,
                "coupling_active": g > 0,
                "interpretation": (
                    "direct-edge detection (coupling on)"
                    if g > 0
                    else "negative control: structural edges carry no coupling at G=0"
                ),
                "per_seed": rows,
                "by_feature": by_feature,
            }
        )
    return {
        "metric_id": metric_id,
        "variant": variant,
        "analysis_space": "source",
        "truth_scope": (
            "JR C = direct connections; pairwise dependence may also arise from indirect "
            "paths, so non-edge values are not called algorithm failures (plan §4.5)"
        ),
        "edge_definition": "undirected pair i<j is an edge if C[i][j] or C[j][i] is planted",
        "conditions": conditions,
    }
