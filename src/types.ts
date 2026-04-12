// ── Session modes ──────────────────────────────────────────────
// persistent: memories carry across all chat sessions for a character
// isolated:   fresh session, no memory from prior chats, writes to its own sandbox
// readonly:   can read the shared graph but won't write to it

export type SessionMode = "persistent" | "isolated" | "readonly";

// ── Graph node types ───────────────────────────────────────────

export interface CharacterNode {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  faction?: string;
  isPlayerCharacter: boolean;
  sourceCharacterCard?: string; // ST character card filename
}

export interface LocationNode {
  id: string;
  name: string;
  description: string;
  parentLocationId?: string;
}

export interface ItemNode {
  id: string;
  name: string;
  description: string;
}

export interface EventNode {
  id: string;
  summary: string;
  inWorldTimestamp?: string;
  realTimestamp: string; // ISO date from the ST message send_date
  importance: number; // 1-10
  sceneId: string;
}

export interface FactNode {
  id: string;
  content: string;
  category: string; // lore, secret, rule, etc.
}

export interface SceneNode {
  id: string;
  chatId: string; // ST chat file identifier
  characterName: string; // ST character card name
  sessionId: string; // for session scoping
  startMessageIndex: number;
  endMessageIndex: number;
  summary: string;
  realTimestamp: string;
}

export interface WorldStateNode {
  id: string;
  key: string; // e.g., "temple_barrier", "guild_alert_level"
  value: string;
  validFrom: string; // ISO timestamp or message index
  validUntil?: string; // null = still current
  sourceEventId?: string;
}

export type GraphNode =
  | ({ type: "character" } & CharacterNode)
  | ({ type: "location" } & LocationNode)
  | ({ type: "item" } & ItemNode)
  | ({ type: "event" } & EventNode)
  | ({ type: "fact" } & FactNode)
  | ({ type: "scene" } & SceneNode)
  | ({ type: "worldstate" } & WorldStateNode);

// ── Graph edge types ───────────────────────────────────────────

export interface EdgeBase {
  id: string;
  createdAt: string;
  updatedAt: string;
  sourceMessageId?: string;
  confidence: number; // 0.0 - 1.0
  sessionId: string; // which session created this edge
}

export interface KnowsEdge extends EdgeBase {
  type: "KNOWS";
  fromCharacterId: string;
  toNodeId: string; // fact or event
  toNodeType: "fact" | "event";
}

export interface FeelsAboutEdge extends EdgeBase {
  type: "FEELS_ABOUT";
  fromCharacterId: string;
  toCharacterId: string;
  sentiment: number; // -1.0 (hostile) to 1.0 (loving)
  descriptor: string; // e.g., "trusts", "fears", "attracted to"
  intensity: number; // 0.0 - 1.0
}

export interface ParticipatedInEdge extends EdgeBase {
  type: "PARTICIPATED_IN";
  fromCharacterId: string;
  toEventId: string;
}

export interface LocatedAtEdge extends EdgeBase {
  type: "LOCATED_AT";
  fromNodeId: string;
  fromNodeType: "character" | "item";
  toLocationId: string;
  isCurrent: boolean; // most recent known location
}

export interface CausedEdge extends EdgeBase {
  type: "CAUSED";
  fromEventId: string;
  toEventId: string;
}

export interface ContainsEdge extends EdgeBase {
  type: "CONTAINS";
  fromNodeId: string;
  fromNodeType: "location";
  toNodeId: string;
  toNodeType: "location" | "item";
}

export interface OwnsEdge extends EdgeBase {
  type: "OWNS";
  fromCharacterId: string;
  toItemId: string;
}

export interface WitnessedEdge extends EdgeBase {
  type: "WITNESSED";
  fromCharacterId: string;
  toEventId: string;
}

export interface OccurredAtEdge extends EdgeBase {
  type: "OCCURRED_AT";
  fromEventId: string;
  toLocationId: string;
}

export interface RelatesToEdge extends EdgeBase {
  type: "RELATES_TO";
  fromFactId: string;
  toFactId: string;
  description: string;
}

export type GraphEdge =
  | KnowsEdge
  | FeelsAboutEdge
  | ParticipatedInEdge
  | LocatedAtEdge
  | CausedEdge
  | ContainsEdge
  | OwnsEdge
  | WitnessedEdge
  | OccurredAtEdge
  | RelatesToEdge;

// ── Vector store ───────────────────────────────────────────────

export interface NarrativeChunk {
  id: string;
  text: string;
  embedding: number[];
  sceneId: string;
  characterIds: string[];
  sessionId: string;
  timestamp: string;
}

// ── Extraction pipeline output ─────────────────────────────────

export interface ExtractionResult {
  newEntities: GraphNode[];
  updatedRelationships: GraphEdge[];
  newEvents: EventNode[];
  knowledgeUpdates: KnowsEdge[];
  worldStateChanges: LocatedAtEdge[];
}

// ── ST chat file format ────────────────────────────────────────

export interface STChatMetadata {
  user_name: string;
  character_name: string;
  create_date: string;
  chat_metadata: {
    integrity: string;
    chat_id_hash: number;
    [key: string]: unknown;
  };
}

export interface STMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  send_date: string;
  mes: string;
  extra?: Record<string, unknown>;
  swipes?: string[];
  swipe_id?: number;
}

// ── Mind map data ──────────────────────────────────────────────

export interface MindMapNode {
  id: string;
  label: string;
  type: GraphNode["type"];
  avatar?: string; // base64 or URL for character card images
  metadata: Record<string, unknown>;
}

export interface MindMapEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdge["type"];
  label: string;
  sentiment?: number;
  intensity?: number;
}

export interface MindMapData {
  nodes: MindMapNode[];
  edges: MindMapEdge[];
}

export type MindMapScope =
  | { type: "global" } // cross-RP: all characters, all sessions
  | { type: "character"; characterName: string } // all sessions for one character
  | { type: "session"; sessionId: string } // one specific chat session
  | { type: "focus"; nodeId: string; depth: number }; // N-hop neighborhood
