from __future__ import annotations

from typing import Any

import pytest

from api.github_app import (
    GitHubAppConfig,
    build_github_app_jwt,
    github_app_config_from_env,
    mint_github_app_installation_token,
    mint_github_app_installation_token_details,
)


def test_github_app_config_absent_when_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "CENTAUR_REQUIRE_GITHUB_APP_AUTH",
        "GITHUB_APP_ID",
        "GITHUB_APP_INSTALLATION_ID",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_APP_PRIVATE_KEY_BASE64",
        "GITHUB_APP_PRIVATE_KEY_PATH",
        "GITHUB_API_URL",
    ):
        monkeypatch.delenv(name, raising=False)

    assert github_app_config_from_env() is None


def test_github_app_config_required_rejects_absent_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "GITHUB_APP_ID",
        "GITHUB_APP_INSTALLATION_ID",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_APP_PRIVATE_KEY_BASE64",
        "GITHUB_APP_PRIVATE_KEY_PATH",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CENTAUR_REQUIRE_GITHUB_APP_AUTH", "1")

    with pytest.raises(ValueError, match="GitHub App auth is required"):
        github_app_config_from_env()


def test_github_app_config_accepts_escaped_private_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GITHUB_APP_ID", "3867134")
    monkeypatch.setenv("GITHUB_APP_INSTALLATION_ID", "12345")
    monkeypatch.setenv(
        "GITHUB_APP_PRIVATE_KEY",
        "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    )

    config = github_app_config_from_env()

    assert config == GitHubAppConfig(
        app_id="3867134",
        installation_id="12345",
        private_key="-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        api_url="https://api.github.com",
    )


def test_github_app_config_rejects_partial_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GITHUB_APP_ID", "3867134")
    monkeypatch.delenv("GITHUB_APP_INSTALLATION_ID", raising=False)
    monkeypatch.delenv("GITHUB_APP_PRIVATE_KEY", raising=False)
    monkeypatch.delenv("GITHUB_APP_PRIVATE_KEY_BASE64", raising=False)
    monkeypatch.delenv("GITHUB_APP_PRIVATE_KEY_PATH", raising=False)

    with pytest.raises(ValueError, match="GitHub App auth is partially configured"):
        github_app_config_from_env()


def test_build_github_app_jwt_uses_github_claim_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[dict[str, Any], str, str]] = []

    def fake_encode(payload: dict[str, Any], key: str, algorithm: str) -> str:
        calls.append((payload, key, algorithm))
        return "app.jwt"

    monkeypatch.setattr("api.github_app.jwt.encode", fake_encode)

    token = build_github_app_jwt(
        GitHubAppConfig(
            app_id="3867134",
            installation_id="12345",
            private_key="private-key",
        ),
        now=1_700_000_000,
    )

    assert token == "app.jwt"
    assert calls == [
        (
            {"iat": 1_699_999_940, "exp": 1_700_000_540, "iss": "3867134"},
            "private-key",
            "RS256",
        )
    ]


@pytest.mark.asyncio
async def test_mint_github_app_installation_token_posts_to_github(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    posts: list[tuple[str, dict[str, str], dict[str, Any]]] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {
                "token": "ghs_installation",
                "expires_at": "2026-05-27T08:30:00Z",
            }

    class FakeAsyncClient:
        def __init__(self, **_kwargs: Any) -> None:
            return None

        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def post(
            self,
            url: str,
            *,
            headers: dict[str, str],
            **kwargs: Any,
        ) -> FakeResponse:
            posts.append((url, headers, kwargs))
            return FakeResponse()

    monkeypatch.setattr("api.github_app.build_github_app_jwt", lambda _config: "app.jwt")
    monkeypatch.setattr("api.github_app.httpx.AsyncClient", FakeAsyncClient)

    token = await mint_github_app_installation_token(
        GitHubAppConfig(
            app_id="3867134",
            installation_id="12345",
            private_key="private-key",
        ),
        repository="Meatspace-Industries/dappios",
    )

    assert token == "ghs_installation"
    assert posts == [
        (
            "https://api.github.com/app/installations/12345/access_tokens",
            {
                "Accept": "application/vnd.github+json",
                "Authorization": "Bearer app.jwt",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            {"json": {"repositories": ["dappios"]}},
        )
    ]


@pytest.mark.asyncio
async def test_mint_github_app_installation_token_details_returns_expiry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {
                "token": "ghs_installation",
                "expires_at": "2026-05-27T08:30:00Z",
            }

    class FakeAsyncClient:
        def __init__(self, **_kwargs: Any) -> None:
            return None

        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def post(self, *_args: Any, **_kwargs: Any) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr("api.github_app.build_github_app_jwt", lambda _config: "app.jwt")
    monkeypatch.setattr("api.github_app.httpx.AsyncClient", FakeAsyncClient)

    details = await mint_github_app_installation_token_details(
        GitHubAppConfig(
            app_id="3867134",
            installation_id="12345",
            private_key="private-key",
        ),
        repository="Meatspace-Industries/dappios",
    )

    assert details is not None
    assert details.token == "ghs_installation"
    assert details.expires_at is not None
    assert details.expires_at.isoformat() == "2026-05-27T08:30:00+00:00"


@pytest.mark.asyncio
async def test_mint_github_app_installation_token_can_require_repo_scope() -> None:
    with pytest.raises(ValueError, match="requires a repository scope"):
        await mint_github_app_installation_token(
            GitHubAppConfig(
                app_id="3867134",
                installation_id="12345",
                private_key="private-key",
            ),
            require_repository=True,
        )
