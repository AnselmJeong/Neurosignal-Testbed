from __future__ import annotations

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from neurobridge import __version__
from neurobridge.connectivity import run_connectivity_challenge
from neurobridge.contracts.models import (
    ConnectivityRecipe,
    ConnectivityResult,
    ExperimentRecipe,
    ExperimentResult,
    IcaApplyRequest,
    IcaApplyResult,
    IcaFitResult,
    IcaRecipe,
    SourceModelRecipe,
    SourceModelResult,
    WarningMessage,
)
from neurobridge.ica import apply_ica_exclusions, fit_ica_workbench
from neurobridge.module_registry import capability_manifest
from neurobridge.preprocessing import validate_recipe
from neurobridge.service import run_experiment
from neurobridge.source_modeling import run_source_model_benchmark
from pydantic import BaseModel

app = FastAPI(
    title="NeuroBridge EEG Lab API",
    version="1.0.0",
    description=(
        "Local-only scientific execution service. Educational and research use; "
        "not clinical diagnosis."
    ),
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5174", "http://127.0.0.1:5174"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)

RUNS: dict[str, ExperimentResult] = {}


class ValidationResponse(BaseModel):
    valid: bool
    warnings: list[WarningMessage]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ready", "api_version": "1.0", "engine_version": __version__}


@app.get("/capabilities")
def capabilities():
    return capability_manifest()


@app.get("/analysis-modules")
def analysis_modules():
    return capability_manifest().modules


@app.get("/lessons")
def lessons() -> list[dict[str, object]]:
    return [
        {
            "id": "foundations.sampling-filtering",
            "version": "1.0.0",
            "title": "What survives the sensor?",
            "objective": (
                "Predict how sampling and a 1–40 Hz filter change a known 2/10/60 Hz mixture."
            ),
            "steps": ["Predict", "Generate", "Observe", "Filter", "Compare", "Reveal"],
            "estimated_minutes": 8,
        },
        {
            "id": "preprocessing.ica-blink",
            "version": "1.0.0",
            "title": "Which component is the blink?",
            "objective": (
                "Fit ICA on a rank-aware high-pass copy, inspect every component, "
                "and remove the planted blink without erasing neural signal."
            ),
            "steps": ["Inspect", "Fit", "Label", "Select", "Apply", "Score"],
            "estimated_minutes": 12,
        },
        {
            "id": "connectivity.volume-conduction",
            "version": "1.0.0",
            "title": "When does a sensor edge lie?",
            "objective": (
                "Compare latent and sensor networks, threshold against epoch-shuffled "
                "surrogates, and explain volume-conduction and reference effects."
            ),
            "steps": ["Predict", "Estimate", "Threshold", "Compare", "Reveal", "Defend"],
            "estimated_minutes": 15,
        },
        {
            "id": "connectivity.reference-sensitivity",
            "version": "1.0.0",
            "title": "Same sources, different network?",
            "objective": (
                "Hold the latent graph fixed while switching sensor reference, then compare "
                "which sensor edges cross the same surrogate threshold."
            ),
            "steps": ["Predict", "Estimate", "Switch", "Compare", "Reveal", "Explain"],
            "estimated_minutes": 10,
        },
        {
            "id": "source-modeling.template-roi",
            "version": "1.0.0",
            "title": "How much of an ROI is really there?",
            "objective": (
                "Forward-project known template ROI activity, reconstruct it with MNE, "
                "and inspect source-resolution leakage before revealing latent truth."
            ),
            "steps": ["Predict", "Project", "Reconstruct", "Extract", "Compare", "Reveal"],
            "estimated_minutes": 15,
        },
    ]


@app.post("/runs/validate", response_model=ValidationResponse)
def validate_run(recipe: ExperimentRecipe) -> ValidationResponse:
    warnings = validate_recipe(recipe.simulation, recipe.preprocessing)
    return ValidationResponse(
        valid=not any(item.severity == "error" for item in warnings), warnings=warnings
    )


@app.post("/runs", response_model=ExperimentResult)
def create_run(recipe: ExperimentRecipe) -> ExperimentResult:
    warnings = validate_recipe(recipe.simulation, recipe.preprocessing)
    errors = [warning for warning in warnings if warning.severity == "error"]
    if errors:
        raise HTTPException(status_code=422, detail=[error.model_dump() for error in errors])
    result = run_experiment(recipe)
    RUNS[result.run_id] = result
    return result


@app.get("/runs/{run_id}", response_model=ExperimentResult)
def get_run(run_id: str) -> ExperimentResult:
    if run_id not in RUNS:
        raise HTTPException(status_code=404, detail="Run not found")
    return RUNS[run_id]


@app.post("/ica/fit", response_model=IcaFitResult)
def fit_ica(recipe: IcaRecipe) -> IcaFitResult:
    return fit_ica_workbench(recipe)


@app.post("/ica/apply", response_model=IcaApplyResult)
def apply_ica(request: IcaApplyRequest) -> IcaApplyResult:
    try:
        return apply_ica_exclusions(request)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/connectivity/runs", response_model=ConnectivityResult)
def create_connectivity_run(recipe: ConnectivityRecipe) -> ConnectivityResult:
    return run_connectivity_challenge(recipe)


@app.post("/source-modeling/runs", response_model=SourceModelResult)
def create_source_model_run(recipe: SourceModelRecipe) -> SourceModelResult:
    return run_source_model_benchmark(recipe)


def run() -> None:
    uvicorn.run("neurobridge_api.main:app", host="127.0.0.1", port=8001, reload=False)
