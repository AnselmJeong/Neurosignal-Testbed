from __future__ import annotations

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from neurobridge import __version__
from neurobridge.contracts.models import (
    ExperimentRecipe,
    ExperimentResult,
    IcaApplyRequest,
    IcaApplyResult,
    IcaFitResult,
    IcaRecipe,
    WarningMessage,
)
from neurobridge.ica import apply_ica_exclusions, fit_ica_workbench
from neurobridge.module_registry import capability_manifest
from neurobridge.preprocessing import validate_recipe
from neurobridge.service import run_experiment
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
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
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


def run() -> None:
    uvicorn.run("neurobridge_api.main:app", host="127.0.0.1", port=8000, reload=False)
