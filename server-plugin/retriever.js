/**
 * Hybrid graph+vector retrieval for ChronicleDB.
 * Queries AGE graph for structured data, pgvector for semantic similarity,
 * then merges and formats into a prompt injection block.
 */

const db = require("./db");
const { embed } = require("./extractor");

// HyDE query rewriting and Gemini cross-encoder reranking live in the eval
// client only — keeping ST-facing retrieval latency low matters more than the
// extra recall here.

const LEXICAL_STOP = new Set([
  "the", "and", "but", "for", "with", "this", "that", "these", "those",
  "what", "who", "when", "where", "why", "how", "which", "whose",
  "does", "did", "is", "are", "was", "were", "be", "been", "being",
  "him", "her", "his", "she", "they", "them", "their", "you", "your",
  "from", "into", "about", "over", "after", "before", "between",
  "say", "said", "says", "saying", "tell", "told", "telling",
  "one", "two", "three", "some", "any", "all", "more", "most",
]);

function buildOrTsquery(query) {
  if (!query) return null;
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !LEXICAL_STOP.has(t));
  if (terms.length === 0) return null;
  return [...new Set(terms)].join(" | ");
}

async function eventLexicalSearch(settings, chatIds, query, limit) {
  if (!chatIds || chatIds.length === 0) return [];
  const tsquery = buildOrTsquery(query);
  if (!tsquery) return [];
  const p = db.getPool(settings);
  const { rows } = await p.query(
    `SELECT e.id, e.source_text, e.message_index, e.timestamp,
            ts_rank(to_tsvector('english', e.source_text), to_tsquery('english', $1)) as rank
     FROM events e
     WHERE e.chat_id = ANY($2::text[])
       AND e.source_text IS NOT NULL
       AND to_tsvector('english', e.source_text) @@ to_tsquery('english', $1)
     ORDER BY rank DESC
     LIMIT $3`,
    [tsquery, chatIds, limit || 8],
  );
  return rows;
}

async function fetchArcExpansion(settings, eventIds) {
  const result = new Map();
  if (!eventIds || eventIds.length === 0) return result;
  const p = db.getPool(settings);
  const { rows } = await p.query(
    `SELECT
       ae_hit.event_id,
       sa.title AS arc_title,
       sa.description AS arc_description,
       sa.status AS arc_status,
       sa.importance AS arc_importance,
       ae_hit.position AS hit_position,
       ae_neighbor.position AS neighbor_position,
       e_neighbor.summary AS neighbor_summary,
       e_neighbor.source_text AS neighbor_source_text
     FROM arc_events ae_hit
     JOIN story_arcs sa ON sa.id = ae_hit.arc_id
     LEFT JOIN arc_events ae_neighbor
       ON ae_neighbor.arc_id = ae_hit.arc_id
       AND ae_neighbor.position IN (ae_hit.position - 1, ae_hit.position + 1)
     LEFT JOIN events e_neighbor ON e_neighbor.id = ae_neighbor.event_id
     WHERE ae_hit.event_id = ANY($1::text[])
     ORDER BY ae_hit.event_id, sa.importance DESC NULLS LAST, ae_neighbor.position`,
    [eventIds],
  );
  for (const r of rows) {
    let exp = result.get(r.event_id);
    if (!exp) {
      exp = {
        arcTitle: r.arc_title,
        arcDescription: r.arc_description || "",
        arcStatus: r.arc_status || "active",
        hitPosition: r.hit_position,
      };
      result.set(r.event_id, exp);
    }
    if (exp.arcTitle !== r.arc_title) continue;
    if (r.neighbor_position === r.hit_position - 1 && r.neighbor_summary) {
      exp.prev = { summary: r.neighbor_summary, sourceText: r.neighbor_source_text || "", position: r.neighbor_position };
    } else if (r.neighbor_position === r.hit_position + 1 && r.neighbor_summary) {
      exp.next = { summary: r.neighbor_summary, sourceText: r.neighbor_source_text || "", position: r.neighbor_position };
    }
  }
  return result;
}

async function getMaxMessageIndex(settings, chatIds) {
  if (!chatIds || chatIds.length === 0) return 0;
  const p = db.getPool(settings);
  const { rows } = await p.query(
    `SELECT GREATEST(
       COALESCE((SELECT max(message_index) FROM memory_embeddings WHERE chat_id = ANY($1::text[])), 0),
       COALESCE((SELECT max(message_index) FROM events WHERE chat_id = ANY($1::text[])), 0)
     ) AS m`,
    [chatIds],
  );
  return Number(rows[0]?.m || 0);
}

async function dialogueQuoteSearch(settings, chatIds, query, limit) {
  if (!chatIds || chatIds.length === 0) return [];
  const tsquery = buildOrTsquery(query);
  if (!tsquery) return [];
  const p = db.getPool(settings);
  const k = 60;
  const fetchSize = (limit || 8) * 3;
  const [tsRes, trgmRes] = await Promise.all([
    p.query(
      `SELECT id, speaker, quote, message_index,
              ts_rank(to_tsvector('english', quote), to_tsquery('english', $1)) as rank
       FROM dialogue_quotes
       WHERE chat_id = ANY($2::text[])
         AND to_tsvector('english', quote) @@ to_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $3`,
      [tsquery, chatIds, fetchSize],
    ),
    p.query(
      `SELECT id, speaker, quote, message_index,
              similarity(quote, $1) as rank
       FROM dialogue_quotes
       WHERE chat_id = ANY($2::text[])
         AND quote % $1
       ORDER BY rank DESC
       LIMIT $3`,
      [query, chatIds, fetchSize],
    ),
  ]);
  const scores = new Map();
  tsRes.rows.forEach((r, i) => {
    scores.set(r.id, { score: 1 / (k + i + 1), item: r });
  });
  trgmRes.rows.forEach((r, i) => {
    const s = 1 / (k + i + 1);
    if (scores.has(r.id)) scores.get(r.id).score += s;
    else scores.set(r.id, { score: s, item: r });
  });
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 8)
    .map((x) => x.item);
}

async function retrieve(settings, { chatId, activeCharacters, recentText, sessionMode, sessionId, selectedChats }) {
  // Compute the chat-id scope once and thread it through every helper.
  // - explicit selectedChats wins (per-character preference from the chat picker UI)
  // - otherwise default to the current chatId (always scope to the current chat)
  // Vector search keeps the same scope; passing null falls back to global only when
  // no chatId is available at all (e.g. ad-hoc tooling calls).
  const chatIds = (selectedChats && selectedChats.length > 0)
    ? selectedChats
    : (chatId ? [chatId] : null);
  const chatScope = chatIds; // vector search uses the same scope

  // Run all queries in parallel
  const [relationships, events, knowledge, worldState, vectorResults, locations, snapshots, plotThreads, eventHits, dialogueHits, maxMsgIdx] = await Promise.all([
    db.getRelationships(settings, activeCharacters, chatIds),
    db.getRecentEvents(settings, chatId, 5, chatIds),
    db.getKnowledgeBoundaries(settings, activeCharacters, chatIds),
    db.getWorldState(settings, chatIds),
    recentText ? semanticSearchScoped(settings, recentText, chatScope) : [],
    getLocations(settings, activeCharacters),
    db.getRecentSnapshots(settings, chatId, 2),
    db.getActivePlotThreads(settings, chatId),
    recentText ? eventLexicalSearch(settings, chatScope, recentText, 6) : [],
    recentText ? dialogueQuoteSearch(settings, chatScope, recentText, 6) : [],
    getMaxMessageIndex(settings, chatScope),
  ]);

  if (vectorResults && vectorResults.length > 0) {
    for (const v of vectorResults) {
      if (v.headline) v.raw_text = v.headline;
    }
  }

  // Recency reorder: newer events and dialogue quotes surface first when rank ties.
  // Same RECENCY_ALPHA as eval cdb-client so behavior is consistent across callers.
  const RECENCY_ALPHA = 0.003;
  const applyRecency = (rows) => {
    if (!rows || rows.length === 0 || maxMsgIdx <= 0) return rows;
    return rows
      .map((r) => {
        const recency = typeof r.message_index === "number"
          ? RECENCY_ALPHA * (r.message_index / maxMsgIdx)
          : 0;
        const base = typeof r.rank === "number" ? r.rank : 0;
        return { ...r, _recency_score: base + recency };
      })
      .sort((a, b) => b._recency_score - a._recency_score);
  };
  const rescoredEventHits = applyRecency(eventHits);
  const rescoredDialogueHits = applyRecency(dialogueHits);

  const arcEventIds = (rescoredEventHits || []).slice(0, 4).map((e) => e.id).filter(Boolean);
  const arcExpansion = await fetchArcExpansion(settings, arcEventIds);

  return {
    relationships,
    events,
    knowledge,
    worldState,
    vectorResults,
    locations,
    snapshots,
    plotThreads,
    eventHits: rescoredEventHits,
    dialogueHits: rescoredDialogueHits,
    arcExpansion,
  };
}

async function semanticSearchScoped(settings, text, chatIds) {
  // Hybrid retrieval: vector search for semantic similarity + lexical
  // full-text search for exact phrases/quotes, fused via RRF.
  // We still need the embedding (for vector) AND the raw query (for lexical).
  const embedding = await embed(settings, text);
  return db.hybridSearch(settings, {
    embedding,
    query: text,
    chatIds: (chatIds && chatIds.length > 0) ? chatIds : null,
    limit: 8,
  });
}

async function getLocations(settings, characters) {
  if (!characters || characters.length === 0) return [];
  const p = db.getPool(settings);
  const charIds = characters.map((n) => db.slugify(n));
  const { rows } = await p.query(
    `SELECT c.name as entity, l.name as location
     FROM present_at pa
     JOIN characters c ON c.id = pa.character_id
     JOIN locations l ON l.id = pa.location_id
     WHERE pa.character_id = ANY($1::text[]) AND pa.is_current = TRUE`,
    [charIds],
  );
  return rows;
}

/**
 * Format retrieval results into the injection block.
 */
function formatMemoryBlock(result, maxTokens = 1500) {
  const sections = [];

  // Ground-truth sections first so truncation at maxTokens*4 never eats
  // them. These reflect CURRENT state (present_at.is_current, world_state
  // where valid_until IS NULL, active plot threads).
  if (result.locations && result.locations.length > 0) {
    const lines = result.locations.map((l) => `- ${l.entity}: ${l.location}`).join("\n");
    sections.push(`## Current Scene\n${lines}`);
  }

  if (result.worldState && result.worldState.length > 0) {
    const lines = result.worldState.map((ws) => `- ${ws.key}: ${ws.value}`).join("\n");
    sections.push(`## World State\n${lines}`);
  }

  if (result.plotThreads && result.plotThreads.length > 0) {
    const lines = result.plotThreads.map((pt) => {
      const typeIcon = { pending: "⏳", foreshadowing: "🔮", unresolved: "❓" }[pt.thread_type] || "📌";
      return `- ${typeIcon} [${pt.thread_type}] ${pt.title}: ${pt.description}${pt.involved_chars?.length ? ` (involves: ${pt.involved_chars.join(", ")})` : ""}`;
    }).join("\n");
    sections.push(`## Active Plot Threads\n${lines}`);
  }

  if (result.vectorResults && result.vectorResults.length > 0) {
    const lines = result.vectorResults
      .slice(0, 3)
      .map((v) => {
        const text = v.raw_text || v.content || "";
        const prefix = typeof v.similarity === "number"
          ? `(${(v.similarity * 100).toFixed(0)}%) `
          : "";
        const ctx = v.context_prefix ? `${v.context_prefix}\n\n` : "";
        return `- ${prefix}${ctx}${text.slice(0, 2500)}`;
      })
      .join("\n");
    sections.push(`## Relevant Past Context\n${lines}`);
  }

  if (result.eventHits && result.eventHits.length > 0) {
    const lines = result.eventHits
      .slice(0, 4)
      .map((e) => {
        const turn = typeof e.message_index === "number" ? `[turn ${e.message_index}] ` : "";
        let out = `- ${turn}${(e.source_text || "").replace(/\s+/g, " ").slice(0, 2000)}`;
        const arc = result.arcExpansion && result.arcExpansion.get(e.id);
        if (arc) {
          const desc = arc.arcDescription ? ` — ${arc.arcDescription.slice(0, 200)}` : "";
          out += `\n  [arc: ${arc.arcTitle} (${arc.arcStatus})${desc}]`;
          if (arc.prev) out += `\n  [arc prev pos ${arc.prev.position}] ${arc.prev.summary.slice(0, 300)}`;
          if (arc.next) out += `\n  [arc next pos ${arc.next.position}] ${arc.next.summary.slice(0, 300)}`;
        }
        return out;
      })
      .join("\n");
    sections.push(`## Matched Event Passages\n${lines}`);
  }

  if (result.dialogueHits && result.dialogueHits.length > 0) {
    const lines = result.dialogueHits
      .slice(0, 4)
      .map((d) => {
        const turn = typeof d.message_index === "number" ? `[turn ${d.message_index}] ` : "";
        return `- ${turn}${d.speaker}: "${(d.quote || "").slice(0, 600)}"`;
      })
      .join("\n");
    sections.push(`## Matched Dialogue Quotes\n${lines}`);
  }

  // Narrative context: append-only views of recent history. Less critical
  // than current-state but still useful for chronological framing.
  if (result.snapshots && result.snapshots.length > 0) {
    const lines = result.snapshots.map((s) => {
      let line = `- ${s.summary}`;
      if (s.location_name) line += ` [at: ${s.location_name}]`;
      if (s.emotional_tone) line += ` (tone: ${s.emotional_tone})`;
      if (s.present_chars && s.present_chars.length > 0) line += ` — present: ${s.present_chars.join(", ")}`;
      return line;
    }).join("\n");
    sections.push(`## Scene Context\n${lines}`);
  }

  if (result.events && result.events.length > 0) {
    const lines = result.events.map((e, i) => {
      let line = `${i + 1}. [sig ${e.significance || "?"}/5] ${e.summary}`;
      if (e.source_text && e.source_text.trim().length > 0) {
        const quote = e.source_text.replace(/\s+/g, " ").slice(0, 200).trim();
        line += `\n   > "${quote}"`;
      }
      return line;
    }).join("\n");
    sections.push(`## Recent Events\n${lines}`);
  }

  if (result.knowledge && result.knowledge.length > 0) {
    const lines = result.knowledge.map((kb) => {
      const parts = [];
      if (kb.knows && kb.knows.length > 0) {
        parts.push(`- ${kb.character} knows: ${kb.knows.join("; ")}`);
      }
      if (kb.doesNotKnow && kb.doesNotKnow.length > 0) {
        parts.push(`- ${kb.character} does NOT know: ${kb.doesNotKnow.join("; ")}`);
      }
      return parts.join("\n");
    }).join("\n");
    sections.push(`## Character Knowledge Boundaries\n${lines}`);
  }

  // Bulky destructively-updated relationship snapshot goes last.
  if (result.relationships && result.relationships.length > 0) {
    const lines = result.relationships.map((r) => {
      const sent = typeof r.sentiment === "number" ? ` (${r.sentiment.toFixed(1)})` : "";
      return `- ${r.from} → ${r.to}: ${r.description || "unknown"}${sent}${r.intensity ? ` — intensity ${(r.intensity * 100).toFixed(0)}%` : ""}`;
    }).join("\n");
    sections.push(`## Active Relationships\n${lines}`);
  }

  const block = `[ChronicleDB Memory Context]\n\n${sections.join("\n\n")}\n\n[/ChronicleDB Memory Context]`;

  // Rough token budget (4 chars ≈ 1 token)
  if (block.length > maxTokens * 4) {
    return block.slice(0, maxTokens * 4) + "\n\n[/ChronicleDB Memory Context]";
  }
  return block;
}

module.exports = { retrieve, formatMemoryBlock };
