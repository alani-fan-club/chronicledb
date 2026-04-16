/**
 * TypeScript declarations for shared/retrieval-core.js.
 *
 * The shared core stays CJS and pool-parameterized, but this file now
 * exposes concrete row/hit/result interfaces so TS callers get stronger
 * contracts than `any` while preserving flexible optional fields.
 */

export type ChatIdsInput = string | string[] | null | undefined;

export interface QueryResult<T = unknown> {
  rows: T[];
}

export interface QueryablePool {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface PerKindCaps {
  memory: number;
  event: number;
  dialogue: number;
  snapshot: number;
  [kind: string]: number;
}

export interface SectionLimits {
  memoryBody: number;
  memoryNeighbor: number;
  eventBody: number;
  eventArcDesc: number;
  eventArcNeighbor: number;
  dialogueQuote: number;
  snapshotBody: number;
  sceneContextQuote: number;
  knowsTake: number;
  doesNotKnowTake: number;
  relationshipTake: number;
  relationshipDesc: number;
  [limitName: string]: number;
}

export interface MemoryRow {
  id: string;
  chat_id?: string;
  content?: string;
  raw_text?: string;
  context_prefix?: string | null;
  message_index?: number | null;
  node_type?: string | null;
  node_id?: string | null;
  similarity?: number;
  rank?: number;
  headline?: string;
}

export interface EventRow {
  id: string;
  source_text?: string;
  summary?: string;
  message_index?: number | null;
  timestamp?: Date | string | null;
  world_time?: string | null;
  session_id?: string | null;
  rank?: number;
}

export interface DialogueRow {
  id: string;
  speaker?: string | null;
  quote?: string | null;
  message_index?: number | null;
  rank?: number;
}

export interface SnapshotRow {
  id: string;
  summary?: string;
  message_index?: number | null;
  emotional_tone?: string | null;
  location_name?: string | null;
  present_chars?: string[] | null;
  similarity?: number;
}

export interface MemoryFusedHit {
  kind: "memory";
  key: string;
  memory: MemoryRow;
}

export interface EventFusedHit {
  kind: "event";
  key: string;
  event: EventRow;
}

export interface DialogueFusedHit {
  kind: "dialogue";
  key: string;
  dialogue: DialogueRow;
}

export interface SnapshotFusedHit {
  kind: "snapshot";
  key: string;
  snapshot: SnapshotRow;
}

export type FusedHit = MemoryFusedHit | EventFusedHit | DialogueFusedHit | SnapshotFusedHit;

export interface ScoredFusedHit {
  score: number;
  item: FusedHit;
}

export interface ArcExpansionEntry {
  arc_title?: string | null;
  arc_description?: string | null;
  arc_status?: string | null;
  arc_importance?: number | null;
  super_arc_title?: string | null;
  super_arc_description?: string | null;
  super_arc_status?: string | null;
  prev_event_summary?: string | null;
  prev_event_position?: number | null;
  next_event_summary?: string | null;
  next_event_position?: number | null;
}

export interface CharacterMentionEntry {
  id: string;
  needle: string;
}

export interface CharacterMentionCache {
  chatId: string | null;
  entries: CharacterMentionEntry[];
  expiresAt?: number;
}

export interface RetrievalBudgets {
  events?: number;
  dialogue?: number;
  memory?: number;
  snapshots?: number;
  maxTokens?: number;
  profile?: string;
}

export interface RelationshipRow {
  from_name?: string;
  to_name?: string;
  from?: string;
  to?: string;
  sentiment: number;
  intensity: number;
  description?: string | null;
}

export interface RecentEventRow {
  summary: string;
  source_text: string;
  significance: number;
  participants: string[];
  timestamp?: Date | string | null;
  message_index?: number | null;
  world_time?: string | null;
}

export interface KnowledgeBoundary {
  character?: string;
  knows: string[];
  doesNotKnow: string[];
}

export interface WorldStateRow {
  key: string;
  value: string;
  since?: Date | string | null;
}

export interface PlotThreadRow {
  title: string;
  description?: string;
  thread_type?: string;
  importance?: number;
  involved_chars?: string[];
}

export interface RecentSnapshotRow {
  summary?: string;
  location_name?: string | null;
  emotional_tone?: string | null;
  present_chars?: string[] | null;
}

export interface LocationRow {
  entity: string;
  location: string;
}

export interface RetrievalResult {
  relationships?: RelationshipRow[];
  events?: RecentEventRow[];
  knowledge?: KnowledgeBoundary[];
  worldState?: WorldStateRow[];
  plotThreads?: PlotThreadRow[];
  snapshots?: RecentSnapshotRow[];
  locations?: LocationRow[];
  fusedHits?: FusedHit[];
  vectorResults?: MemoryRow[];
  eventHits?: EventRow[];
  dialogueHits?: DialogueRow[];
  neighborPadding?: Map<number, MemoryRow>;
  arcExpansion?: Map<string, ArcExpansionEntry>;
  budgets?: RetrievalBudgets | null;
  [key: string]: unknown;
}

export interface SectionDescriptor {
  name: string;
  build(result: RetrievalResult): string | null;
}

export const RRF_K: number;
export const RECENCY_ALPHA: number;
export const PER_KIND_CAPS: PerKindCaps;
export const RENDER_CAPS: PerKindCaps;
export const SECTION_LIMITS: SectionLimits;
export const SECTION_REGISTRY: SectionDescriptor[];

export function slugify(name: string): string;
export function normalizeChatIds(chatIds: ChatIdsInput): string[] | null;
export function hitMessageIndex(item: FusedHit | { kind: string; [key: string]: unknown }): number | null;
export function capPerKind(sorted: ScoredFusedHit[], caps: Record<string, number>, limit: number): FusedHit[];
export function sentimentLabel(s: number): string;

export function getMaxMessageIndex(pool: QueryablePool, chatIds: ChatIdsInput): Promise<number>;
export function vectorSearch(pool: QueryablePool, chatIds: ChatIdsInput, queryEmbedding: number[], limit?: number): Promise<MemoryRow[]>;
export function lexicalSearch(pool: QueryablePool, chatIds: ChatIdsInput, query: string, limit?: number): Promise<MemoryRow[]>;
export function eventVectorSearch(pool: QueryablePool, chatIds: ChatIdsInput, queryEmbedding: number[], limit?: number): Promise<EventRow[]>;
export function eventLexicalSearch(pool: QueryablePool, chatIds: ChatIdsInput, query: string, limit?: number): Promise<EventRow[]>;
export function snapshotVectorSearch(pool: QueryablePool, chatIds: ChatIdsInput, queryEmbedding: number[], limit?: number): Promise<SnapshotRow[]>;
export function dialogueQuoteSearch(pool: QueryablePool, chatIds: ChatIdsInput, query: string, limit?: number): Promise<DialogueRow[]>;

export function fetchArcExpansion(pool: QueryablePool, eventIds: string[]): Promise<Map<string, ArcExpansionEntry>>;
export function fetchNeighborPadding(pool: QueryablePool, chatIds: ChatIdsInput, hits: FusedHit[]): Promise<Map<number, MemoryRow>>;
export function detectMentionedCharacters(
  pool: QueryablePool,
  chatIds: ChatIdsInput,
  query: string,
  cache: CharacterMentionCache | null,
): Promise<string[]>;

export interface HybridSearchOptions {
  chatIds: ChatIdsInput;
  embedding: number[];
  query: string;
  limit?: number;
  boostCharIds?: string[];
  budgets?: RetrievalBudgets | null;
}

export function hybridSearch(pool: QueryablePool, opts: HybridSearchOptions): Promise<FusedHit[]>;

export function getRelationships(pool: QueryablePool, chatIds: ChatIdsInput, characters: string[]): Promise<RelationshipRow[]>;
export function getRecentEvents(pool: QueryablePool, chatIds: ChatIdsInput, limit?: number): Promise<RecentEventRow[]>;
export function getKnowledgeBoundaries(pool: QueryablePool, chatIds: ChatIdsInput, characters: string[]): Promise<KnowledgeBoundary[]>;
export function getWorldState(pool: QueryablePool, chatIds: ChatIdsInput): Promise<WorldStateRow[]>;
export function getPlotThreads(pool: QueryablePool, chatIds: ChatIdsInput): Promise<PlotThreadRow[]>;
export function getRecentSnapshots(pool: QueryablePool, chatIds: ChatIdsInput, limit?: number): Promise<RecentSnapshotRow[]>;
export function getLocations(pool: QueryablePool, chatIds: ChatIdsInput, characters: string[]): Promise<LocationRow[]>;

export function formatMemoryBlock(result: RetrievalResult, maxChars: number): string;
