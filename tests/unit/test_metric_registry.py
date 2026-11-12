import pytest
from neurobridge.benchmarks.contracts import IN_SCOPE_METRIC_IDS, MetricResult, MetricStatus
from neurobridge.metrics import registry as reg


@pytest.fixture
def fresh():
    return reg.MetricRegistry()


def test_exactly_29_in_scope_ids():
    expected = [f"M{i:02d}" for i in (*range(1, 7), *range(11, 34))]
    assert list(reg.METRIC_IDS) == expected
    assert list(reg.METRIC_DEFINITIONS) == expected
    assert reg.METRIC_IDS == IN_SCOPE_METRIC_IDS
    assert len(reg.METRIC_DEFINITIONS) == 29
    for definition in reg.METRIC_DEFINITIONS.values():
        assert definition.dependency_group in reg.DEPENDENCY_GROUP_MODULES
        assert definition.dependency_modules
        assert definition.name and definition.backend_candidate and definition.value_domain


def test_signed_metrics_are_marked():
    signed = {mid for mid, d in reg.METRIC_DEFINITIONS.items() if d.signed}
    assert {"M11", "M13", "M15", "M18", "M19", "M20"} <= signed
    assert "M14" not in signed


def test_all_ids_start_planned(fresh):
    caps = fresh.capabilities()
    assert set(caps) == set(reg.METRIC_IDS)
    assert {entry["status"] for entry in caps.values()} == {"planned"}
    for entry in caps.values():
        assert isinstance(entry["dependency_available"], bool)
        assert entry["dependency_available"] == (not entry["missing_modules"])


def test_capabilities_reports_core_present_and_unknown_module_missing(fresh, monkeypatch):
    caps = fresh.capabilities()
    assert caps["M14"]["dependency_available"] is True  # mne_connectivity is a core dep
    monkeypatch.setitem(
        reg.DEPENDENCY_GROUP_MODULES, "pac", ("definitely_not_installed_module_xyz",)
    )
    assert reg.dependency_status()["pac"] is False
    assert reg.dependency_status()["core"] is True


@pytest.mark.parametrize("metric_id", list(IN_SCOPE_METRIC_IDS))
def test_run_on_planned_metric_returns_status_not_values(fresh, metric_id):
    result = fresh.run(metric_id, data=[[0.0, 1.0]], ctx={})
    assert isinstance(result, MetricResult)
    assert result.status is MetricStatus.UNSUPPORTED_DEPENDENCY
    assert result.reason_code in {"adapter_not_registered", "dependency_missing"}
    assert result.values is None and result.artifact_ref is None


def test_run_unknown_id_and_variant(fresh):
    unknown = fresh.run("M07", None, {})
    assert unknown.status is MetricStatus.INVALID_INPUT
    assert unknown.reason_code == "unknown_metric_id"

    fresh.register("M14", "alpha", _ok_adapter("M14", "alpha"))
    bad_variant = fresh.run("M14", None, {}, variant="beta")
    assert bad_variant.status is MetricStatus.INVALID_INPUT
    assert bad_variant.reason_code == "unknown_variant"


def _ok_adapter(metric_id, variant):
    def fn(data, ctx):
        return MetricResult(
            metric_id=metric_id, status="ok", variant=variant, values=data, units="1"
        )

    return fn


def test_registered_adapter_runs_and_becomes_implemented(fresh):
    fresh.register("M14", "alpha", _ok_adapter("M14", "alpha"))
    fresh.register("M14", "theta", _ok_adapter("M14", "theta"))
    assert fresh.implementation_status("M14") == "implemented"
    assert fresh.capabilities()["M14"]["variants"] == ["alpha", "theta"]
    assert fresh.capabilities()["M14"]["default_variant"] == "alpha"
    result = fresh.run("M14", [[1.0, 0.5], [0.5, 1.0]], {})
    assert result.status is MetricStatus.OK and result.variant == "alpha"
    assert fresh.run("M14", [0.2], {}, variant="theta").variant == "theta"
    fresh.register("M14", "theta", _ok_adapter("M14", "theta"), default=True, replace=True)
    assert fresh.run("M14", [0.2], {}).variant == "theta"
    fresh.unregister("M14", "theta")
    fresh.unregister("M14", "alpha")
    assert fresh.implementation_status("M14") == "planned"


def test_register_rejects_bad_registration(fresh):
    with pytest.raises(ValueError):
        fresh.register("M07", "default", _ok_adapter("M07", "default"))
    fresh.register("M01", "welch", _ok_adapter("M01", "welch"))
    with pytest.raises(ValueError):
        fresh.register("M01", "welch", _ok_adapter("M01", "welch"))


def test_failing_adapter_returns_failed_status(fresh):
    def boom(data, ctx):
        raise RuntimeError("backend exploded")

    fresh.register("M17", "default", boom)
    result = fresh.run("M17", [[1.0]], {})
    assert result.status is MetricStatus.FAILED
    assert result.reason_code == "adapter_exception"
    assert result.values is None
    assert result.diagnostics["exception_type"] == "RuntimeError"
    assert "backend exploded" in result.message


def test_adapter_returning_garbage_or_wrong_id_is_failed(fresh):
    fresh.register("M11", "default", lambda data, ctx: 0.0)
    garbage = fresh.run("M11", None, {})
    assert garbage.status is MetricStatus.FAILED
    assert garbage.reason_code == "adapter_returned_invalid_type"

    fresh.register("M12", "default", _ok_adapter("M14", "default"))
    mismatch = fresh.run("M12", [1.0], {})
    assert mismatch.status is MetricStatus.FAILED
    assert mismatch.reason_code == "adapter_result_mismatch"


def test_adapter_non_ok_status_passes_through(fresh):
    fresh.register(
        "M25",
        "default",
        lambda data, ctx: MetricResult.from_status("M25", "insufficient_data", "no_matches"),
    )
    result = fresh.run("M25", [1.0], {})
    assert result.status is MetricStatus.INSUFFICIENT_DATA
    assert result.reason_code == "no_matches"


def test_module_level_api_uses_singleton():
    assert reg.registered_variants("M33") == reg.REGISTRY.registered_variants("M33")
    assert set(reg.capabilities()) == set(IN_SCOPE_METRIC_IDS)
    assert reg.get_definition("M23").backend_candidate.startswith("MNE-Connectivity wsmi")
    result = reg.run("M07", None, {})
    assert result.status is MetricStatus.INVALID_INPUT
