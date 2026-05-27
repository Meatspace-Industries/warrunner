-- migrate:up
ALTER TABLE sandbox_sessions
    ADD COLUMN IF NOT EXISTS github_token_expires_at TIMESTAMPTZ;

-- migrate:down
ALTER TABLE sandbox_sessions
    DROP COLUMN IF EXISTS github_token_expires_at;
