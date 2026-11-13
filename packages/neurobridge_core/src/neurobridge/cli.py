from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from neurobridge.contracts.models import ExperimentRecipe
from neurobridge.service import run_experiment


def main(argv: list[str] | None = None) -> None:
    args_list = sys.argv[1:] if argv is None else list(argv)
    if args_list and args_list[0] == "benchmark":
        raise SystemExit(benchmark_main(args_list[1:]))
    if args_list and args_list[0] == "flow":
        raise SystemExit(flow_main(args_list[1:]))
    parser = argparse.ArgumentParser(description="Run a NeuroSignal experiment recipe")
    parser.add_argument("recipe", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(args_list)
    recipe = ExperimentRecipe.model_validate_json(args.recipe.read_text())
    result = run_experiment(recipe)
    payload = result.model_dump_json(indent=2)
    if args.output:
        args.output.write_text(payload)
    else:
        print(payload)


# --------------------------------------------------------------------------- benchmark


def _benchmark_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="neurosignal-recipe benchmark",
        description="JR resting-EEG benchmark (Q1 coupling x observation vertical slice)",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("validate", help="schema, scientific and cost checks of a recipe")
    p.add_argument("recipe", type=Path)
    p = sub.add_parser("run", help="plan and run a recipe inline (blocking)")
    p.add_argument("recipe", type=Path)
    p.add_argument("--root", type=Path, required=True, help="artifact/job store root")
    p.add_argument("--experiment-id")
    p.add_argument("--json", action="store_true", help="print the full results JSON")
    p = sub.add_parser("resume", help="resume an experiment, reusing valid artifacts")
    p.add_argument("experiment_id")
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("export", help="write results.json, summary.csv and recipe.json")
    p.add_argument("experiment_id")
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    return parser


def _fmt(x: Any, nd: int = 4) -> str:
    return "—" if x is None else f"{x:.{nd}g}" if isinstance(x, float) else str(x)


def _print_summary(results: dict[str, Any]) -> None:
    job = results["job"] or {}
    tasks = job.get("tasks", {})
    print(
        f"experiment {results['experiment_id']}  preset {results['preset']}  "
        f"profile {results['profile']}  seeds {results['seeds']}  G {results['coupling_levels']}"
    )
    print(f"job {job.get('job_id')}: {job.get('state')}  tasks {tasks}")
    for failure in job.get("failures", [])[:10]:
        print(f"  ! {failure['task_id']}: {failure['reason_code']} {failure.get('message') or ''}")
    for w in results["warnings"]:
        print(f"  warning: {w}")
    print("\nmetric status by condition (count over seeds):")
    table: dict[tuple[str, str], dict[str, int]] = {}
    for r in results["metric_results"]:
        key = (r["condition"], f"{r['metric_id']}:{r['variant']}")
        label = r["status"] if r["status"] == "ok" else f"{r['status']}/{r['reason_code']}"
        table.setdefault(key, {}).setdefault(label, 0)
        table[key][label] += 1
    for (cond, metric), counts in sorted(table.items()):
        print(f"  {cond:<11} {metric:<12} {counts}")
    print("\nseed-paired effects (b - a; mean off-diagonal per feature; 95% bootstrap CI, seeds):")
    for comp in results["comparisons"]:
        head = f"  [{comp['analysis_space']}] {comp['metric_id']}:{comp['variant']}"
        if "summary" not in comp:
            print(
                f"{head}: {comp['status']} ({comp['reason_code']}) "
                f"cells={comp.get('metric_cell_statuses')}"
            )
            continue
        print(head)
        for r in comp["summary"] + comp["companions"]:
            c = r["contrast"]
            name = f"{c['condition_b']} vs {c['condition_a']}"
            feat = (c["feature"] or "").replace(";summary=offdiag_mean", "")
            if c["metric_id"] != comp["metric_id"]:
                feat = f"{c['metric_id']}"
            print(
                f"    {name:<22} {feat:<26} n={r['independent_n']} est={_fmt(r['estimate'])} "
                f"CI=[{_fmt(r['ci_low'])}, {_fmt(r['ci_high'])}] p={_fmt(r['p_value'], 3)}"
                + ("" if r["status"] == "ok" else f" {r['status']}/{r['reason_code']}")
            )
        if comp["edges"]:
            sig = sum(1 for r in comp["edges"] if r["p_value"] is not None and r["p_value"] <= 0.05)
            print(f"    source per-edge results: {len(comp['edges'])} (FWER p<=0.05: {sig})")
    for ev in results["evaluation"]:
        if "conditions" not in ev:
            print(f"  [evaluation] {ev['metric_id']}: {ev['status']} ({ev['reason_code']})")
            continue
        for c in ev["conditions"]:
            aucs = ", ".join(f"{f['feature']}={_fmt(f['mean_auc'], 3)}" for f in c["by_feature"])
            print(
                f"  [evaluation source] {ev['metric_id']} {c['condition']} (G={c['G']:g}) "
                f"edge-vs-non-edge AUC: {aucs}"
            )


def benchmark_main(argv: list[str]) -> int:
    from neurobridge.benchmarks import runner

    args = _benchmark_parser().parse_args(argv)
    if args.command == "validate":
        report = runner.validate(args.recipe)
        print(json.dumps(report, indent=2))
        return 0 if report["ok"] else 1
    if args.command == "export":
        paths = runner.export_experiment(args.root, args.experiment_id, args.out)
        print(json.dumps(paths, indent=2))
        return 0
    if args.command == "run":
        report = runner.validate(args.recipe)
        if not report["ok"]:
            print(json.dumps(report, indent=2))
            return 1
        handle = runner.run_experiment(
            args.recipe, args.root, inline=True, experiment_id=args.experiment_id
        )
    else:
        handle = runner.resume_experiment(args.root, args.experiment_id, inline=True)
    results = runner.collect_results(args.root, handle.experiment_id)
    if args.json:
        print(json.dumps(results, indent=2))
    else:
        _print_summary(results)
    return 0 if handle.job.state == "completed" else 2


# --------------------------------------------------------------------------- flow


def _flow_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="neurosignal-recipe flow",
        description="Educational information-flow pipeline on simulated 32-channel EEG",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("concepts", help="print the Korean concept catalogue as JSON")
    p.add_argument("--id", dest="concept_id", help="print a single concept entry")
    p = sub.add_parser("run", help="simulate, observe, analyse and evaluate a flow recipe")
    p.add_argument("recipe", type=Path)
    p.add_argument("--root", type=Path, help="artifact store root (result JSON + arrays)")
    p.add_argument("--run-id")
    p.add_argument("--json", action="store_true", help="print the full result JSON")
    return parser


def _print_flow_summary(result: dict[str, Any]) -> None:
    print(
        f"flow run {result['run_id']}  profile {result['profile']}  "
        f"total {result['timings_s']['total_s']:.1f}s  frozen sha256 "
        f"{result['truth_isolation']['frozen_analysis_sha256'][:12]}"
    )
    for name, meta in result["simulation"]["conditions"].items():
        peaks = ", ".join(f"{v:.1f}" for v in meta["psd_peak_hz"])
        print(f"  simulation {name:<8} G={meta['G']:g}  PSD peaks Hz [{peaks}]")
    print("\nmethod status per dataset:")
    for ds in result["datasets"]:
        cells = []
        for mid, m in ds["methods"].items():
            label = "ok" if m["status"] == "ok" else f"{m['status']}/{m['reason_code']}"
            cells.append(f"{mid}={label}")
        print(f"  {ds['dataset_id']:<22} {ds['wall_s']:5.1f}s  " + "  ".join(cells))
    ev = result["evaluation"]
    print("\nsource-space evaluation (truth used only here, after freezing):")
    for src in ev["source"]:
        parts = []
        for mid, s in src["scores"].items():
            a = (s.get("edge_auc") or {}).get("auc")
            d = (s.get("direction") or {}).get("accuracy")
            sig = s.get("significance") or {}
            txt = f"{mid}: AUC={_fmt(a, 3)} dir={_fmt(d, 3)}"
            if sig:
                txt += f" TP={sig['true_positives']} FP={sig['false_positives']}"
            parts.append(txt)
        print(f"  [{src['condition']} G={src['G']:g}] " + " | ".join(parts))
        for mc in src["model_comparisons"]:
            print(
                f"    model {mc['name']:<18} best={mc['best_model']} expected="
                f"{mc['expected_model']} match={mc['match']}"
            )
    print("\nsensor space (no truth scoring; G=0 structure = volume conduction/reference/noise):")
    for s in ev["sensor"]:
        pw, cg = s.get("gc_pairwise", {}), s.get("gc_conditional", {})
        print(
            f"  [{s['condition']} G={s['G']:g} ref={s['reference']}] "
            f"pairwise GC sig frac={_fmt(pw.get('fraction_significant_bonferroni'), 3)} "
            f"conditional GC sig frac={_fmt(cg.get('fraction_significant_bonferroni'), 3)}"
            + ("" if cg.get("status") == "ok" else f" ({cg.get('status')}/{cg.get('reason_code')})")
        )
    print("\nlessons:")
    for line in ev["lessons"]:
        print(f"  - {line}")
    if "paths" in result:
        print(f"\nresult: {result['paths']['result_json']}")


def flow_main(argv: list[str]) -> int:
    args = _flow_parser().parse_args(argv)
    if args.command == "concepts":
        from neurobridge.flow import concepts

        if args.concept_id:
            try:
                entry = concepts.get_concept(args.concept_id)
            except KeyError as exc:
                print(str(exc), file=sys.stderr)
                return 1
            print(entry.model_dump_json(indent=2))
        else:
            print(concepts.catalog_json())
        return 0

    from pydantic import ValidationError

    from neurobridge.flow import pipeline

    try:
        recipe = pipeline.load_recipe(args.recipe)
    except (OSError, ValidationError) as exc:
        print(f"invalid flow recipe: {exc}", file=sys.stderr)
        return 1
    result = pipeline.run_flow_pipeline(
        recipe,
        root=args.root,
        run_id=args.run_id,
        progress=lambda msg: print(f"... {msg}", file=sys.stderr, flush=True),
    )
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        _print_flow_summary(result)
    return 0
