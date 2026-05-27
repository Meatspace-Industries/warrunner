-- migrate:up
ALTER TABLE sandbox_sessions
    ADD COLUMN IF NOT EXISTS repo TEXT;

ALTER TABLE agent_runtime_assignments
    ADD COLUMN IF NOT EXISTS repo TEXT;

-- migrate:down
ALTER TABLE agent_runtime_assignments
    DROP COLUMN IF EXISTS repo;

ALTER TABLE sandbox_sessions
    DROP COLUMN IF EXISTS repo;
