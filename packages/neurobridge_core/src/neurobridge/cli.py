from __future__ import annotations

import argparse
from pathlib import Path

from neurobridge.contracts.models import ExperimentRecipe
from neurobridge.service import run_experiment


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a NeuroSignal experiment recipe")
    parser.add_argument("recipe", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    recipe = ExperimentRecipe.model_validate_json(args.recipe.read_text())
    result = run_experiment(recipe)
    payload = result.model_dump_json(indent=2)
    if args.output:
        args.output.write_text(payload)
    else:
        print(payload)
