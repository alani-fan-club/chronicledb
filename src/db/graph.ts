import type { ChronicleConfig } from "../config.js";
import type {
  CharacterNode,
  LocationNode,
  ItemNode,
  EventNode,
  FactNode,
  SceneNode,
  MindMapData,
  MindMapScope,
} from "../types.js";
import { cypher } from "./connection.js";

// ── Node CRUD ──────────────────────────────────────────────────

export async function upsertCharacter(
  config: ChronicleConfig,
  node: CharacterNode,
): Promise<void> {
  await cypher(config, `
    MERGE (c:Character {id: $id})
    SET c.name = $name,
        c.aliases = $aliases,
        c.description = $description,
        c.faction = $faction,
        c.is_player_character = $isPC,
        c.source_card = $sourceCard
  `, {
    id: node.id,
    name: node.name,
    aliases: JSON.stringify(node.aliases),
    description: node.description,
    faction: node.faction ?? "",
    isPC: node.isPlayerCharacter,
    sourceCard: node.sourceCharacterCard ?? "",
  });
}

export async function upsertLocation(
  config: ChronicleConfig,
  node: LocationNode,
): Promise<void> {
  await cypher(config, `
    MERGE (l:Location {id: $id})
    SET l.name = $name,
        l.description = $description,
        l.parent_location_id = $parentId
  `, {
    id: node.id,
    name: node.name,
    description: node.description,
    parentId: node.parentLocationId ?? "",
  });
}

export async function upsertItem(
  config: ChronicleConfig,
  node: ItemNode,
): Promise<void> {
  await cypher(config, `
    MERGE (i:Item {id: $id})
    SET i.name = $name,
        i.description = $description
  `, {
    id: node.id,
    name: node.name,
    description: node.description,
  });
}

export async function upsertEvent(
  config: ChronicleConfig,
  node: EventNode,
): Promise<void> {
  await cypher(config, `
    MERGE (e:Event {id: $id})
    SET e.summary = $summary,
        e.in_world_timestamp = $inWorldTs,
        e.real_timestamp = $realTs,
        e.importance = $importance,
        e.scene_id = $sceneId
  `, {
    id: node.id,
    summary: node.summary,
    inWorldTs: node.inWorldTimestamp ?? "",
    realTs: node.realTimestamp,
    importance: node.importance,
    sceneId: node.sceneId,
  });
}

export async function upsertFact(
  config: ChronicleConfig,
  node: FactNode,
): Promise<void> {
  await cypher(config, `
    MERGE (f:Fact {id: $id})
    SET f.content = $content,
        f.category = $category
  `, {
    id: node.id,
    content: node.content,
    category: node.category,
  });
}

export async function upsertScene(
  config: ChronicleConfig,
  node: SceneNode,
): Promise<void> {
  await cypher(config, `
    MERGE (s:Scene {id: $id})
    SET s.chat_id = $chatId,
        s.character_name = $characterName,
        s.session_id = $sessionId,
        s.start_msg_idx = $startIdx,
        s.end_msg_idx = $endIdx,
        s.summary = $summary,
        s.real_timestamp = $realTs
  `, {
    id: node.id,
    chatId: node.chatId,
    characterName: node.characterName,
    sessionId: node.sessionId,
    startIdx: node.startMessageIndex,
    endIdx: node.endMessageIndex,
    summary: node.summary,
    realTs: node.realTimestamp,
  });
}

// ── Edge creation ──────────────────────────────────────────────

export async function createFeelsAbout(
  config: ChronicleConfig,
  fromId: string,
  toId: string,
  descriptor: string,
  sentiment: number,
  intensity: number,
  sessionId: string,
): Promise<void> {
  await cypher(config, `
    MATCH (a:Character {id: $fromId}), (b:Character {id: $toId})
    MERGE (a)-[r:FEELS_ABOUT]->(b)
    SET r.descriptor = $descriptor,
        r.sentiment = $sentiment,
        r.intensity = $intensity,
        r.session_id = $sessionId,
        r.updated_at = $now
  `, {
    fromId,
    toId,
    descriptor,
    sentiment,
    intensity,
    sessionId,
    now: new Date().toISOString(),
  });
}

export async function createKnows(
  config: ChronicleConfig,
  characterId: string,
  targetId: string,
  targetLabel: "Fact" | "Event",
  sessionId: string,
): Promise<void> {
  await cypher(config, `
    MATCH (c:Character {id: $charId}), (t:${targetLabel} {id: $targetId})
    MERGE (c)-[r:KNOWS]->(t)
    SET r.session_id = $sessionId,
        r.updated_at = $now
  `, {
    charId: characterId,
    targetId,
    sessionId,
    now: new Date().toISOString(),
  });
}

export async function createLocatedAt(
  config: ChronicleConfig,
  entityId: string,
  entityLabel: "Character" | "Item",
  locationId: string,
  sessionId: string,
): Promise<void> {
  // Mark old LOCATED_AT edges as non-current
  await cypher(config, `
    MATCH (e:${entityLabel} {id: $entityId})-[r:LOCATED_AT]->(l:Location)
    SET r.is_current = false
  `, { entityId });

  // Create new current location
  await cypher(config, `
    MATCH (e:${entityLabel} {id: $entityId}), (l:Location {id: $locId})
    CREATE (e)-[r:LOCATED_AT {
      is_current: true,
      session_id: $sessionId,
      updated_at: $now
    }]->(l)
  `, {
    entityId,
    locId: locationId,
    sessionId,
    now: new Date().toISOString(),
  });
}

export async function createParticipatedIn(
  config: ChronicleConfig,
  characterId: string,
  eventId: string,
  sessionId: string,
): Promise<void> {
  await cypher(config, `
    MATCH (c:Character {id: $charId}), (e:Event {id: $eventId})
    MERGE (c)-[r:PARTICIPATED_IN]->(e)
    SET r.session_id = $sessionId,
        r.updated_at = $now
  `, {
    charId: characterId,
    eventId,
    sessionId,
    now: new Date().toISOString(),
  });
}

export async function createWitnessed(
  config: ChronicleConfig,
  characterId: string,
  eventId: string,
  sessionId: string,
): Promise<void> {
  await cypher(config, `
    MATCH (c:Character {id: $charId}), (e:Event {id: $eventId})
    MERGE (c)-[r:WITNESSED]->(e)
    SET r.session_id = $sessionId,
        r.updated_at = $now
  `, {
    charId: characterId,
    eventId,
    sessionId,
    now: new Date().toISOString(),
  });
}

// ── Mind map queries ───────────────────────────────────────────

export async function getMindMapData(
  config: ChronicleConfig,
  scope: MindMapScope,
): Promise<MindMapData> {
  const nodes: MindMapData["nodes"] = [];
  const edges: MindMapData["edges"] = [];

  switch (scope.type) {
    case "global": {
      // All characters and their relationships
      const chars = await cypher<{
        id: string;
        properties: Record<string, unknown>;
      }>(config, `MATCH (c:Character) RETURN c`);

      for (const c of chars) {
        nodes.push({
          id: String(c.id),
          label: String(c.properties?.name ?? ""),
          type: "character",
          metadata: c.properties ?? {},
        });
      }

      const rels = await cypher<{
        start_id: string;
        end_id: string;
        id: string;
        properties: Record<string, unknown>;
      }>(config, `
        MATCH (a:Character)-[r:FEELS_ABOUT]->(b:Character)
        RETURN a.id as start_id, b.id as end_id, id(r) as id, r
      `);

      for (const r of rels) {
        edges.push({
          id: String(r.id),
          source: String(r.start_id),
          target: String(r.end_id),
          type: "FEELS_ABOUT",
          label: String(r.properties?.descriptor ?? ""),
          sentiment: Number(r.properties?.sentiment ?? 0),
          intensity: Number(r.properties?.intensity ?? 0.5),
        });
      }
      break;
    }

    case "character": {
      // All nodes connected to a specific character across all sessions
      const connected = await cypher(config, `
        MATCH (c:Character {name: $name})-[r]-(n)
        RETURN c, r, n
      `, { name: scope.characterName });

      // Parse and deduplicate nodes/edges from results
      for (const row of connected) {
        const r = row as Record<string, unknown>;
        // AGE returns complex types — parse into our format
        if (r.n && typeof r.n === "object") {
          const n = r.n as Record<string, unknown>;
          nodes.push({
            id: String(n.id ?? ""),
            label: String(
              (n.properties as Record<string, unknown>)?.name ?? "",
            ),
            type: "character", // simplified; real impl inspects label
            metadata: (n.properties as Record<string, unknown>) ?? {},
          });
        }
      }
      break;
    }

    case "session": {
      // Only nodes/edges created in a specific session
      const sessionData = await cypher(config, `
        MATCH (a)-[r {session_id: $sid}]->(b)
        RETURN a, r, b
      `, { sid: scope.sessionId });

      for (const row of sessionData) {
        const r = row as Record<string, unknown>;
        if (r.a && typeof r.a === "object") {
          const a = r.a as Record<string, unknown>;
          nodes.push({
            id: String(a.id ?? ""),
            label: String(
              (a.properties as Record<string, unknown>)?.name ?? "",
            ),
            type: "character",
            metadata: (a.properties as Record<string, unknown>) ?? {},
          });
        }
      }
      break;
    }

    case "focus": {
      // N-hop neighborhood of a node
      const neighborhood = await cypher(config, `
        MATCH path = (start {id: $nodeId})-[*1..${scope.depth}]-(connected)
        RETURN path
      `, { nodeId: scope.nodeId });

      // Parse path results into nodes and edges
      for (const row of neighborhood) {
        // AGE path parsing — implementation depends on AGE version
        const r = row as Record<string, unknown>;
        if (r.path) {
          // Extract nodes and relationships from path
        }
      }
      break;
    }
  }

  // Deduplicate
  const seenNodes = new Set<string>();
  const dedupedNodes = nodes.filter((n) => {
    if (seenNodes.has(n.id)) return false;
    seenNodes.add(n.id);
    return true;
  });

  const seenEdges = new Set<string>();
  const dedupedEdges = edges.filter((e) => {
    if (seenEdges.has(e.id)) return false;
    seenEdges.add(e.id);
    return true;
  });

  return { nodes: dedupedNodes, edges: dedupedEdges };
}
