-- ChronicleDB schema — PostgreSQL 17 + pgvector
-- No Apache AGE needed: graph stored as relational tables

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Node tables ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS characters (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,
    aliases           TEXT[] DEFAULT '{}',
    description       TEXT DEFAULT '',
    faction           TEXT,
    role              TEXT DEFAULT '',
    status            TEXT DEFAULT 'active',
    significance      INT DEFAULT 3,
    first_seen        TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW(),
    summary_embedding vector(768)
);

-- Per-character rollup embedding: mean-pool of dispositional trait embeddings
-- for that character. Recomputed by recomputeCharacterSummary on trait
-- insert/delete and via the /recompute-character-summaries admin route.
-- Used for "find similar characters across chats" retrieval and cheap
-- character-archetype prefetch. HNSW-indexed for cosine kNN.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS summary_embedding vector(768);
CREATE INDEX IF NOT EXISTS idx_characters_summary_hnsw
    ON characters USING hnsw (summary_embedding vector_cosine_ops);

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
    id                TEXT PRIMARY KEY,
    summary           TEXT NOT NULL,
    source_text       TEXT DEFAULT '',
    significance      INT DEFAULT 3,
    message_index     INT,
    location_id       TEXT REFERENCES locations(id),
    chat_id           TEXT,
    timestamp         TIMESTAMPTZ DEFAULT NOW(),
    tier              TEXT DEFAULT 'recent',
    condensed_summary TEXT,
    is_major          BOOLEAN GENERATED ALWAYS AS (significance >= 4) STORED,
    embedding         vector(768)
);

CREATE INDEX IF NOT EXISTS idx_events_chat ON events (chat_id);

ALTER TABLE events ADD COLUMN IF NOT EXISTS source_text TEXT DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'recent';
ALTER TABLE events ADD COLUMN IF NOT EXISTS condensed_summary TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS embedding vector(768);

CREATE INDEX IF NOT EXISTS idx_events_source_tsv
    ON events USING GIN (to_tsvector('english', source_text));
CREATE INDEX IF NOT EXISTS idx_events_embed_hnsw
    ON events USING hnsw (embedding vector_cosine_ops);

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
    chat_id     TEXT,
    UNIQUE(character_id, fact_id)
);

ALTER TABLE knows ADD COLUMN IF NOT EXISTS chat_id TEXT;
CREATE INDEX IF NOT EXISTS idx_knows_fact ON knows (fact_id);
CREATE INDEX IF NOT EXISTS idx_knows_chat ON knows (chat_id);

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
    is_current   BOOLEAN DEFAULT TRUE,
    chat_id      TEXT
);

ALTER TABLE present_at ADD COLUMN IF NOT EXISTS chat_id TEXT;
CREATE INDEX IF NOT EXISTS idx_present_at_current
    ON present_at (character_id) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_present_at_chat ON present_at (chat_id);

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
    timestamp       TIMESTAMPTZ DEFAULT NOW(),
    embedding       vector(768)
);

ALTER TABLE context_snapshots ADD COLUMN IF NOT EXISTS embedding vector(768);

CREATE INDEX IF NOT EXISTS idx_ctx_chat
    ON context_snapshots (chat_id, message_index);
CREATE INDEX IF NOT EXISTS idx_ctx_embed_hnsw
    ON context_snapshots USING hnsw (embedding vector_cosine_ops);

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
    source          TEXT DEFAULT 'llm',     -- llm | structural (RESEARCH_ARCS Path 1)
    parent_arc_id   TEXT REFERENCES story_arcs(id) ON DELETE SET NULL,
    hierarchy_level INT DEFAULT 1,          -- 0 = super-arc, 1 = arc, 2 = episode (RESEARCH_ARCS Path 5)
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Path 1 arc rebuild (RESEARCH_ARCS.md §5): distinguishes Leiden/Louvain-built
-- rows from legacy per-batch LLM rows. 'llm' is the default for backward
-- compatibility; rebuildArcsForChat inserts with 'structural'. The chat index
-- supports the post-ingest DELETE + INSERT cycle.
ALTER TABLE story_arcs ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'llm';
CREATE INDEX IF NOT EXISTS idx_story_arcs_chat ON story_arcs (chat_id);

-- Path 5 hierarchical arcs (RESEARCH_ARCS.md §5 Path 5): three-level Louvain
-- resolution sweep (γ=0.25 super-arcs, γ=0.5 arcs, γ=1.0 episodes). Existing
-- flat rows default to hierarchy_level=1 and parent_arc_id=NULL, which
-- preserves the Path 1 semantics exactly. Parent index speeds up child→parent
-- walks; (chat_id, hierarchy_level) speeds up "fetch all level-1 arcs for
-- this chat" which retrieval's fetchArcExpansion filters on.
ALTER TABLE story_arcs ADD COLUMN IF NOT EXISTS parent_arc_id TEXT REFERENCES story_arcs(id) ON DELETE SET NULL;
ALTER TABLE story_arcs ADD COLUMN IF NOT EXISTS hierarchy_level INT DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_story_arcs_parent ON story_arcs (parent_arc_id);
CREATE INDEX IF NOT EXISTS idx_story_arcs_level ON story_arcs (chat_id, hierarchy_level);

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
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    verified_at  TIMESTAMPTZ,
    embedding    vector(768),
    normalized_content TEXT GENERATED ALWAYS AS
      (regexp_replace(lower(content), '[^a-z0-9]', '', 'g')) STORED,
    stemmed_content TEXT GENERATED ALWAYS AS
      (strip(to_tsvector('english', content))::text) STORED
);

-- Case/punctuation variants (Awed / awed / Awe-struck / Awestruck) collapse
-- via normalized_content. Morphological variants (charmed / charming /
-- observant / observing) collapse via stemmed_content, which runs the
-- Postgres English stemmer. upsertTrait uses ON CONFLICT against the
-- normalized unique index and a pre-check against stemmed_content for
-- dedup on write.
ALTER TABLE traits ADD COLUMN IF NOT EXISTS normalized_content TEXT
  GENERATED ALWAYS AS (regexp_replace(lower(content), '[^a-z0-9]', '', 'g')) STORED;
ALTER TABLE traits ADD COLUMN IF NOT EXISTS stemmed_content TEXT
  GENERATED ALWAYS AS (strip(to_tsvector('english', content))::text) STORED;
-- Contextual-embedding column populated lazily by the extractor (Path 1).
-- Nullable; recomputeCharacterSummary skips rows where embedding IS NULL
-- when rolling up into characters.summary_embedding.
ALTER TABLE traits ADD COLUMN IF NOT EXISTS embedding vector(768);

-- Path 1: canonical-row dedup. `evidence_sentence` is the one-sentence
-- quote from the source batch that justifies the trait, used to make the
-- contextual embedding text. `canonical_id` points at the canonical row
-- when this row is a merged variant (NULL for canonical rows themselves);
-- `aliases` carries the raw content/evidence strings merged into this
-- canonical; `merged_count` is a cheap popularity signal.
ALTER TABLE traits ADD COLUMN IF NOT EXISTS evidence_sentence TEXT;
ALTER TABLE traits ADD COLUMN IF NOT EXISTS canonical_id TEXT REFERENCES traits(id) ON DELETE SET NULL;
ALTER TABLE traits ADD COLUMN IF NOT EXISTS aliases TEXT[] DEFAULT '{}';
ALTER TABLE traits ADD COLUMN IF NOT EXISTS merged_count INT DEFAULT 1;
-- Path 3: LLM verifier timestamp. Stamped every time the 0.80-0.88 band
-- verifier evaluates a candidate against this canonical, regardless of
-- the MERGE / KEEP_DISTINCT / REJECT_NEW outcome. Observability signal.
ALTER TABLE traits ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_traits_char ON traits (character_id);
CREATE INDEX IF NOT EXISTS idx_traits_cat ON traits (category);
CREATE INDEX IF NOT EXISTS idx_traits_stem
  ON traits (character_id, category, stemmed_content);
CREATE UNIQUE INDEX IF NOT EXISTS idx_traits_unique_norm
  ON traits (character_id, category, normalized_content);
-- Path 1 retrieval accelerators. idx_traits_canonical speeds up the
-- "get all merged variants of this canonical" and `WHERE canonical_id IS
-- NULL` user-visible filters. The HNSW index is intentionally PARTIAL on
-- `canonical_id IS NULL` — we only want to kNN-search canonical rows,
-- not merged aliases, so upsertTrait's kNN lookup must never return the
-- alias rows.
CREATE INDEX IF NOT EXISTS idx_traits_canonical
  ON traits (character_id, canonical_id);
CREATE INDEX IF NOT EXISTS idx_traits_embedding_hnsw
  ON traits USING hnsw (embedding vector_cosine_ops)
  WHERE canonical_id IS NULL;

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
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    chat_id      TEXT
);

ALTER TABLE items ADD COLUMN IF NOT EXISTS chat_id TEXT;
CREATE INDEX IF NOT EXISTS idx_items_owner ON items (owner_id);
CREATE INDEX IF NOT EXISTS idx_items_location ON items (location_id);
CREATE INDEX IF NOT EXISTS idx_items_chat ON items (chat_id);

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
    message_index   INT,
    raw_text        TEXT,
    tsv             tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

CREATE INDEX IF NOT EXISTS idx_embed_hnsw
    ON memory_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_embed_chat_type
    ON memory_embeddings (chat_id, node_type);

-- Ensure raw_text column exists on existing deployments
ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS raw_text TEXT;

-- Ensure tsvector lexical search column exists on existing deployments
ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX IF NOT EXISTS idx_embed_tsv ON memory_embeddings USING gin(tsv);

-- Contextual retrieval: LLM-generated situating blurb prepended at embed time
-- (Anthropic contextual-retrieval pattern). Nullable, no default.
ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS context_prefix TEXT;

-- ── Dialogue quotes (separate index for "what did X say" questions) ────

CREATE TABLE IF NOT EXISTS dialogue_quotes (
    id            TEXT PRIMARY KEY,
    chat_id       TEXT NOT NULL,
    session_id    TEXT,
    speaker       TEXT NOT NULL,
    quote         TEXT NOT NULL,
    message_index INTEGER,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dialogue_quotes_tsv
    ON dialogue_quotes USING GIN (to_tsvector('english', quote));
CREATE INDEX IF NOT EXISTS idx_dialogue_quotes_trgm
    ON dialogue_quotes USING GIN (quote gin_trgm_ops);

-- ── Session & config tables ────────────────────────────────────

CREATE TABLE IF NOT EXISTS character_memory_config (
    character_name TEXT PRIMARY KEY,
    session_mode   TEXT NOT NULL DEFAULT 'persistent',
    selected_chats TEXT[] DEFAULT '{}',
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);
