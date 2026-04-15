/**
 * TypeScript declarations for shared/retrieval-core.js.
 *
 * Types here are kept intentionally loose. The shared core is CJS and
 * needs to stay easy to call from both TypeScript ESM (eval) and CJS
 * (server-plugin). Most shapes are `any` because the row schemas are
 * defined by SQL, not TS interfaces, and tightening them would lock
 * the CJS side into a particular struct layout. The call sites that
 * care about row shapes already define their own interfaces.
 */

export const RRF_K: number;
export const RECENCY_ALPHA: number;
export const PER_KIND_CAPS: Record<string, number>;
export const RENDER_CAPS: Record<string, number>;
export const SECTION_LIMITS: Record<string, number>;
export const SECTION_REGISTRY: Array<{ name: string; build(result: any): string | null }>;

export function slugify(name: string): string;
export function normalizeChatIds(chatIds: string | string[] | null | undefined): string[] | null;
export function hitMessageIndex(item: any): number | null;
export function capPerKind(sorted: any[], caps: Record<string, number>, limit: number): any[];
export function sentimentLabel(s: number): string;

export function getMaxMessageIndex(pool: any, chatIds: string | string[] | null): Promise<number>;
export function vectorSearch(pool: any, chatIds: string | string[] | null, queryEmbedding: number[], limit?: number): Promise<any[]>;
export function lexicalSearch(pool: any, chatIds: string | string[] | null, query: string, limit?: number): Promise<any[]>;
export function eventVectorSearch(pool: any, chatIds: string | string[] | null, queryEmbedding: number[], limit?: number): Promise<any[]>;
export function eventLexicalSearch(pool: any, chatIds: string | string[] | null, query: string, limit?: number): Promise<any[]>;
export function snapshotVectorSearch(pool: any, chatIds: string | string[] | null, queryEmbedding: number[], limit?: number): Promise<any[]>;
export function dialogueQuoteSearch(pool: any, chatIds: string | string[] | null, query: string, limit?: number): Promise<any[]>;

export function fetchArcExpansion(pool: any, eventIds: string[]): Promise<Map<string, any>>;
export function fetchNeighborPadding(pool: any, chatIds: string | string[] | null, hits: any[]): Promise<Map<number, any>>;
export function detectMentionedCharacters(
  pool: any,
  chatIds: string | string[] | null,
  query: string,
  cache: { chatId: string | null; entries: any[]; expiresAt?: number } | null,
): Promise<string[]>;

export interface HybridSearchOptions {
  chatIds: string | string[] | null;
  embedding: number[];
  query: string;
  limit?: number;
  boostCharIds?: string[];
  /**
   * Optional per-consumer budget caps from retriever.js. When present,
   * its `events` / `dialogue` / `memory` / `snapshots` fields override
   * the default PER_KIND_CAPS for this call. Absent → legacy behavior.
   */
  budgets?: {
    events?: number;
    dialogue?: number;
    memory?: number;
    snapshots?: number;
    maxTokens?: number;
    profile?: string;
  } | null;
}
export function hybridSearch(pool: any, opts: HybridSearchOptions): Promise<any[]>;

export function getRelationships(pool: any, chatIds: string | string[] | null, characters: string[]): Promise<any[]>;
export function getRecentEvents(pool: any, chatIds: string | string[] | null, limit?: number): Promise<any[]>;
export function getKnowledgeBoundaries(pool: any, chatIds: string | string[] | null, characters: string[]): Promise<any[]>;
export function getWorldState(pool: any, chatIds: string | string[] | null): Promise<any[]>;
export function getPlotThreads(pool: any, chatIds: string | string[] | null): Promise<any[]>;
export function getRecentSnapshots(pool: any, chatIds: string | string[] | null, limit?: number): Promise<any[]>;
export function getLocations(pool: any, chatIds: string | string[] | null, characters: string[]): Promise<any[]>;

export function formatMemoryBlock(result: any, maxChars: number): string;
