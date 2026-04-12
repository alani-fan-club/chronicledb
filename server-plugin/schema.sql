-- ChronicleDB schema — PostgreSQL 17 + pgvector
-- No Apache AGE needed: graph stored as relational tables

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Node tables ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS characters (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    aliases     TEXT[] DEFAULT '{}',
    description TEXT DEFAULT '',
    faction     TEXT,
    first_seen  TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS locations (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    description     TEXT DEFAULT '',
    parent_location TEXT REFERENCES locations(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
    id            TEXT PRIMARY KEY,
    summary       TEXT NOT NULL,
    significance  INT DEFAULT 3,
    message_index INT,
    location_id   TEXT REFERENCES locations(id),
    chat_id       TEXT,
    timestamp     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS facts (
    id         TEXT PRIMARY KEY,
    content    TEXT NOT NULL,
    domain     TEXT DEFAULT 'other',
    confidence REAL DEFAULT 0.8,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS world_state (
    id         SERIAL PRIMARY KEY,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    reason     TEXT DEFAULT '',
    valid_from TIMESTAMPTZ DEFAULT NOW(),
    valid_until TIMESTAMPTZ,
    chat_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_world_state_current
    ON world_state (key) WHERE valid_until IS NULL;

-- ── Edge tables ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feels_about (
    id          SERIAL PRIMARY KEY,
    from_char   TEXT NOT NULL REFERENCES characters(id),
    to_char     TEXT NOT NULL REFERENCES characters(id),
    sentiment   REAL DEFAULT 0,
    intensity   REAL DEFAULT 0.5,
    description TEXT DEFAULT '',
    session_id  TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(from_char, to_char)
);

CREATE TABLE IF NOT EXISTS knows (
    id          SERIAL PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES characters(id),
    fact_id     TEXT NOT NULL REFERENCES facts(id),
    learned_at  TIMESTAMPTZ DEFAULT NOW(),
    source      TEXT DEFAULT 'witnessed',
    UNIQUE(character_id, fact_id)
);

CREATE TABLE IF NOT EXISTS participated_in (
    id           SERIAL PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES characters(id),
    event_id     TEXT NOT NULL REFERENCES events(id),
    role         TEXT DEFAULT 'participant',
    UNIQUE(character_id, event_id)
);

CREATE TABLE IF NOT EXISTS present_at (
    id           SERIAL PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES characters(id),
    location_id  TEXT NOT NULL REFERENCES locations(id),
    since        TIMESTAMPTZ DEFAULT NOW(),
    until_time   TIMESTAMPTZ,
    is_current   BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_present_at_current
    ON present_at (character_id) WHERE is_current = TRUE;

-- ── Vector table ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_embeddings (
    id              SERIAL PRIMARY KEY,
    chat_id         TEXT NOT NULL,
    node_type       TEXT NOT NULL,
    node_id         TEXT NOT NULL,
    content         TEXT NOT NULL,
    embedding       vector(768) NOT NULL,
    character_scope TEXT[] DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    message_index   INT
);

CREATE INDEX IF NOT EXISTS idx_embed_hnsw
    ON memory_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_embed_chat_type
    ON memory_embeddings (chat_id, node_type);

-- ── Session & config tables ────────────────────────────────────

CREATE TABLE IF NOT EXISTS chronicle_sessions (
    id             TEXT PRIMARY KEY,
    character_name TEXT NOT NULL,
    chat_id        TEXT NOT NULL,
    mode           TEXT NOT NULL DEFAULT 'persistent',
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS character_memory_config (
    character_name TEXT PRIMARY KEY,
    session_mode   TEXT NOT NULL DEFAULT 'persistent',
    selected_chats TEXT[] DEFAULT '{}',
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);
