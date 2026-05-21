from api.api_keys import _SERVICE_API_KEYS
from api.final_delivery import should_dead_letter_failure


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
