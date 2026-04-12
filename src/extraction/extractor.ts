import OpenAI from "openai";
import PQueue from "p-queue";
import type { ChronicleConfig } from "../config.js";
import type { STMessage } from "../types.js";
import { buildExtractionPrompt } from "./prompts.js";
import { parseExtractionResponse, type ExtractionOutput } from "./parser.js";
import { getActiveMessageText } from "../backfill/chat-parser.js";

let llmClient: OpenAI | null = null;
let embeddingClient: OpenAI | null = null;

function getLLMClient(config: ChronicleConfig): OpenAI {
  if (!llmClient) {
    llmClient = new OpenAI({
      baseURL: config.extraction.endpoint,
      apiKey: "not-needed", // local models typically don't need keys
    });
  }
  return llmClient;
}

function getEmbeddingClient(config: ChronicleConfig): OpenAI {
  if (!embeddingClient) {
    // Ollama serves embeddings on the same endpoint
    embeddingClient = new OpenAI({
      baseURL: config.extraction.endpoint,
      apiKey: "not-needed",
    });
  }
  return embeddingClient;
}

/**
 * Extract structured memory data from a batch of RP messages.
 */
export async function extractFromMessages(
  config: ChronicleConfig,
  characterName: string,
  userName: string,
  messages: STMessage[],
): Promise<ExtractionOutput> {
  const client = getLLMClient(config);

  const formattedMessages = messages
    .filter((m) => !m.is_system)
    .map((m) => ({
      speaker: m.name,
      text: getActiveMessageText(m),
      isUser: m.is_user,
    }));

  if (formattedMessages.length === 0) {
    return {
      characters: [],
      relationships: [],
      events: [],
      locations: [],
      items: [],
      facts: [],
      knowledgeUpdates: [],
      locationChanges: [],
    };
  }

  const prompt = buildExtractionPrompt(
    characterName,
    userName,
    formattedMessages,
  );

  const response = await client.chat.completions.create({
    model: config.extraction.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1, // low temp for consistent extraction
    max_tokens: 4096,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned empty response for extraction");
  }

  return parseExtractionResponse(content);
}

/**
 * Generate an embedding vector for a text chunk.
 */
export async function embed(
  config: ChronicleConfig,
  text: string,
): Promise<number[]> {
  const client = getEmbeddingClient(config);

  const response = await client.embeddings.create({
    model: config.extraction.embeddingModel,
    input: text,
  });

  return response.data[0].embedding;
}

/**
 * Create a debounced extraction queue that processes messages
 * in batches without blocking RP generation.
 */
export function createExtractionQueue(config: ChronicleConfig) {
  const queue = new PQueue({ concurrency: 1 });
  let pendingMessages: STMessage[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let currentCharacter = "";
  let currentUser = "";

  function flush() {
    if (pendingMessages.length === 0) return;

    const batch = [...pendingMessages];
    const charName = currentCharacter;
    const uName = currentUser;
    pendingMessages = [];

    queue.add(async () => {
      try {
        const result = await extractFromMessages(
          config,
          charName,
          uName,
          batch,
        );
        return result;
      } catch (err) {
        console.error("[ChronicleDB] Extraction error:", err);
        return null;
      }
    });
  }

  return {
    /**
     * Enqueue a message for extraction. Messages are batched and
     * debounced to avoid hammering the LLM on rapid exchanges.
     */
    enqueue(
      message: STMessage,
      characterName: string,
      userName: string,
    ) {
      currentCharacter = characterName;
      currentUser = userName;
      pendingMessages.push(message);

      // Keep batching until batchSize or debounce fires
      if (pendingMessages.length >= config.extraction.batchSize) {
        if (debounceTimer) clearTimeout(debounceTimer);
        flush();
      } else {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flush, config.extraction.debounceMs);
      }
    },

    /** Force-process all pending messages immediately. */
    flush,

    /** Wait for all queued extractions to complete. */
    async drain() {
      flush();
      await queue.onIdle();
    },

    get pending() {
      return queue.pending + queue.size + pendingMessages.length;
    },
  };
}
