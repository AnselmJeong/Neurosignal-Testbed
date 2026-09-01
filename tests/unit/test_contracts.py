import json
from pathlib import Path

import pytest
from neurobridge.contracts.models import (
    ConnectivityRecipe,
    ExperimentRecipe,
    PreprocessingSpec,
    SimulationSpec,
    SourceModelRecipe,
)
from neurobridge.preprocessing import validate_recipe
from pydantic import ValidationError


def test_invalid_passband_is_rejected() -> None:
    with pytest.raises(ValidationError):
        PreprocessingSpec(highpass_hz=40, lowpass_hz=10)


def test_redundant_notch_is_an_educational_warning() -> None:
    warnings = validate_recipe(SimulationSpec(), PreprocessingSpec(lowpass_hz=40, notch_hz=60))
    assert "redundant_notch" in {warning.code for warning in warnings}


def test_recipe_forbids_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        ExperimentRecipe.model_validate({"surprise": True})


def test_connectivity_band_must_include_planted_frequency() -> None:
    with pytest.raises(ValidationError):
        ConnectivityRecipe(band_low_hz=12, band_high_hz=20)


def test_source_model_frequency_must_stay_below_nyquist() -> None:
    with pytest.raises(ValidationError, match="below Nyquist"):
        SourceModelRecipe(sampling_rate_hz=80, alpha_frequency_hz=40)


def test_source_model_lesson_fixture_matches_the_contract() -> None:
    fixture = Path(__file__).parents[2] / "fixtures" / "recipes" / "source-template-roi.json"
    recipe = SourceModelRecipe.model_validate(json.loads(fixture.read_text()))
    assert recipe.inverse_method == "MNE"
    assert recipe.montage == "standard_1020_14"


@pytest.mark.parametrize(
    "fixture_name",
    ["connectivity-volume-conduction.json", "connectivity-reference-sensitivity.json"],
)
def test_connectivity_lesson_fixtures_match_the_contract(fixture_name: str) -> None:
    fixture = Path(__file__).parents[2] / "fixtures" / "recipes" / fixture_name
    recipe = ConnectivityRecipe.model_validate(json.loads(fixture.read_text()))
    assert recipe.alpha_frequency_hz == 10
    assert recipe.band_low_hz < recipe.alpha_frequency_hz < recipe.band_high_hz
