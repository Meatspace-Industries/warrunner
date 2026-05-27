import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from api.api_keys import _SERVICE_API_KEYS
from api.final_delivery import should_dead_letter_failure
from api.workflow_engine import discover_workflow_handlers, list_registered_workflows


def test_discordbot_service_api_key_spec_is_registered() -> None:
    specs = {spec.env_var: spec for spec in _SERVICE_API_KEYS}

    discordbot = specs["DISCORDBOT_API_KEY"]
    assert discordbot.name == "service:discordbot"
    assert discordbot.scopes == ("agent",)


def test_discord_delivery_error_classes_dead_letter() -> None:
    assert should_dead_letter_failure(
        non_retryable=False,
        error_class="discord_not_found",
        attempt_count=1,
        max_attempts=50,
    )
    assert should_dead_letter_failure(
        non_retryable=False,
        error_class="missing_discord_delivery_target",
        attempt_count=1,
        max_attempts=50,
    )


def test_warrunner_overlay_discord_workflow_registers(monkeypatch) -> None:
    repo_root = Path(__file__).resolve().parents[3]
    monkeypatch.setenv("WORKFLOW_DIRS", str(repo_root / "meatspace/overlay/workflows"))
    discovered = discover_workflow_handlers()
    registered = {workflow["name"] for workflow in list_registered_workflows()}

    assert "discord_thread_turn" in discovered
    assert "discord_thread_turn" in registered


def _load_warrunner_discord_workflow():
    repo_root = Path(__file__).resolve().parents[3]
    module_path = repo_root / "meatspace/overlay/workflows/discord_thread_turn.py"
    module_name = f"_test_warrunner_discord_thread_turn_{id(module_path)}"
    spec = importlib.util.spec_from_file_location(
        module_name,
        module_path,
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _configure_repo_routing(monkeypatch) -> None:
    monkeypatch.setenv(
        "WARRUNNER_ALLOWED_GITHUB_REPOS",
        "Meatspace-Industries/dappios,Meatspace-Industries/dapp-backend",
    )
    monkeypatch.setenv(
        "WARRUNNER_GITHUB_REPO_ALIASES",
        "ios=Meatspace-Industries/dappios,backend=Meatspace-Industries/dapp-backend",
    )


def test_discord_workflow_extracts_repo_flag(monkeypatch) -> None:
    _configure_repo_routing(monkeypatch)
    workflow = _load_warrunner_discord_workflow()

    selection = workflow._extract_prompt_selection(
        [{"type": "text", "text": "--repo dappios fix profile loading"}],
    )

    assert selection.repo == "Meatspace-Industries/dappios"
    assert selection.parts == [
        {
            "type": "text",
            "text": "Target GitHub repository for this turn: Meatspace-Industries/dappios.",
        },
        {"type": "text", "text": "fix profile loading"},
    ]


def test_discord_workflow_marks_ambiguous_repo_mentions(monkeypatch) -> None:
    _configure_repo_routing(monkeypatch)
    workflow = _load_warrunner_discord_workflow()

    selection = workflow._extract_prompt_selection(
        [{"type": "text", "text": "make dappios and backend agree"}],
    )

    assert selection.repo is None
    assert selection.ambiguous_repos == (
        "Meatspace-Industries/dapp-backend",
        "Meatspace-Industries/dappios",
    )
    assert selection.parts[0]["text"].startswith(
        "Multiple configured GitHub repositories were mentioned"
    )


@pytest.mark.asyncio
async def test_discord_workflow_passes_selected_repo_to_agent_turn(monkeypatch) -> None:
    _configure_repo_routing(monkeypatch)
    workflow = _load_warrunner_discord_workflow()
    do_agent_turn = AsyncMock(return_value={"ok": True})

    with patch("api.workflow_engine.do_agent_turn", new=do_agent_turn):
        result = await workflow.handler(
            workflow.Input(
                thread_key="discord:guild:channel:thread",
                parts=[{"type": "text", "text": "fix dappios auth"}],
            ),
            SimpleNamespace(),
        )

    assert result == {"ok": True}
    assert do_agent_turn.await_args.kwargs["repo"] == "Meatspace-Industries/dappios"


@pytest.mark.asyncio
async def test_discord_workflow_releases_assignment_when_repo_is_selected(
    monkeypatch,
) -> None:
    _configure_repo_routing(monkeypatch)
    workflow = _load_warrunner_discord_workflow()
    do_agent_turn = AsyncMock(return_value={"ok": True})
    get_active_assignment = AsyncMock(
        return_value={"assignment_generation": 1, "repo": None},
    )
    release_assignment = AsyncMock(return_value={"ok": True, "released": True})
    pool = SimpleNamespace(execute=AsyncMock())
    ctx = SimpleNamespace(_pool=pool, run_id="run-1")

    with (
        patch("api.workflow_engine.do_agent_turn", new=do_agent_turn),
        patch("api.runtime_control.get_active_assignment", new=get_active_assignment),
        patch("api.runtime_control.release_assignment", new=release_assignment),
    ):
        await workflow.handler(
            workflow.Input(
                thread_key="discord:guild:channel:thread",
                message_id="discord:message",
                parts=[{"type": "text", "text": "fix dappios auth"}],
            ),
            ctx,
        )

    release_assignment.assert_awaited_once_with(
        pool,
        thread_key="discord:guild:channel:thread",
        release_id="repo-switch:discord:message",
        cancel_inflight=True,
        stop_runtime_background=True,
    )
    pool.execute.assert_awaited_once()
    assert do_agent_turn.await_args.kwargs["repo"] == "Meatspace-Industries/dappios"
