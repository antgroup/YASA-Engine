import pytest

from tests.integration.test_server_cases import (
    _assert_semantic_expected,
    _build_grouped_params,
)


def _cross_app_expected() -> dict[str, object]:
    """返回跨应用 case 共用的稳定验收契约。"""
    return {
        "$assertions": {
            "min_results": 1,
            "max_results": 10,
            "all_results": {"callType": "remote"},
        }
    }


def test_semantic_expected_accepts_non_empty_remote_results() -> None:
    result = {
        "results": [{"function_fqn": "example.ServiceImpl.query", "callType": "remote"}],
        "truncated": False,
        "total_count": 1,
    }

    assert _assert_semantic_expected(result, _cross_app_expected(), "rpc_query") is True


def test_semantic_expected_rejects_empty_results() -> None:
    result = {"results": [], "truncated": False, "total_count": 0}

    with pytest.raises(AssertionError, match=r"result_count=0, expected >= 1"):
        _assert_semantic_expected(result, _cross_app_expected(), "rpc_query")


def test_semantic_expected_rejects_local_fallback_results() -> None:
    result = {"results": [{"function_fqn": "example.Client.query", "callType": "local"}]}

    with pytest.raises(AssertionError, match=r"results\[0\]\.callType"):
        _assert_semantic_expected(result, _cross_app_expected(), "rpc_query")


def test_semantic_expected_leaves_snapshot_format_unchanged() -> None:
    snapshot = [{"function_fqn": "example.ServiceImpl.query"}]

    assert _assert_semantic_expected(snapshot, snapshot, "ordinary_case") is False


def test_semantic_expected_rejects_unknown_contract_fields() -> None:
    expected = {"$assertions": {"min_results": 1, "unsupported": True}}

    with pytest.raises(AssertionError, match="unsupported assertion keys"):
        _assert_semantic_expected([{"callType": "remote"}], expected, "rpc_query")


@pytest.mark.parametrize(
    ("assertions", "error"),
    [
        ({}, "must not be empty"),
        ({"max_results": 10}, "min_results is required"),
        ({"min_results": 0}, "min_results must be >= 1"),
    ],
)
def test_semantic_expected_cannot_silently_accept_empty_results(
    assertions: dict[str, object],
    error: str,
) -> None:
    with pytest.raises(AssertionError, match=error):
        _assert_semantic_expected([], {"$assertions": assertions}, "rpc_query")


@pytest.mark.parametrize(
    ("case_path_prefix", "expected_count"),
    [
        ("java/fchades", 6),
        ("java/hrcareersweb", 9),
        ("java/newzdataconsole", 1),
    ],
)
def test_new_cross_app_cases_are_collected_with_marker(
    case_path_prefix: str,
    expected_count: int,
) -> None:
    """确保普通回归的 ``-m 'not cross_app'`` 不会误收这 16 条外部用例。"""
    params = _build_grouped_params(case_path_prefix, ["temp_cache"])

    assert len(params) == expected_count
    assert all(any(mark.name == "cross_app" for mark in param.marks) for param in params)
