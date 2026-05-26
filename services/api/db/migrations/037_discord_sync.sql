-- migrate:up

CREATE TABLE IF NOT EXISTS discord_sync_channels (
    channel_id                    TEXT PRIMARY KEY,
    guild_id                      TEXT NOT NULL,
    parent_id                     TEXT NOT NULL DEFAULT '',
    channel_name                  TEXT NOT NULL DEFAULT '',
    channel_type                  INTEGER NOT NULL DEFAULT 0,
    is_category                   BOOLEAN NOT NULL DEFAULT FALSE,
    is_thread                     BOOLEAN NOT NULL DEFAULT FALSE,
    is_archived                   BOOLEAN NOT NULL DEFAULT FALSE,
    is_syncable                   BOOLEAN NOT NULL DEFAULT FALSE,
    exclusion_reason              TEXT NOT NULL DEFAULT '',
    permission_signature          TEXT NOT NULL DEFAULT '',
    category_permission_signature TEXT NOT NULL DEFAULT '',
    raw_payload                   JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discord_sync_channels_syncable
    ON discord_sync_channels (is_syncable, channel_name);

CREATE INDEX IF NOT EXISTS idx_discord_sync_channels_parent
    ON discord_sync_channels (parent_id);

CREATE TABLE IF NOT EXISTS discord_sync_users (
    user_id       TEXT PRIMARY KEY,
    username      TEXT NOT NULL DEFAULT '',
    global_name   TEXT NOT NULL DEFAULT '',
    display_name  TEXT NOT NULL DEFAULT '',
    is_bot        BOOLEAN NOT NULL DEFAULT FALSE,
    raw_payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discord_sync_users_display_name
    ON discord_sync_users (display_name);

CREATE TABLE IF NOT EXISTS discord_sync_runs (
    run_id             TEXT PRIMARY KEY,
    workflow_run_id    TEXT,
    mode               TEXT NOT NULL DEFAULT 'incremental',
    status             TEXT NOT NULL,
    channels_requested JSONB NOT NULL DEFAULT '[]'::jsonb,
    channels_synced    JSONB NOT NULL DEFAULT '[]'::jsonb,
    channels_skipped   JSONB NOT NULL DEFAULT '[]'::jsonb,
    channels_failed    JSONB NOT NULL DEFAULT '[]'::jsonb,
    messages_fetched   INTEGER NOT NULL DEFAULT 0,
    messages_upserted  INTEGER NOT NULL DEFAULT 0,
    threads_fetched    INTEGER NOT NULL DEFAULT 0,
    threads_upserted   INTEGER NOT NULL DEFAULT 0,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at        TIMESTAMPTZ,
    error_text         TEXT NOT NULL DEFAULT '',
    metadata           JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_discord_sync_runs_started
    ON discord_sync_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS discord_sync_messages (
    channel_id        TEXT NOT NULL REFERENCES discord_sync_channels(channel_id) ON DELETE CASCADE,
    message_id        TEXT NOT NULL,
    guild_id          TEXT NOT NULL DEFAULT '',
    parent_channel_id TEXT NOT NULL DEFAULT '',
    thread_id         TEXT,
    occurred_at       TIMESTAMPTZ,
    edited_at         TIMESTAMPTZ,
    is_thread_root    BOOLEAN NOT NULL DEFAULT FALSE,
    author_id         TEXT NOT NULL DEFAULT '',
    message_type      TEXT NOT NULL DEFAULT 'message',
    content           TEXT NOT NULL DEFAULT '',
    attachment_count  INTEGER NOT NULL DEFAULT 0,
    embed_count       INTEGER NOT NULL DEFAULT 0,
    mention_user_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_run_id     TEXT REFERENCES discord_sync_runs(run_id) ON DELETE SET NULL,
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_sync_messages_thread
    ON discord_sync_messages (thread_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_discord_sync_messages_occurred
    ON discord_sync_messages (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_discord_sync_messages_author
    ON discord_sync_messages (author_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_discord_sync_messages_text
    ON discord_sync_messages
    USING GIN (to_tsvector('english', coalesce(content, '')));

CREATE TABLE IF NOT EXISTS discord_sync_checkpoints (
    channel_id        TEXT PRIMARY KEY REFERENCES discord_sync_channels(channel_id) ON DELETE CASCADE,
    newest_message_id TEXT,
    last_run_id       TEXT REFERENCES discord_sync_runs(run_id) ON DELETE SET NULL,
    last_success_at   TIMESTAMPTZ,
    last_error        TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS discord_sync_backfill_jobs (
    job_id                 BIGSERIAL PRIMARY KEY,
    job_key                TEXT NOT NULL UNIQUE,
    job_type               TEXT NOT NULL,
    payload_version        INTEGER NOT NULL DEFAULT 1,
    channel_id             TEXT NOT NULL REFERENCES discord_sync_channels(channel_id) ON DELETE CASCADE,
    status                 TEXT NOT NULL DEFAULT 'pending',
    payload_json           JSONB NOT NULL DEFAULT '{}'::jsonb,
    priority               INTEGER NOT NULL DEFAULT 100,
    attempt_count          INTEGER NOT NULL DEFAULT 0,
    next_attempt_at        TIMESTAMPTZ,
    last_run_id            TEXT REFERENCES discord_sync_runs(run_id) ON DELETE SET NULL,
    last_enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_started_at        TIMESTAMPTZ,
    last_completed_at      TIMESTAMPTZ,
    last_error             TEXT NOT NULL DEFAULT '',
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discord_sync_backfill_jobs_status_priority
    ON discord_sync_backfill_jobs (status, next_attempt_at, priority, updated_at);

CREATE INDEX IF NOT EXISTS idx_discord_sync_backfill_jobs_channel_status
    ON discord_sync_backfill_jobs (channel_id, status);

-- migrate:down

DROP INDEX IF EXISTS idx_discord_sync_backfill_jobs_channel_status;
DROP INDEX IF EXISTS idx_discord_sync_backfill_jobs_status_priority;
DROP TABLE IF EXISTS discord_sync_backfill_jobs;
DROP TABLE IF EXISTS discord_sync_checkpoints;
DROP INDEX IF EXISTS idx_discord_sync_messages_text;
DROP INDEX IF EXISTS idx_discord_sync_messages_author;
DROP INDEX IF EXISTS idx_discord_sync_messages_occurred;
DROP INDEX IF EXISTS idx_discord_sync_messages_thread;
DROP TABLE IF EXISTS discord_sync_messages;
DROP INDEX IF EXISTS idx_discord_sync_runs_started;
DROP TABLE IF EXISTS discord_sync_runs;
DROP INDEX IF EXISTS idx_discord_sync_users_display_name;
DROP TABLE IF EXISTS discord_sync_users;
DROP INDEX IF EXISTS idx_discord_sync_channels_parent;
DROP INDEX IF EXISTS idx_discord_sync_channels_syncable;
DROP TABLE IF EXISTS discord_sync_channels;
