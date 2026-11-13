"""Truth-aware scoring of a frozen flow-pipeline analysis payload.

Called by :func:`neurobridge.flow.pipeline.run_flow_pipeline` only after the analysis results
are frozen (their sha256 is recorded before and checked after evaluation). Ground truth (the
generating ``C[target, source]``) is used **only in source space**: sensor channels are not
sources, so sensor datasets get a truth-free report of how much directed structure appears
with coupling switched off (G=0), which can only come from volume conduction, the reference,
sensor noise or estimator bias.

Scores use the raw estimates (no ``abs``/clipping); a score that cannot be computed is a
status with a reason, never 0.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:  # pragma: no cover
    from neurobridge.flow.pipeline import FlowRecipe

# (method_id, human label) for matrix-valued directed estimates scored against truth.
SCORED_MATRIX_METHODS: tuple[tuple[str, str], ...] = (
    ("gc_pairwise", "pairwise GC"),
    ("gc_conditional", "conditional GC"),
    ("te_gaussian", "Gaussian TE"),
    ("te_ksg", "KSG TE (declared pairs)"),
    ("effective_model", "linear effective model A (raw value)"),
)
P_VALUE_METHODS = ("gc_pairwise", "gc_conditional", "te_gaussian", "te_ksg")


@dataclass(frozen=True)
class GroundTruth:
    node_names: list[str]
    C: np.ndarray  # [target, source]
    G_by_condition: dict[str, float]

    def structural(self) -> np.ndarray:
        return self.C > 0

    def active(self, condition: str) -> np.ndarray:
        """Edges that actually carry influence: structural edges with G > 0."""
        if self.G_by_condition.get(condition, 0.0) > 0:
            return self.structural()
        return np.zeros_like(self.C, dtype=bool)


def ground_truth_from_recipe(recipe: FlowRecipe) -> GroundTruth:
    return GroundTruth(
        node_names=recipe.graph.node_names,
        C=recipe.graph.coupling_matrix(),
        G_by_condition={
            "coupled": recipe.simulation.G,
            "control": recipe.simulation.control_G,
        },
    )


# --------------------------------------------------------------------------- primitives


def _matrix(values: Any) -> np.ndarray | None:
    if values is None:
        return None
    return np.array(
        [[np.nan if v is None else float(v) for v in row] for row in values], dtype=float
    )


def auc(positive: np.ndarray, negative: np.ndarray) -> float | None:
    """Mann-Whitney AUC P(score_pos > score_neg) with ties counted 1/2."""
    if positive.size == 0 or negative.size == 0:
        return None
    diff = positive[:, None] - negative[None, :]
    return float(np.mean((diff > 0) + 0.5 * (diff == 0)))


def _edge_scores(M: np.ndarray, adjacency: np.ndarray) -> dict[str, Any]:
    n = M.shape[0]
    off = ~np.eye(n, dtype=bool)
    finite = off & np.isfinite(M)
    pos = M[finite & adjacency]
    neg = M[finite & ~adjacency]
    value = auc(pos, neg)
    out: dict[str, Any] = {
        "n_edges_scored": int(pos.size),
        "n_non_edges_scored": int(neg.size),
        "auc": value,
        "status": "ok" if value is not None else "not_applicable",
    }
    if value is None:
        out["reason_code"] = "no_edges_or_no_non_edges_scored"
    return out


def _direction_accuracy(M: np.ndarray, adjacency: np.ndarray, names: list[str]) -> dict[str, Any]:
    rows = []
    for t, s in zip(*np.nonzero(adjacency), strict=True):
        if adjacency[s, t]:
            continue  # reciprocal edge: no single correct direction
        fwd, bwd = M[t, s], M[s, t]
        if not (np.isfinite(fwd) and np.isfinite(bwd)):
            continue
        rows.append(
            {
                "edge": f"{names[s]}->{names[t]}",
                "forward": fwd,
                "backward": bwd,
                "correct": fwd > bwd,
            }
        )
    if not rows:
        return {"status": "not_applicable", "reason_code": "no_unidirectional_edge_scored"}
    return {
        "status": "ok",
        "accuracy": float(np.mean([r["correct"] for r in rows])),
        "n_edges": len(rows),
        "edges": rows,
    }


def _significance(
    p: np.ndarray | None, adjacency: np.ndarray, alpha: float
) -> dict[str, Any] | None:
    if p is None:
        return None
    n = p.shape[0]
    off = ~np.eye(n, dtype=bool)
    finite = off & np.isfinite(p)
    m = int(finite.sum())
    if m == 0:
        return None
    sig = finite & (p <= alpha / m)
    return {
        "correction": "bonferroni over tested ordered pairs",
        "threshold": alpha / m,
        "n_tested": m,
        "true_positives": int((sig & adjacency).sum()),
        "false_positives": int((sig & ~adjacency).sum()),
        "n_edges_tested": int((finite & adjacency).sum()),
        "n_non_edges_tested": int((finite & ~adjacency).sum()),
    }


def _fork_siblings(C: np.ndarray) -> list[tuple[int, int, int]]:
    """(driver, d, e) with driver -> d, driver -> e and no edge between d and e."""
    adj = C > 0
    out = []
    n = C.shape[0]
    for c in range(n):
        kids = [k for k in range(n) if adj[k, c]]
        for i, d in enumerate(kids):
            for e in kids[i + 1 :]:
                if not adj[e, d] and not adj[d, e]:
                    out.append((c, d, e))
    return out


def _indirect_paths(C: np.ndarray) -> list[tuple[int, int, int]]:
    """(i, j, k) with i -> j -> k and no direct edge between i and k."""
    adj = C > 0
    n = C.shape[0]
    return [
        (i, j, k)
        for j in range(n)
        for i in range(n)
        for k in range(n)
        if len({i, j, k}) == 3 and adj[j, i] and adj[k, j] and not adj[k, i] and not adj[i, k]
    ]


def _cell(method: Mapping[str, Any], t: int, s: int, alpha_bonf: float | None) -> dict:
    M = _matrix(method.get("values")) if method.get("status") == "ok" else None
    P = _matrix(method.get("p_values")) if method.get("status") == "ok" else None
    if M is None:
        return {"status": method.get("status"), "reason_code": method.get("reason_code")}
    p = None if P is None or not np.isfinite(P[t, s]) else float(P[t, s])
    value = float(M[t, s]) if np.isfinite(M[t, s]) else None
    return {
        "value": value,
        "p_value": p,
        "significant_bonferroni": None if p is None or alpha_bonf is None else p <= alpha_bonf,
    }


def _spurious_report(
    methods: Mapping[str, Any], a: int, b: int, names: list[str], alpha: float, label: str
) -> dict[str, Any]:
    """Pairwise vs conditional GC (and Gaussian TE) on a non-edge in both directions."""
    rows = []
    for s, t in ((a, b), (b, a)):
        cells = {}
        for mid in ("gc_pairwise", "gc_conditional", "te_gaussian"):
            method = methods.get(mid, {})
            n_tested = (method.get("significance") or {}).get("n_tested")
            cells[mid] = _cell(method, t, s, alpha / n_tested if n_tested else None)
        pw, cd = cells["gc_pairwise"].get("value"), cells["gc_conditional"].get("value")
        rows.append(
            {
                "direction": f"{names[s]}->{names[t]}",
                **cells,
                "conditional_minus_pairwise": None if pw is None or cd is None else cd - pw,
                "conditional_weaker": None if pw is None or cd is None else cd < pw,
                "pairwise_detected": cells["gc_pairwise"].get("significant_bonferroni"),
                "conditional_detected": cells["gc_conditional"].get("significant_bonferroni"),
            }
        )
    weaker = [r["conditional_weaker"] for r in rows]
    return {
        "kind": label,
        "pair": [names[a], names[b]],
        "directions": rows,
        "conditional_weaker_both_directions": None if None in weaker else all(weaker),
        "spurious_detected_pairwise": any(bool(r["pairwise_detected"]) for r in rows),
        "spurious_detected_conditional": any(bool(r["conditional_detected"]) for r in rows),
    }


def _expected_model(mc: Mapping[str, Any], truth: GroundTruth, condition: str) -> str:
    idx = {n: i for i, n in enumerate(truth.node_names)}
    act = truth.active(condition)
    a, b = (idx[n] for n in mc["nodes"])
    ab, ba = bool(act[b, a]), bool(act[a, b])
    if ab and ba:
        return "bidirectional"
    if ab:
        return "forward"
    if ba:
        return "backward"
    driver = mc.get("driver_node")
    if driver is not None and act[a, idx[driver]] and act[b, idx[driver]]:
        return "common_input"
    return "none"


# --------------------------------------------------------------------------- evaluation


def _evaluate_source_dataset(
    ds: Mapping[str, Any], truth: GroundTruth, alpha: float
) -> dict[str, Any]:
    names = truth.node_names
    if list(ds["channel_names"]) and len(ds["channel_names"]) != len(names):
        return {"status": "invalid_input", "reason_code": "channel_count_mismatch"}
    condition = ds["condition"]
    active = truth.active(condition)
    structural = truth.structural()
    methods = ds["methods"]
    out: dict[str, Any] = {
        "dataset_id": ds["dataset_id"],
        "condition": condition,
        "G": ds["G"],
        "n_active_edges": int(active.sum()),
        "scores": {},
    }
    for mid, label in SCORED_MATRIX_METHODS:
        method = methods.get(mid, {})
        if method.get("status") != "ok":
            out["scores"][mid] = {
                "label": label,
                "status": method.get("status", "missing"),
                "reason_code": method.get("reason_code") or "method_missing",
            }
            continue
        M = _matrix(method.get("values"))
        assert M is not None
        P = _matrix(method.get("p_values")) if mid in P_VALUE_METHODS else None
        entry: dict[str, Any] = {"label": label, "score": "raw estimate (no abs)"}
        if active.any():
            entry["edge_auc"] = _edge_scores(M, active)
            entry["direction"] = _direction_accuracy(M, active, names)
        else:
            entry["edge_auc"] = {
                "status": "not_applicable",
                "reason_code": "no_active_edges_at_G0",
                "structural_auc": _edge_scores(M, structural)["auc"],
                "note": "G=0: 구조 간선은 있지만 신호가 흐르지 않으므로 AUC≈0.5가 기대값입니다.",
            }
        entry["significance"] = _significance(P, active, alpha)
        n_surr = (method.get("parameters") or {}).get("n_surrogates") or 0
        if mid == "te_ksg" and entry["significance"] and n_surr > 0:
            min_p = 1.0 / (n_surr + 1)
            entry["significance"]["min_attainable_p"] = min_p
            entry["significance"]["underpowered_surrogate_test"] = (
                min_p > entry["significance"]["threshold"]
            )
        out["scores"][mid] = entry

    # spurious-edge lessons (structural motifs; meaningful when coupled)
    out["fork_spurious"] = [
        {"driver": names[c], **_spurious_report(methods, d, e, names, alpha, "fork_siblings")}
        for c, d, e in _fork_siblings(truth.C)
    ]
    out["chain_indirect"] = [
        {"via": names[j], **_spurious_report(methods, i, k, names, alpha, "chain_indirect")}
        for i, j, k in _indirect_paths(truth.C)
    ]

    eff = methods.get("effective_model", {})
    comparisons = []
    for mc in eff.get("comparisons", []) or []:
        expected = _expected_model(mc, truth, condition)
        best = mc.get("best_model")
        posteriors = {m["name"]: m.get("posterior") for m in mc.get("models", []) or []}
        comparisons.append(
            {
                "name": mc["name"],
                "expected_model": expected,
                "best_model": best,
                "match": None if best is None else best == expected,
                "posterior_of_expected": posteriors.get(expected),
                "status": mc.get("status"),
                "residuals_not_white": (
                    (mc.get("var1_residual_whiteness") or {}).get("fraction_rejected_at_0.05") or 0
                )
                > 0,
            }
        )
    out["model_comparisons"] = comparisons

    pid = methods.get("pid", {})
    pid_rows = []
    idx = {n: i for i, n in enumerate(names)}
    for tr in pid.get("triplets", []) or []:
        t = idx[tr["target_node"]]
        a, b = (idx[n] for n in tr["source_nodes"])
        nats = tr.get("nats") or {}
        pid_rows.append(
            {
                "name": tr["name"],
                "status": tr.get("status"),
                "target_receives_from": {
                    tr["source_nodes"][0]: bool(active[t, a]),
                    tr["source_nodes"][1]: bool(active[t, b]),
                },
                "redundancy": nats.get("redundancy"),
                "unique_a": nats.get("unique_s1"),
                "unique_b": nats.get("unique_s2"),
                "synergy": nats.get("synergy"),
                "joint_mi": nats.get("i_s12_t"),
            }
        )
    out["pid"] = pid_rows
    af = methods.get("activity_flow", {})
    out["activity_flow"] = (
        (af.get("summary") or {}).get("comparison")
        if af.get("status") == "ok"
        else {"status": af.get("status"), "reason_code": af.get("reason_code")}
    )
    return out


def _sensor_summary(ds: Mapping[str, Any]) -> dict[str, Any]:
    methods = ds["methods"]
    out: dict[str, Any] = {
        "dataset_id": ds["dataset_id"],
        "condition": ds["condition"],
        "G": ds["G"],
        "reference": ds["reference"],
        "truth_scoring": "not applicable: sensor channels are not sources",
    }
    for mid in ("gc_pairwise", "gc_conditional", "te_gaussian"):
        m = methods.get(mid, {})
        if m.get("status") != "ok":
            out[mid] = {"status": m.get("status"), "reason_code": m.get("reason_code")}
            continue
        M = _matrix(m.get("values"))
        assert M is not None
        off = ~np.eye(M.shape[0], dtype=bool) & np.isfinite(M)
        sig = m.get("significance") or {}
        n_tested = sig.get("n_tested") or 0
        out[mid] = {
            "status": "ok",
            "mean_offdiag": float(np.mean(M[off])) if off.any() else None,
            "max_offdiag": float(np.max(M[off])) if off.any() else None,
            "n_significant_bonferroni": sig.get("n_significant_bonferroni"),
            "fraction_significant_bonferroni": (
                sig.get("n_significant_bonferroni", 0) / n_tested if n_tested else None
            ),
        }
    tr = methods.get("gc_time_reversed", {})
    if tr.get("status") == "ok":
        net = _matrix(tr.get("values"))
        assert net is not None
        off = ~np.eye(net.shape[0], dtype=bool) & np.isfinite(net)
        out["gc_time_reversed"] = {
            "status": "ok",
            "mean_net": float(np.mean(net[off])),
            "fraction_net_positive": float(np.mean(net[off] > 0)),
        }
    else:
        out["gc_time_reversed"] = {"status": tr.get("status"), "reason_code": tr.get("reason_code")}
    af = methods.get("activity_flow", {})
    if af.get("status") == "ok":
        out["activity_flow"] = {
            "with_neighbor_exclusion": (af.get("summary") or {}).get("comparison"),
            "without_neighbor_exclusion": (af.get("without_neighbor_exclusion") or {}).get(
                "comparison"
            ),
        }
    else:
        out["activity_flow"] = {"status": af.get("status"), "reason_code": af.get("reason_code")}
    return out


def _lessons(source: list[dict[str, Any]], sensor: list[dict[str, Any]]) -> list[str]:
    lessons: list[str] = []
    coupled = next((s for s in source if s["condition"] == "coupled"), None)
    control = next((s for s in source if s["condition"] == "control"), None)
    if coupled:
        cg = coupled["scores"].get("gc_conditional", {}).get("edge_auc", {})
        pg = coupled["scores"].get("gc_pairwise", {}).get("edge_auc", {})
        if cg.get("auc") is not None and pg.get("auc") is not None:
            lessons.append(
                f"소스 공간 G>0: 조건부 GC 간선 AUC {cg['auc']:.2f}, 쌍별 GC {pg['auc']:.2f}."
            )
        for fork in coupled.get("fork_spurious", []):
            lessons.append(
                f"fork 형제 {fork['pair'][0]}↔{fork['pair'][1]} (구동자 {fork['driver']}): 쌍별 GC "
                f"허위 검출={fork['spurious_detected_pairwise']}, 조건부 GC 허위 검출="
                f"{fork['spurious_detected_conditional']}, 조건부가 양방향 모두 더 약함="
                f"{fork['conditional_weaker_both_directions']}."
            )
        wrong = [c for c in coupled.get("model_comparisons", []) if c["match"] is False]
        if wrong:
            lessons.append(
                "선형 VAR(p) 모델 비교가 정답과 다른 모델을 고른 비교: "
                + ", ".join(f"{c['name']}({c['best_model']}≠{c['expected_model']})" for c in wrong)
                + " — 모델 가정이 틀리면 사후확률이 높아도 결론이 틀릴 수 있습니다."
            )
    if control:
        labels = {
            "gc_pairwise": "쌍별 GC",
            "gc_conditional": "조건부 GC",
            "te_gaussian": "Gaussian TE(짧은 임베딩, 분석적 χ² p)",
        }
        parts = []
        for mid, label in labels.items():
            sig = control["scores"].get(mid, {}).get("significance") or {}
            if sig:
                parts.append(f"{label} {sig['false_positives']}/{sig['n_tested']}")
        if parts:
            lessons.append(
                "소스 공간 G=0 대조 거짓 양성(Bonferroni): "
                + ", ".join(parts)
                + ". 목표 자신의 과거를 충분히 임베딩하지 않으면 자기상관이 남아 분석적 p값이 "
                "부풀려집니다."
            )
    for s in sensor:
        if s["condition"] != "control":
            continue
        pw = s.get("gc_pairwise", {})
        if pw.get("status") == "ok":
            lessons.append(
                f"센서({s['reference']}) G=0: 결합이 없는데도 쌍별 GC 유의 쌍 비율 "
                f"{pw['fraction_significant_bonferroni']:.2f} — "
                "볼륨 전도·기준전극·센서잡음의 산물입니다."
            )
    return lessons


def evaluate_flow(
    analysis: Mapping[str, Any], truth: GroundTruth, *, alpha: float = 0.05
) -> dict[str, Any]:
    """Score a frozen analysis payload. Source space against truth; sensor space truth-free."""
    source, sensor = [], []
    for ds in analysis["datasets"]:
        if ds["space"] == "source":
            source.append(_evaluate_source_dataset(ds, truth, alpha))
        else:
            sensor.append(_sensor_summary(ds))
    return {
        "truth_scope": (
            "정답(C)은 결과가 고정된 뒤 소스 공간에서만 사용됩니다. 센서 채널은 소스가 아니므로 "
            "센서 공간에는 정밀도/재현율 대신 G=0에서 나타나는 방향성 구조만 보고합니다."
        ),
        "alpha": alpha,
        "true_edges": [
            f"{truth.node_names[s]}->{truth.node_names[t]}"
            for t, s in zip(*np.nonzero(truth.structural()), strict=True)
        ],
        "source": source,
        "sensor": sensor,
        "lessons": _lessons(source, sensor),
    }


__all__ = [
    "GroundTruth",
    "SCORED_MATRIX_METHODS",
    "auc",
    "evaluate_flow",
    "ground_truth_from_recipe",
]
