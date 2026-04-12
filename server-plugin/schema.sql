-- ChronicleDB schema for SillyTavern server plugin
-- Requires: PostgreSQL 16+, pgvector, Apache AGE

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;
SET search_path = ag_catalog, "$user", public;

-- ── Graph ──────────────────────────────────────────────────────
SELECT create_graph('chronicle');

-- Node labels
SELECT create_vlabel('chronicle', 'Character');
SELECT create_vlabel('chronicle', 'Location');
SELECT create_vlabel('chronicle', 'Event');
SELECT create_vlabel('chronicle', 'Fact');
SELECT create_vlabel('chronicle', 'WorldState');

-- Edge labels
SELECT create_elabel('chronicle', 'FEELS_ABOUT');
SELECT create_elabel('chronicle', 'KNOWS');
SELECT create_elabel('chronicle', 'WITNESSED');
SELECT create_elabel('chronicle', 'CAUSED');
SELECT create_elabel('chronicle', 'PRESENT_AT');
SELECT create_elabel('chronicle', 'RELATES_TO');
SELECT create_elabel('chronicle', 'OCCURRED_AT');
SELECT create_elabel('chronicle', 'OWNS');

-- ── Vector table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_embeddings (
    id              SERIAL PRIMARY KEY,
    chat_id         TEXT NOT NULL,
    node_type       TEXT NOT NULL,
    node_id         TEXT NOT NULL,
    content         TEXT NOT NULL,
    embedding       vector(768) NOT NULL,  -- gemini-embedding-2-preview @ dim=768
    character_scope TEXT[] DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    message_index   INT
);

CREATE INDEX IF NOT EXISTS idx_embed_hnsw
    ON memory_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_embed_chat_type
    ON memory_embeddings (chat_id, node_type);
CREATE INDEX IF NOT EXISTS idx_embed_chat_scope
    ON memory_embeddings (chat_id, character_scope);

-- ── Session tracking ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chronicle_sessions (
    id             TEXT PRIMARY KEY,
    character_name TEXT NOT NULL,
    chat_id        TEXT NOT NULL,
    mode           TEXT NOT NULL DEFAULT 'persistent',
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Per-character memory configuration
-- Stores which chats a character "remembers" and their session mode
CREATE TABLE IF NOT EXISTS character_memory_config (
    character_name TEXT PRIMARY KEY,
    session_mode   TEXT NOT NULL DEFAULT 'persistent',
    selected_chats TEXT[] DEFAULT '{}',  -- chat IDs this character remembers (empty = all)
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);
