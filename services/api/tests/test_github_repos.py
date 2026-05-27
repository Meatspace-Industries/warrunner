from api.github_repos import (
    canonical_github_repo,
    configured_github_repo_aliases,
    configured_github_repo_list,
    resolve_github_repo_alias,
)


def test_canonical_github_repo_accepts_common_forms() -> None:
    assert (
        canonical_github_repo("https://github.com/Meatspace-Industries/dappios.git")
        == "Meatspace-Industries/dappios"
    )
    assert (
        canonical_github_repo("git@github.com:Meatspace-Industries/dapp-backend.git")
        == "Meatspace-Industries/dapp-backend"
    )


def test_configured_aliases_only_target_allowed_repos(monkeypatch) -> None:
    monkeypatch.setenv("WARRUNNER_ALLOWED_GITHUB_REPOS", "Meatspace-Industries/dappios")
    monkeypatch.setenv(
        "WARRUNNER_GITHUB_REPO_ALIASES",
        "ios=Meatspace-Industries/dappios,private=Meatspace-Industries/private",
    )

    aliases = configured_github_repo_aliases()

    assert resolve_github_repo_alias("ios", aliases) == "Meatspace-Industries/dappios"
    assert resolve_github_repo_alias("dappios", aliases) == "Meatspace-Industries/dappios"
    assert resolve_github_repo_alias("private", aliases) is None
    assert configured_github_repo_list(aliases) == ("Meatspace-Industries/dappios",)
