import pytest
from neurobridge.contracts.models import ExperimentRecipe, PreprocessingSpec, SimulationSpec
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
