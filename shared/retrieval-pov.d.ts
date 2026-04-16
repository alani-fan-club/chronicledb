import type {
  ArcExpansionEntry,
  DialogueRow,
  EventRow,
  FusedHit,
  MemoryRow,
} from "./retrieval-core";

export interface PovUniverse {
  eventIds: Set<string>;
  eventMessageIndexes: Set<number>;
  factIds: Set<string>;
  locationIds: Set<string>;
  itemIds: Set<string>;
  characterIds: Set<string>;
}

export interface PovFilterableEvent {
  message_index?: number | null;
  [key: string]: unknown;
}

export interface PovFilterableResult {
  events?: PovFilterableEvent[];
  fusedHits?: FusedHit[];
  vectorResults?: MemoryRow[];
  eventHits?: EventRow[];
  dialogueHits?: DialogueRow[];
  neighborPadding?: Map<number, MemoryRow>;
  arcExpansion?: Map<string, ArcExpansionEntry>;
  [key: string]: unknown;
}

export function filterFusedHitsByPov(
  fusedHits: FusedHit[] | null | undefined,
  universe: PovUniverse,
): FusedHit[];

export function applyPovFilter<T extends PovFilterableResult>(
  result: T,
  universe: PovUniverse,
): T;
