import pytest
from neurobridge.contracts.models import IcaApplyRequest, IcaRecipe
from neurobridge.ica import apply_ica_exclusions, fit_ica_workbench


@pytest.fixture(scope="module")
def planted_fit():
    return fit_ica_workbench(IcaRecipe())


def apply_request(fit, exclusions: list[int]) -> IcaApplyRequest:
    return IcaApplyRequest(
        recipe=fit.recipe,
        excluded_components=exclusions,
        compatibility_fingerprint=fit.compatibility.fingerprint,
        target_reference=fit.recipe.reference,
        target_channel_names=fit.compatibility.channel_names,
    )


def test_rank_aware_ica_recovers_planted_blink(planted_fit) -> None:
    blink = planted_fit.components[planted_fit.blink_component_index]
    assert planted_fit.compatibility.rank == 7
    assert len(planted_fit.components) == 4
    assert blink.matched_truth == "blink"
    assert blink.matched_correlation > 0.95
    assert planted_fit.mean_matched_correlation > 0.95


def test_icalabel_is_advisory_and_never_an_exclusion(planted_fit) -> None:
    blink = planted_fit.components[planted_fit.blink_component_index]
    assert planted_fit.icalabel_available is True
    assert blink.suggested_label == "eye blink"
    assert 0 <= blink.suggestion_probability <= 1
    assert not hasattr(planted_fit, "excluded_components")


def test_manual_blink_exclusion_attenuates_artifact_with_bounded_distortion(
    planted_fit,
) -> None:
    result = apply_ica_exclusions(
        apply_request(planted_fit, [planted_fit.blink_component_index])
    )
    assert result.compatibility_verified is True
    assert result.artifact_attenuation_db > 30
    assert result.neural_distortion_pct < 20
    assert result.neural_retention_pct > 80


def test_incompatible_reference_blocks_apply(planted_fit) -> None:
    request = apply_request(planted_fit, [planted_fit.blink_component_index])
    incompatible = request.model_copy(update={"target_reference": "none"})
    with pytest.raises(ValueError, match="incompatible"):
        apply_ica_exclusions(incompatible)


def test_no_artifact_control_exposes_cost_of_unnecessary_removal() -> None:
    control = fit_ica_workbench(
        IcaRecipe(blink_amplitude_uv=0)
    )
    result = apply_ica_exclusions(apply_request(control, [0]))
    assert control.components[control.blink_component_index].matched_correlation == 0
    assert result.artifact_attenuation_db < 0
    assert result.neural_distortion_pct > 50
