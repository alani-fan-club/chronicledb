import type { RetrievalResult } from "./retriever.js";

/**
 * Format retrieval results into a structured text block for prompt injection.
 * Designed to be model-agnostic and easy for any LLM to parse.
 */
export function formatMemoryBlock(
  result: RetrievalResult,
  maxTokens: number = 1500,
): string {
  const sections: string[] = [];

  // Current locations
  if (result.currentLocations.length > 0) {
    const lines = result.currentLocations
      .map((l) => `- ${l.entity}: ${l.location}`)
      .join("\n");
    sections.push(`## Current Scene\n${lines}`);
  }

  // Active relationships
  if (result.relationships.length > 0) {
    const lines = result.relationships
      .map((r) => {
        const sentLabel = sentimentLabel(r.sentiment);
        return `- ${r.from} → ${r.to}: ${r.descriptor} (${sentLabel}, intensity ${(r.intensity * 100).toFixed(0)}%)`;
      })
      .join("\n");
    sections.push(`## Active Relationships\n${lines}`);
  }

  // Recent events
  if (result.recentEvents.length > 0) {
    const lines = result.recentEvents
      .map(
        (e, i) =>
          `${i + 1}. ${e.summary} (participants: ${e.participants.join(", ")})`,
      )
      .join("\n");
    sections.push(`## Recent Events\n${lines}`);
  }

  // Knowledge boundaries
  if (result.knowledgeBoundaries.length > 0) {
    const lines = result.knowledgeBoundaries
      .map((kb) => {
        const parts: string[] = [];
        if (kb.knows.length > 0) {
          parts.push(`- ${kb.character} knows: ${kb.knows.join("; ")}`);
        }
        if (kb.doesNotKnow.length > 0) {
          parts.push(
            `- ${kb.character} does NOT know: ${kb.doesNotKnow.join("; ")}`,
          );
        }
        return parts.join("\n");
      })
      .join("\n");
    sections.push(`## Character Knowledge Boundaries\n${lines}`);
  }

  // World state
  if (result.worldState.length > 0) {
    const lines = result.worldState
      .map((ws) => `- ${ws.key}: ${ws.value}`)
      .join("\n");
    sections.push(`## World State\n${lines}`);
  }

  // Relevant past narrative (from vector search)
  if (result.relevantNarratives.length > 0) {
    const lines = result.relevantNarratives
      .map(
        (n) =>
          `- (${(n.similarity * 100).toFixed(0)}% match) ${n.text.slice(0, 200)}`,
      )
      .join("\n");
    sections.push(`## Relevant Past Context\n${lines}`);
  }

  const full = `[ChronicleDB — Active Memory]\n\n${sections.join("\n\n")}\n\n[/ChronicleDB]`;

  // Rough token estimate (1 token ≈ 4 chars) and trim if needed
  if (full.length > maxTokens * 4) {
    return trimToTokenBudget(full, maxTokens);
  }

  return full;
}

function sentimentLabel(sentiment: number): string {
  if (sentiment >= 0.7) return "very positive";
  if (sentiment >= 0.3) return "positive";
  if (sentiment >= -0.3) return "neutral";
  if (sentiment >= -0.7) return "negative";
  return "very negative";
}

/**
 * Trim the memory block to fit within a token budget.
 * Preserves sections in priority order: locations > relationships > knowledge > events > world > narrative
 */
function trimToTokenBudget(block: string, maxTokens: number): string {
  const charLimit = maxTokens * 4;
  const sections = block.split("\n\n## ");

  // Always keep the header
  let result = sections[0];

  for (let i = 1; i < sections.length; i++) {
    const candidate = result + "\n\n## " + sections[i];
    if (candidate.length > charLimit) break;
    result = candidate;
  }

  // Ensure closing tag
  if (!result.endsWith("[/ChronicleDB]")) {
    result += "\n\n[/ChronicleDB]";
  }

  return result;
}
