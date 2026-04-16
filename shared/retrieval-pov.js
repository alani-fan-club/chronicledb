/**
 * POV epistemic mask helpers (AGARS known_nodes, derived view).
 *
 * These functions are pure policy transforms over a retrieval result.
 * The ST orchestrator computes the known-universe sets and calls
 * `applyPovFilter` post-retrieval.
 */

// What gets filtered and how:
//   - `result.events`: getRecentEvents projects summary/message_index but
//     not event id, so we filter by message_index (eventMessageIndexes).
//     Events at unwitnessed message_indexes are dropped. Events with
//     NULL message_index are kept — we can't prove the character didn't
//     witness them, and the permissive default matches the rest of the
//     retrieval pipeline which never filters on NULL indexes.
//   - `result.fusedHits` events: filter by eventIds (hybrid-fusion event
//     rows carry `id` from the underlying events table).
//   - `result.fusedHits` memory chunks: node_type drives the filter.
//     message/message_chunk → filter by message_index. event → filter
//     by eventIds. fact → filter by factIds. character → characterIds.
//     location → locationIds. item → itemIds. lore → always kept (world-
//     level narrator knowledge is not character-scoped).
//   - `result.fusedHits` dialogue: dialogue_quotes has no event_id column
//     (only speaker/quote/message_index/chat_id). The closest structural
//     proxy for "did the character witness this line" is
//     `message_index ∈ eventMessageIndexes` — if they witnessed something
//     at turn N, they heard the lines said at turn N. This is an
//     interpretation of the spec's "drop dialogue whose event_id isn't
//     in eventIds" given the schema reality.
//   - `result.fusedHits` snapshots: kept as-is (scene-summary is narrator-
//     level per spec).
//   - `result.neighborPadding`: Map<messageIndex, …>. Drop keys whose
//     message_index isn't in eventMessageIndexes. Neighbor padding is a
//     ±1 expansion around hits; a hit that survived the filter can still
//     have a neighbor the character didn't witness, so we must re-filter.
//   - `result.arcExpansion`: Map<eventId, …>. Drop keys whose event id
//     isn't in eventIds. Arc expansion surfaces cross-arc neighbors —
//     same reason as neighbor padding.
//   - `result.locations`, `result.knowledge`, `result.relationships`,
//     `result.worldState`, `result.plotThreads`, `result.snapshots` all
//     stay as-is: they're either already character-scoped upstream
//     (getLocations, getKnowledgeBoundaries, getRelationships), or are
//     narrator-level (worldState, snapshots), or are plot scaffolding
//     the narrator needs to reason about even if no single character
//     knows the whole thing (plotThreads).
function filterFusedHitsByPov(fusedHits, universe) {
  if (!Array.isArray(fusedHits) || fusedHits.length === 0) return [];
  const { eventIds, eventMessageIndexes, factIds, locationIds, itemIds, characterIds } = universe;
  const messageTypes = new Set(["message", "message_chunk"]);
  const kept = [];
  for (const h of fusedHits) {
    if (h.kind === "event") {
      const id = h.event && h.event.id;
      if (id && eventIds.has(id)) kept.push(h);
      continue;
    }
    if (h.kind === "dialogue") {
      const mi = h.dialogue && h.dialogue.message_index;
      if (typeof mi === "number" && eventMessageIndexes.has(mi)) kept.push(h);
      continue;
    }
    if (h.kind === "snapshot") {
      // Narrator-level; keep.
      kept.push(h);
      continue;
    }
    if (h.kind === "memory") {
      const m = h.memory || {};
      const nt = m.node_type;
      if (nt === "lore") {
        kept.push(h);
        continue;
      }
      if (messageTypes.has(nt)) {
        if (typeof m.message_index === "number" && eventMessageIndexes.has(m.message_index)) {
          kept.push(h);
        }
        continue;
      }
      if (nt === "event") {
        if (m.node_id && eventIds.has(m.node_id)) kept.push(h);
        continue;
      }
      if (nt === "fact") {
        if (m.node_id && factIds.has(m.node_id)) kept.push(h);
        continue;
      }
      if (nt === "character") {
        if (m.node_id && characterIds.has(m.node_id)) kept.push(h);
        continue;
      }
      if (nt === "location") {
        if (m.node_id && locationIds.has(m.node_id)) kept.push(h);
        continue;
      }
      if (nt === "item") {
        if (m.node_id && itemIds.has(m.node_id)) kept.push(h);
        continue;
      }
      // Unknown node_type: drop under POV. Better to under-expose than
      // leak memory chunks we can't reason about.
      continue;
    }
    // Unknown kind: drop under POV for the same reason.
  }
  return kept;
}

function applyPovFilter(result, universe) {
  const { eventIds, eventMessageIndexes } = universe;

  // -- result.events -- filter by message_index (no ids available) --
  if (Array.isArray(result.events)) {
    result.events = result.events.filter((e) => {
      if (typeof e.message_index !== "number") return true; // permissive: can't prove not witnessed
      return eventMessageIndexes.has(e.message_index);
    });
  }

  // -- fusedHits --
  if (Array.isArray(result.fusedHits)) {
    result.fusedHits = filterFusedHitsByPov(result.fusedHits, universe);
  }

  // Refresh the per-kind convenience views from the filtered fusedHits
  // so /retrieve consumers peeking at `vectorResults` / `eventHits` /
  // `dialogueHits` see the POV-masked view too. Recomputed here rather
  // than post-filtered separately so the views never drift from
  // fusedHits under the mask.
  if (Array.isArray(result.fusedHits)) {
    result.vectorResults = result.fusedHits
      .filter((h) => h.kind === "memory")
      .map((h) => h.memory);
    result.eventHits = result.fusedHits
      .filter((h) => h.kind === "event")
      .map((h) => h.event);
    result.dialogueHits = result.fusedHits
      .filter((h) => h.kind === "dialogue")
      .map((h) => h.dialogue);
  }

  // -- neighborPadding -- Map<messageIndex, row> --
  if (result.neighborPadding instanceof Map) {
    for (const key of [...result.neighborPadding.keys()]) {
      if (!eventMessageIndexes.has(key)) result.neighborPadding.delete(key);
    }
  }

  // -- arcExpansion -- Map<eventId, row> --
  if (result.arcExpansion instanceof Map) {
    for (const key of [...result.arcExpansion.keys()]) {
      if (!eventIds.has(key)) result.arcExpansion.delete(key);
    }
  }

  return result;
}

module.exports = {
  filterFusedHitsByPov,
  applyPovFilter,
};
