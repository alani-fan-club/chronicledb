import { loadConfig, getChatsPath } from "../config.js";
import {
  discoverChats,
  parseChatFile,
  batchMessages,
  getActiveMessageText,
} from "./chat-parser.js";
import { extractFromMessages, embed } from "../extraction/extractor.js";
import { withClient } from "../db/connection.js";
import { storeChunk } from "../db/vector.js";
import * as graph from "../db/graph.js";
import { randomUUID } from "crypto";
import type { ExtractionOutput } from "../extraction/parser.js";
import type { ChronicleConfig } from "../config.js";

interface BackfillProgress {
  total: number;
  done: number;
  errors: number;
  currentFile: string;
}

/**
 * Backfill the graph from existing SillyTavern chat history.
 * Processes all chat files, extracts memories, and builds the initial graph.
 */
export async function backfill(
  config: ChronicleConfig,
  opts: {
    onProgress?: (progress: BackfillProgress) => void;
    dryRun?: boolean;
    characterFilter?: string; // only process this character
  } = {},
): Promise<BackfillProgress> {
  const chatsDir = getChatsPath(config);
  const chatMap = discoverChats(chatsDir);

  // Count total files
  let totalFiles = 0;
  for (const [charName, data] of chatMap) {
    if (opts.characterFilter && charName !== opts.characterFilter) continue;
    totalFiles += data.files.length;
  }

  const progress: BackfillProgress = {
    total: totalFiles,
    done: 0,
    errors: 0,
    currentFile: "",
  };

  for (const [charName, data] of chatMap) {
    if (opts.characterFilter && charName !== opts.characterFilter) continue;

    for (const filePath of data.files) {
      progress.currentFile = filePath;
      opts.onProgress?.(progress);

      try {
        // Check if already processed (idempotent)
        const alreadyDone = await checkBackfillStatus(config, filePath);
        if (alreadyDone) {
          progress.done++;
          continue;
        }

        await markBackfillStatus(config, filePath, charName, "processing");

        const chat = parseChatFile(filePath);
        const batches = batchMessages(
          chat.messages,
          config.extraction.batchSize,
        );

        const sessionId = `backfill-${chat.chatId}`;

        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i];

          if (opts.dryRun) {
            console.log(
              `[DRY RUN] Would extract from ${batch.length} messages (batch ${i + 1}/${batches.length}) of ${charName}`,
            );
            continue;
          }

          // Extract structured data
          const extraction = await extractFromMessages(
            config,
            chat.characterName,
            chat.userName,
            batch,
          );

          // Ingest into graph
          await ingestExtraction(config, extraction, sessionId, chat.chatId);

          // Generate and store embedding for this batch
          const batchText = batch
            .map((m) => `${m.name}: ${getActiveMessageText(m)}`)
            .join("\n")
            .slice(0, 8000); // cap embedding input

          const embedding = await embed(config, batchText);
          await storeChunk(config, {
            text: batchText.slice(0, 2000), // store truncated for display
            embedding,
            sceneId: `${chat.chatId}-batch-${i}`,
            characterIds: [chat.characterName],
            sessionId,
            timestamp: batch[0]?.send_date ?? new Date().toISOString(),
          });

          // Update progress within the file
          await updateBackfillProgress(
            config,
            filePath,
            chat.messages.length,
            Math.min((i + 1) * config.extraction.batchSize, chat.messages.length),
          );
        }

        await markBackfillStatus(config, filePath, charName, "done");
        progress.done++;
      } catch (err) {
        console.error(`[Backfill] Error processing ${filePath}:`, err);
        await markBackfillStatus(
          config,
          filePath,
          charName,
          "error",
          String(err),
        );
        progress.errors++;
        progress.done++;
      }

      opts.onProgress?.(progress);
    }
  }

  return progress;
}

/**
 * Ingest an extraction result into the graph.
 * Creates/updates nodes and edges based on extracted data.
 */
async function ingestExtraction(
  config: ChronicleConfig,
  extraction: ExtractionOutput,
  sessionId: string,
  chatId: string,
): Promise<void> {
  // Upsert characters
  for (const char of extraction.characters) {
    await graph.upsertCharacter(config, {
      id: `char-${slugify(char.name)}`,
      name: char.name,
      aliases: char.aliases,
      description: char.description,
      faction: char.faction ?? undefined,
      isPlayerCharacter: char.isPlayerCharacter,
    });
  }

  // Upsert locations
  for (const loc of extraction.locations) {
    await graph.upsertLocation(config, {
      id: `loc-${slugify(loc.name)}`,
      name: loc.name,
      description: loc.description,
      parentLocationId: loc.parentLocation
        ? `loc-${slugify(loc.parentLocation)}`
        : undefined,
    });
  }

  // Upsert items
  for (const item of extraction.items) {
    await graph.upsertItem(config, {
      id: `item-${slugify(item.name)}`,
      name: item.name,
      description: item.description,
    });
  }

  // Create events
  for (const event of extraction.events) {
    const eventId = `evt-${randomUUID().slice(0, 8)}`;
    await graph.upsertEvent(config, {
      id: eventId,
      summary: event.summary,
      inWorldTimestamp: event.inWorldTimestamp ?? undefined,
      realTimestamp: new Date().toISOString(),
      importance: event.importance,
      sceneId: chatId,
    });

    // Link participants
    for (const participant of event.participants) {
      await graph.createParticipatedIn(
        config,
        `char-${slugify(participant)}`,
        eventId,
        sessionId,
      );
    }

    // Link witnesses
    for (const witness of event.witnesses) {
      await graph.createWitnessed(
        config,
        `char-${slugify(witness)}`,
        eventId,
        sessionId,
      );
    }
  }

  // Upsert facts
  for (const fact of extraction.facts) {
    const factId = `fact-${randomUUID().slice(0, 8)}`;
    await graph.upsertFact(config, {
      id: factId,
      content: fact.content,
      category: fact.category,
    });
  }

  // Create relationship edges
  for (const rel of extraction.relationships) {
    await graph.createFeelsAbout(
      config,
      `char-${slugify(rel.from)}`,
      `char-${slugify(rel.to)}`,
      rel.descriptor,
      rel.sentiment,
      rel.intensity,
      sessionId,
    );
  }

  // Knowledge updates
  for (const ku of extraction.knowledgeUpdates) {
    const factId = `fact-${randomUUID().slice(0, 8)}`;
    await graph.upsertFact(config, {
      id: factId,
      content: ku.learned,
      category: "other",
    });
    await graph.createKnows(
      config,
      `char-${slugify(ku.character)}`,
      factId,
      "Fact",
      sessionId,
    );
  }

  // Location changes
  for (const lc of extraction.locationChanges) {
    const entityLabel = lc.entityType === "character" ? "Character" : "Item";
    const entityId =
      lc.entityType === "character"
        ? `char-${slugify(lc.entity)}`
        : `item-${slugify(lc.entity)}`;
    await graph.createLocatedAt(
      config,
      entityId,
      entityLabel as "Character" | "Item",
      `loc-${slugify(lc.to)}`,
      sessionId,
    );
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Backfill status tracking ───────────────────────────────────

async function checkBackfillStatus(
  config: ChronicleConfig,
  filePath: string,
): Promise<boolean> {
  return withClient(config, async (client) => {
    const { rows } = await client.query(
      `SELECT status FROM backfill_progress WHERE chat_file = $1`,
      [filePath],
    );
    return rows.length > 0 && rows[0].status === "done";
  });
}

async function markBackfillStatus(
  config: ChronicleConfig,
  filePath: string,
  characterName: string,
  status: string,
  errorMessage?: string,
): Promise<void> {
  return withClient(config, async (client) => {
    await client.query(
      `INSERT INTO backfill_progress (chat_file, character_name, status, error_message, started_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (chat_file) DO UPDATE
       SET status = $3, error_message = $4, started_at = NOW()`,
      [filePath, characterName, status, errorMessage ?? null],
    );
  });
}

async function updateBackfillProgress(
  config: ChronicleConfig,
  filePath: string,
  total: number,
  done: number,
): Promise<void> {
  return withClient(config, async (client) => {
    await client.query(
      `UPDATE backfill_progress
       SET messages_total = $2, messages_done = $3
       WHERE chat_file = $1`,
      [filePath, total, done],
    );
  });
}
