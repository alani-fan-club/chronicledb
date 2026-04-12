/**
 * Lorebook (World Info) ingestion for ChronicleDB.
 * Parses ST lorebook JSON files and creates graph nodes + vector embeddings.
 */

const { readFileSync, readdirSync } = require("fs");
const { join, resolve, basename } = require("path");
const db = require("./db");

/**
 * List available lorebooks from the ST worlds directory.
 */
function listLorebooks(settings) {
  const dataRoot = settings.stDataRoot || "";
  const worldsDir = resolve(dataRoot, "worlds");

  try {
    return readdirSync(worldsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({
        filename: f,
        name: f.replace(".json", ""),
      }));
  } catch {
    return [];
  }
}

/**
 * Ingest a lorebook into the memory graph.
 *
 * Each lorebook entry becomes:
 * - A Fact node (with keywords from the entry's `key` array)
 * - A vector embedding of the content (for semantic retrieval)
 * - Optionally linked to Character/Location nodes if the entry
 *   looks like it describes one (heuristic based on keywords + comment)
 */
async function ingestLorebook(settings, filename, embedFn) {
  const dataRoot = settings.stDataRoot || "";
  const filePath = resolve(dataRoot, "worlds", filename);
  const raw = readFileSync(filePath, "utf-8");
  const lorebook = JSON.parse(raw);

  const entries = lorebook.entries || {};
  const lorebookName = filename.replace(".json", "");
  let ingested = 0;
  let skipped = 0;

  for (const [uid, entry] of Object.entries(entries)) {
    if (entry.disable) {
      skipped++;
      continue;
    }

    const content = entry.content || "";
    const comment = entry.comment || "";
    const keys = entry.key || [];

    if (!content.trim()) {
      skipped++;
      continue;
    }

    // Clean content: strip {{user}}/{{char}} template markers for graph storage
    const cleanContent = content
      .replace(/\{\{user\}\}/gi, "(user)")
      .replace(/\{\{char\}\}/gi, "(character)");

    const factId = `lore-${lorebookName}-${uid}`;

    // Create a Fact node with the lorebook entry
    await db.upsertFact(settings, {
      content: cleanContent.slice(0, 2000),
      domain: classifyEntry(comment, keys, cleanContent),
      confidence: 1.0, // lorebook entries are authoritative
      characterScope: [], // lore is global knowledge (available to all characters)
    });

    // If entry looks like a character description, also create a Character node
    const charMatch = detectCharacterEntry(comment, keys, cleanContent);
    if (charMatch) {
      await db.upsertCharacter(settings, {
        name: charMatch,
        aliases: keys.filter((k) => k.toLowerCase() !== charMatch.toLowerCase()),
        description: cleanContent.slice(0, 500),
        firstSeen: `lorebook:${lorebookName}`,
      });
    }

    // If entry looks like a location, create a Location node
    const locMatch = detectLocationEntry(comment, keys, cleanContent);
    if (locMatch) {
      await db.upsertLocation(settings, locMatch, cleanContent.slice(0, 500));
    }

    // Embed the content for vector search
    try {
      const embedding = await embedFn(settings, cleanContent.slice(0, 4000));
      await db.storeEmbedding(settings, {
        chatId: `lorebook:${lorebookName}`,
        nodeType: "lore",
        nodeId: factId,
        content: `[${comment || keys.join(", ")}] ${cleanContent.slice(0, 1000)}`,
        embedding,
        characterScope: [], // global lore
        messageIndex: null,
      });
    } catch (err) {
      console.warn(`[ChronicleDB] Failed to embed lore entry ${uid}:`, err.message);
    }

    ingested++;
  }

  return {
    lorebook: lorebookName,
    ingested,
    skipped,
    total: Object.keys(entries).length,
  };
}

/**
 * Classify a lorebook entry into a domain based on heuristics.
 */
function classifyEntry(comment, keys, content) {
  const text = `${comment} ${keys.join(" ")} ${content}`.toLowerCase();

  if (text.match(/\b(race|species|class|ability|magic|spell|skill)\b/)) return "lore";
  if (text.match(/\b(secret|hidden|unknown|forbidden|only .* knows)\b/)) return "secret";
  if (text.match(/\b(rule|law|custom|tradition|taboo|must|always|never)\b/)) return "rule";
  if (text.match(/\b(born|childhood|past|history|origin|backstory|used to)\b/)) return "backstory";
  if (text.match(/\b(city|town|village|forest|mountain|river|kingdom|realm|land)\b/)) return "lore";
  return "lore";
}

/**
 * Detect if a lorebook entry describes a character.
 * Returns the character name if detected, null otherwise.
 */
function detectCharacterEntry(comment, keys, content) {
  const text = content.toLowerCase();
  // Heuristic: if the comment looks like a name and content has character-like descriptors
  if (comment && text.match(/\b(he|she|they|his|her|their|personality|appearance|age|hair|eyes)\b/)) {
    // Use comment as name if it looks like one (not a generic description)
    if (comment.length < 40 && !comment.match(/^(the|a|an|about|info|note)/i)) {
      return comment;
    }
  }
  return null;
}

/**
 * Detect if a lorebook entry describes a location.
 * Returns the location name if detected, null otherwise.
 */
function detectLocationEntry(comment, keys, content) {
  const text = content.toLowerCase();
  if (text.match(/\b(located|situated|lies|stands|built|area|region|place|land|realm|city|town|village|forest|mountain|castle|tavern|temple)\b/)) {
    if (comment && comment.length < 40 && !comment.match(/^(the|a|an|about|info|note)/i)) {
      return comment;
    }
    // Try first keyword as location name
    const firstKey = keys[0];
    if (firstKey && firstKey.length < 40) {
      return firstKey;
    }
  }
  return null;
}

module.exports = { ingestLorebook, listLorebooks };
