-- ChronicleDB initial schema
-- Requires: PostgreSQL 16+, pgvector extension, Apache AGE extension

-- ── Extensions ─────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;

-- Load AGE into search path
SET search_path = ag_catalog, "$user", public;

-- ── Create the graph ───────────────────────────────────────────
SELECT create_graph('chronicle');

-- ── Graph node labels ──────────────────────────────────────────
-- AGE creates these implicitly on first use, but we define them
-- explicitly so we can add property indexes.

SELECT create_vlabel('chronicle', 'Character');
SELECT create_vlabel('chronicle', 'Location');
SELECT create_vlabel('chronicle', 'Item');
SELECT create_vlabel('chronicle', 'Event');
SELECT create_vlabel('chronicle', 'Fact');
SELECT create_vlabel('chronicle', 'Scene');
SELECT create_vlabel('chronicle', 'WorldState');

-- ── Graph edge labels ──────────────────────────────────────────

SELECT create_elabel('chronicle', 'KNOWS');
SELECT create_elabel('chronicle', 'FEELS_ABOUT');
SELECT create_elabel('chronicle', 'PARTICIPATED_IN');
SELECT create_elabel('chronicle', 'LOCATED_AT');
SELECT create_elabel('chronicle', 'CAUSED');
SELECT create_elabel('chronicle', 'CONTAINS');
SELECT create_elabel('chronicle', 'OWNS');
SELECT create_elabel('chronicle', 'WITNESSED');
SELECT create_elabel('chronicle', 'OCCURRED_AT');
SELECT create_elabel('chronicle', 'RELATES_TO');

-- ── Relational tables (vector store + metadata) ────────────────

CREATE TABLE IF NOT EXISTS narrative_chunks (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    text          TEXT NOT NULL,
    embedding     vector(768),  -- gemini-embedding-2-preview @ outputDimensionality=768
    scene_id      TEXT NOT NULL,
    character_ids TEXT[] NOT NULL DEFAULT '{}',
    character_scope TEXT[] NOT NULL DEFAULT '{}', -- which characters "know" this chunk
    node_type     TEXT,           -- 'event', 'fact', 'relationship', 'world_state'
    node_id       TEXT,           -- AGE node id cross-reference
    session_id    TEXT NOT NULL,
    chat_id       TEXT NOT NULL,
    character_name TEXT NOT NULL,
    timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW index for fast approximate nearest neighbor search
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
    ON narrative_chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_chunks_session
    ON narrative_chunks (session_id);

CREATE INDEX IF NOT EXISTS idx_chunks_character
    ON narrative_chunks (character_name);

CREATE INDEX IF NOT EXISTS idx_chunks_chat
    ON narrative_chunks (chat_id);

-- ── Session tracking ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
    id             TEXT PRIMARY KEY,
    character_name TEXT NOT NULL,
    chat_id        TEXT NOT NULL,
    mode           TEXT NOT NULL DEFAULT 'persistent', -- persistent | isolated | readonly
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_character
    ON sessions (character_name);

-- ── Backfill progress tracking ─────────────────────────────────

CREATE TABLE IF NOT EXISTS backfill_progress (
    chat_file      TEXT PRIMARY KEY,
    character_name TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | error
    messages_total INT NOT NULL DEFAULT 0,
    messages_done  INT NOT NULL DEFAULT 0,
    error_message  TEXT,
    started_at     TIMESTAMPTZ,
    completed_at   TIMESTAMPTZ
);
