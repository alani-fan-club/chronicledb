-- ChronicleDB schema — PostgreSQL 17 + pgvector
-- No Apache AGE needed: graph stored as relational tables

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Node tables ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS characters (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    aliases      TEXT[] DEFAULT '{}',
    description  TEXT DEFAULT '',
    faction      TEXT,
    role         TEXT DEFAULT '',
    status       TEXT DEFAULT 'active',
    significance INT DEFAULT 3,
    first_seen   TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS locations (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    description     TEXT DEFAULT '',
    importance      INT DEFAULT 3,
    current_state   TEXT DEFAULT '',
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

CREATE INDEX IF NOT EXISTS idx_events_chat        ON events (chat_id);

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
    UNIQUE(from_char, to_char, session_id)
);

CREATE INDEX IF NOT EXISTS idx_feels_about_session ON feels_about (session_id);

CREATE TABLE IF NOT EXISTS knows (
    id          SERIAL PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES characters(id),
    fact_id     TEXT NOT NULL REFERENCES facts(id),
    learned_at  TIMESTAMPTZ DEFAULT NOW(),
    source      TEXT DEFAULT 'witnessed',
    UNIQUE(character_id, fact_id)
);

CREATE INDEX IF NOT EXISTS idx_knows_fact         ON knows (fact_id);

CREATE TABLE IF NOT EXISTS participated_in (
    id           SERIAL PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES characters(id),
    event_id     TEXT NOT NULL REFERENCES events(id),
    role         TEXT DEFAULT 'participant',
    UNIQUE(character_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_participated_event ON participated_in (event_id);

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

-- ── Context snapshots (scene state at a point in time) ─────────

CREATE TABLE IF NOT EXISTS context_snapshots (
    id              TEXT PRIMARY KEY,
    chat_id         TEXT NOT NULL,
    message_index   INT NOT NULL,
    summary         TEXT NOT NULL,
    location_id     TEXT REFERENCES locations(id),
    present_chars   TEXT[] DEFAULT '{}',
    emotional_tone  TEXT DEFAULT '',
    world_state_snapshot JSONB DEFAULT '{}',
    timestamp       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ctx_chat
    ON context_snapshots (chat_id, message_index);

-- ── Plot threads (foreshadowing, pending events, unresolved arcs)

CREATE TABLE IF NOT EXISTS plot_threads (
    id              TEXT PRIMARY KEY,
    chat_id         TEXT NOT NULL,
    thread_type     TEXT NOT NULL DEFAULT 'pending',
    title           TEXT NOT NULL,
    description     TEXT DEFAULT '',
    involved_chars  TEXT[] DEFAULT '{}',
    planted_at      INT,
    resolved_at     INT,
    importance      INT DEFAULT 3,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plot_active
    ON plot_threads (chat_id) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS plot_thread_characters (
    plot_id      TEXT NOT NULL REFERENCES plot_threads(id) ON DELETE CASCADE,
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    PRIMARY KEY (plot_id, character_id)
);

-- ── Story arcs (manga-style narrative containers) ─────────────

CREATE TABLE IF NOT EXISTS story_arcs (
    id              TEXT PRIMARY KEY,
    chat_id         TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT DEFAULT '',
    arc_type        TEXT DEFAULT 'main',   -- main | subplot | character_arc | world_arc
    status          TEXT DEFAULT 'active', -- active | resolved | ongoing | abandoned
    importance      INT DEFAULT 3,          -- 1-5
    start_msg_idx   INT,
    end_msg_idx     INT,
    spine_event_id  TEXT,                   -- the defining event
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Arc membership: events can belong to multiple arcs
CREATE TABLE IF NOT EXISTS arc_events (
    arc_id      TEXT NOT NULL REFERENCES story_arcs(id) ON DELETE CASCADE,
    event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    position    INT DEFAULT 0,
    is_anchor   BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (arc_id, event_id)
);

-- Causal chains: event → event
CREATE TABLE IF NOT EXISTS event_chains (
    id              SERIAL PRIMARY KEY,
    from_event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    to_event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    chain_type      TEXT DEFAULT 'caused',  -- caused | followed_by | triggered | led_to
    description     TEXT DEFAULT '',
    UNIQUE(from_event_id, to_event_id)
);

CREATE INDEX IF NOT EXISTS idx_arc_events_arc ON arc_events (arc_id);
CREATE INDEX IF NOT EXISTS idx_event_chains_from ON event_chains (from_event_id);
CREATE INDEX IF NOT EXISTS idx_event_chains_to ON event_chains (to_event_id);

-- ── Character traits (innate properties, distinct from knows) ─

CREATE TABLE IF NOT EXISTS traits (
    id           TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    category     TEXT DEFAULT 'personality',
    content      TEXT NOT NULL,
    confidence   REAL DEFAULT 0.8,
    source_chat  TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_traits_char ON traits (character_id);
CREATE INDEX IF NOT EXISTS idx_traits_cat ON traits (category);

-- ── Items (key objects with owners, powers, significance) ──────

CREATE TABLE IF NOT EXISTS items (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    powers       TEXT DEFAULT '',
    significance INT DEFAULT 3,
    owner_id     TEXT REFERENCES characters(id),
    location_id  TEXT REFERENCES locations(id),
    status       TEXT DEFAULT 'intact',
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_items_owner        ON items (owner_id);
CREATE INDEX IF NOT EXISTS idx_items_location     ON items (location_id);

-- ── Ingestion status tracking ──────────────────────────────────

CREATE TABLE IF NOT EXISTS ingestion_status (
    chat_file      TEXT PRIMARY KEY,
    character_name TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    messages_total INT DEFAULT 0,
    batches_done   INT DEFAULT 0,
    ingested_at    TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

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
