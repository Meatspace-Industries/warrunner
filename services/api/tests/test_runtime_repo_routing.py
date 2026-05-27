import pytest

import api.runtime_control as runtime_control
from api.runtime_control import (
    ControlPlaneError,
    _execution_hard_timeout_s,
    _resolve_requested_repo_scope,
)


def test_resolve_requested_repo_scope_accepts_configured_alias(monkeypatch) -> None:
    monkeypatch.setenv(
        "WARRUNNER_ALLOWED_GITHUB_REPOS",
        "Meatspace-Industries/dappios,Meatspace-Industries/dapp-backend",
    )
    monkeypatch.setenv(
        "WARRUNNER_GITHUB_REPO_ALIASES",
        "ios=Meatspace-Industries/dappios,backend=Meatspace-Industries/dapp-backend",
    )

    assert _resolve_requested_repo_scope("ios") == "Meatspace-Industries/dappios"
    assert (
        _resolve_requested_repo_scope("Meatspace-Industries/dapp-backend")
        == "Meatspace-Industries/dapp-backend"
    )


def test_resolve_requested_repo_scope_rejects_unconfigured_repo(monkeypatch) -> None:
    monkeypatch.setenv("WARRUNNER_ALLOWED_GITHUB_REPOS", "Meatspace-Industries/dappios")
    monkeypatch.delenv("WARRUNNER_GITHUB_REPO_ALIASES", raising=False)

    with pytest.raises(ControlPlaneError) as exc:
        _resolve_requested_repo_scope("Meatspace-Industries/private")

    assert exc.value.code == "REPO_NOT_ALLOWED"


def test_resolve_requested_repo_scope_requires_allowlist(monkeypatch) -> None:
    monkeypatch.delenv("WARRUNNER_ALLOWED_GITHUB_REPOS", raising=False)
    monkeypatch.delenv("WARRUNNER_GITHUB_REPO_ALIASES", raising=False)

    with pytest.raises(ControlPlaneError) as exc:
        _resolve_requested_repo_scope("Meatspace-Industries/dappios")

    assert exc.value.code == "REPO_ALLOWLIST_REQUIRED"


def test_repo_scoped_executions_are_clamped_below_github_token_lifetime(
    monkeypatch,
) -> None:
    monkeypatch.setattr(runtime_control, "EXECUTION_HARD_TIMEOUT_S", 3600)
    monkeypatch.setattr(runtime_control, "GITHUB_APP_REPO_EXECUTION_HARD_TIMEOUT_S", 2400)

    assert _execution_hard_timeout_s("Meatspace-Industries/dappios") == 2400
    assert _execution_hard_timeout_s(None) == 3600
