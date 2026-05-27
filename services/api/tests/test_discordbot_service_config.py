import importlib.util
import datetime as dt
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import uuid

import pytest

from api.api_keys import _SERVICE_API_KEYS
from api.final_delivery import should_dead_letter_failure
from api.workflow_engine import (
    WorkflowContext,
    _claim_run,
    _run_handler,
    create_workflow_run,
    discover_workflow_handlers,
    list_registered_workflows,
)


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
    assert "discord_reminder" in discovered
    assert "discord_thread_turn" in registered
    assert "discord_reminder" in registered


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


def _overlay_workflow_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "meatspace/overlay/workflows"


async def _clear_workflow_runtime_tables(db_pool) -> None:
    await db_pool.execute(
        "TRUNCATE TABLE workflow_events, workflow_schedules, workflow_checkpoints, "
        "workflow_runs, agent_execution_events, agent_execution_requests, "
        "agent_final_delivery_outbox CASCADE",
    )


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


def test_discord_reminder_request_parser_handles_common_shapes() -> None:
    workflow = _load_warrunner_discord_workflow()
    now = dt.datetime(2026, 5, 27, 12, 30, tzinfo=dt.timezone.utc)

    relative = workflow._extract_reminder_request(
        [{"type": "text", "text": "remind me in 4h plz"}],
        now=now,
    )
    assert relative.reminder_text == "you asked me to remind you"
    assert relative.delay_seconds == 4 * 60 * 60
    assert relative.due_at == now + dt.timedelta(hours=4)

    with_text = workflow._extract_reminder_request(
        [{"type": "text", "text": "please remind me in 10m to check the deploy please"}],
        now=now,
    )
    assert with_text.reminder_text == "check the deploy"
    assert with_text.delay_seconds == 10 * 60

    tomorrow = workflow._extract_reminder_request(
        [{"type": "text", "text": "remind me tomorrow to review metrics"}],
        now=now,
    )
    assert tomorrow.reminder_text == "review metrics"
    assert tomorrow.delay_seconds == 24 * 60 * 60
    assert tomorrow.due_at == now + dt.timedelta(days=1)

    absolute = workflow._extract_reminder_request(
        [{"type": "text", "text": "remind me at 2026-05-28 13:00 UTC to follow up"}],
        now=now,
    )
    assert absolute.reminder_text == "follow up"
    assert absolute.due_at == dt.datetime(2026, 5, 28, 13, 0, tzinfo=dt.timezone.utc)


def test_discord_reminder_request_parser_rejects_malformed_time() -> None:
    workflow = _load_warrunner_discord_workflow()

    with pytest.raises(Exception) as exc:
        workflow._extract_reminder_request(
            [{"type": "text", "text": "remind me later to check this"}],
            now=dt.datetime(2026, 5, 27, 12, 30, tzinfo=dt.timezone.utc),
        )

    assert getattr(exc.value, "code", "") == "UNSUPPORTED_REMINDER_TIME"


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
async def test_discord_workflow_schedules_reminder_without_agent_turn(
    db_pool,
    monkeypatch,
) -> None:
    await _clear_workflow_runtime_tables(db_pool)
    monkeypatch.setenv("WORKFLOW_DIRS", str(_overlay_workflow_dir()))
    discover_workflow_handlers()
    workflow = _load_warrunner_discord_workflow()
    run_id = f"wfr_{uuid.uuid4().hex[:16]}"
    thread_key = "discord:guild-1:forum-1:thread-1"
    delivery = {
        "platform": "discord",
        "guild_id": "guild-1",
        "channel_id": "thread-1",
        "thread_id": "thread-1",
        "message_id": "discord:guild-1:thread-1:source-msg-1",
        "recipient_user_id": "user-1",
    }
    await db_pool.execute(
        "INSERT INTO workflow_runs ("
        "run_id, workflow_name, workflow_version, request_hash, root_run_id, "
        "thread_key, status, input_json, worker_id"
        ") VALUES ($1, 'discord_thread_turn', 'test-v1', 'hash', $1, $2, "
        "'running', '{}'::jsonb, 'w1')",
        run_id,
        thread_key,
    )
    ctx = WorkflowContext(
        pool=db_pool,
        run_id=run_id,
        checkpoints={},
        lease_s=30.0,
        worker_id="w1",
    )
    do_agent_turn = AsyncMock(return_value={"ok": True})

    with patch("api.workflow_engine.do_agent_turn", new=do_agent_turn):
        result = await workflow.handler(
            workflow.Input(
                thread_key=thread_key,
                message_id="discord:guild-1:thread-1:source-msg-1",
                user_id="user-1",
                parts=[{"type": "text", "text": "remind me in 4h plz"}],
                delivery=delivery,
            ),
            ctx,
        )

    do_agent_turn.assert_not_awaited()
    assert result["kind"] == "discord_reminder_scheduled"
    assert result["delay_seconds"] == 4 * 60 * 60

    child = await db_pool.fetchrow(
        "SELECT workflow_name, status, input_json FROM workflow_runs "
        "WHERE parent_run_id = $1",
        run_id,
    )
    assert child is not None
    assert child["workflow_name"] == "discord_reminder"
    assert child["status"] == "queued"
    child_input = child["input_json"]
    if isinstance(child_input, str):
        child_input = json.loads(child_input)
    assert child_input["thread_key"] == thread_key
    assert child_input["delivery"] == delivery
    assert child_input["reminder_text"] == "you asked me to remind you"

    ack = await db_pool.fetchrow(
        "SELECT thread_key, delivery, state, final_payload "
        "FROM agent_final_delivery_outbox WHERE execution_id = $1",
        f"workflow:{run_id}:discord-reminder-ack",
    )
    assert ack is not None
    assert ack["thread_key"] == thread_key
    assert ack["state"] == "pending"
    ack_delivery = ack["delivery"]
    ack_payload = ack["final_payload"]
    if isinstance(ack_delivery, str):
        ack_delivery = json.loads(ack_delivery)
    if isinstance(ack_payload, str):
        ack_payload = json.loads(ack_payload)
    assert ack_delivery == delivery
    assert "Reminder queued for" in ack_payload["result_text"]


@pytest.mark.asyncio
async def test_discord_reminder_workflow_sleeps_resumes_and_enqueues_once(
    db_pool,
    monkeypatch,
) -> None:
    await _clear_workflow_runtime_tables(db_pool)
    monkeypatch.setenv("WORKFLOW_DIRS", str(_overlay_workflow_dir()))
    discover_workflow_handlers()
    run_id = None
    thread_key = "discord:guild-1:forum-1:thread-1"
    due_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)
    user_id = "123456789012345678"
    delivery = {
        "platform": "discord",
        "guild_id": "guild-1",
        "channel_id": "thread-1",
        "thread_id": "thread-1",
        "message_id": "discord:guild-1:thread-1:source-msg-1",
    }
    created = await create_workflow_run(
        db_pool,
        workflow_name="discord_reminder",
        trigger_key="reminder:test-once",
        eager_start=False,
        run_input={
            "thread_key": thread_key,
            "delivery": delivery,
            "message_id": "discord:guild-1:thread-1:source-msg-1",
            "user_id": user_id,
            "reminder_text": "check deploy",
            "due_at": due_at.isoformat(),
            "requested_delay_seconds": 1,
        },
    )
    run_id = created["run_id"]

    first = await _claim_run(db_pool)
    assert first is not None
    assert first["run_id"] == run_id
    await _run_handler(db_pool, first)

    sleeping = await db_pool.fetchrow(
        "SELECT status FROM workflow_runs WHERE run_id = $1",
        run_id,
    )
    assert sleeping["status"] == "sleeping"
    assert await db_pool.fetchval(
        "SELECT COUNT(*)::int FROM agent_final_delivery_outbox "
        "WHERE execution_id = $1",
        f"workflow:{run_id}:discord-reminder",
    ) == 0

    elapsed_due_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
    await db_pool.execute(
        "UPDATE workflow_checkpoints SET state = $2::jsonb "
        "WHERE run_id = $1 AND checkpoint_name = 'wait_until_due'",
        run_id,
        json.dumps(elapsed_due_at.isoformat()),
    )
    await db_pool.execute(
        "UPDATE workflow_runs SET available_at = NOW(), worker_id = NULL, "
        "worker_lease_expires_at = NULL WHERE run_id = $1",
        run_id,
    )
    second = await _claim_run(db_pool)
    assert second is not None
    assert second["run_id"] == run_id
    await _run_handler(db_pool, second)

    completed = await db_pool.fetchrow(
        "SELECT status, output_json FROM workflow_runs WHERE run_id = $1",
        run_id,
    )
    assert completed["status"] == "completed"
    outbox = await db_pool.fetchrow(
        "SELECT thread_key, delivery, state, final_payload FROM agent_final_delivery_outbox "
        "WHERE execution_id = $1",
        f"workflow:{run_id}:discord-reminder",
    )
    assert outbox is not None
    assert outbox["state"] == "pending"
    payload = outbox["final_payload"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    assert payload["result_text"] == f"<@{user_id}> Reminder: check deploy"
    assert payload["allowed_mention_user_ids"] == [user_id]

    await db_pool.execute(
        "UPDATE workflow_runs SET status = 'running', worker_id = 'w-replay', "
        "worker_lease_expires_at = NOW() + interval '30 seconds', completed_at = NULL "
        "WHERE run_id = $1",
        run_id,
    )
    await _run_handler(
        db_pool,
        {
            "run_id": run_id,
            "workflow_name": "discord_reminder",
            "input_json": json.dumps({
                "thread_key": thread_key,
                "delivery": delivery,
                "message_id": "discord:guild-1:thread-1:source-msg-1",
                "user_id": user_id,
                "reminder_text": "check deploy",
                "due_at": due_at.isoformat(),
            }),
            "status": "running",
            "worker_id": "w-replay",
        },
    )
    assert await db_pool.fetchval(
        "SELECT COUNT(*)::int FROM agent_final_delivery_outbox "
        "WHERE execution_id = $1",
        f"workflow:{run_id}:discord-reminder",
    ) == 1


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
