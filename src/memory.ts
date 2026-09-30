import { readFileSync } from "node:fs";
import type { Db } from "./db.js";

// Memory is perfect in v1: nothing is ever updated or deleted. These rules live in data and can be
// tuned without touching code; the constants below are the fallback when the file is missing.
export interface MemoryRules {
  importance: Record<string, number>;
  defaultImportance: number;
  recall: {
    recencyWeight: number;
    importanceWeight: number;
    relevanceWeight: number;
    halfLifeTicks: number;
    promptMaxItems: number;
    promptMaxChars: number;
  };
}

export const DEFAULT_MEMORY_RULES: MemoryRules = {
  importance: { move: 1, wait: 1, appears: 4, examine: 3, talk: 6, talked: 7 },
  defaultImportance: 2,
  recall: {
    recencyWeight: 0.4,
    importanceWeight: 0.4,
    relevanceWeight: 0.2,
    halfLifeTicks: 50,
    promptMaxItems: 8,
    promptMaxChars: 1200,
  },
};

export function loadMemoryRules(dataDir: string): MemoryRules {
  const raw = JSON.parse(readFileSync(`${dataDir}/memory_rules.json`, "utf-8")) as Partial<MemoryRules>;
  return {
    importance: { ...DEFAULT_MEMORY_RULES.importance, ...(raw.importance ?? {}) },
    defaultImportance: raw.defaultImportance ?? DEFAULT_MEMORY_RULES.defaultImportance,
    recall: { ...DEFAULT_MEMORY_RULES.recall, ...(raw.recall ?? {}) },
  };
}

// A committed event as seen by the memory builder. Names resolves ids to display names so the text
// stays readable; witnesses is the set of characters that could see it.
export interface MemoryEvent {
  id: number;
  tick: number;
  zone_id: string;
  type: string;
  actor_id: string | null;
  x: number | null;
  y: number | null;
  data: Record<string, any>;
  names: Record<string, string>;
  witnesses: string[];
}

export interface NewMemory {
  character_id: string;
  event_id: number;
  tick: number;
  zone_id: string;
  text: string;
  importance: number;
  participants: string[];
}

export interface MemoryRow {
  id: number;
  character_id: string;
  event_id: number;
  tick: number;
  zone_id: string;
  text: string;
  importance: number;
  participants: string;
}

export interface MemoryQuery {
  characterId: string;
  tick: number;
  zoneId: string;
  presentCharacters: string[];
  keywords?: string[];
}

const DIR_WORD: Record<string, string> = { N: "north", S: "south", E: "east", W: "west" };

// One memory per witness, built from a template per event kind. No LLM call: the text is short and
// deterministic. "participants" is the characters directly involved (not every witness).
export function memoryFromEvent(
  event: MemoryEvent,
  witnessId: string,
  rules: MemoryRules = DEFAULT_MEMORY_RULES,
): NewMemory {
  const name = (id: string | null | undefined) => (id ? event.names[id] ?? id : "someone");
  const actor = name(event.actor_id);
  const participants = new Set<string>();
  if (event.actor_id) participants.add(event.actor_id);

  let text: string;
  switch (event.type) {
    case "move":
      text = `${actor} moved ${DIR_WORD[event.data.dir] ?? "somewhere"}.`;
      break;
    case "wait":
      text = `${actor} waited.`;
      break;
    case "talk": {
      const target = event.data.target as string | undefined;
      if (target) participants.add(target);
      text = `${actor} talked to ${name(target)}.`;
      break;
    }
    case "talked": {
      const target = event.data.target as string | undefined;
      if (target) participants.add(target);
      text = `${actor} talked with ${name(target)}.`;
      break;
    }
    case "examine":
      text = `${actor} examined ${name(event.data.target as string | undefined)}.`;
      break;
    case "appears":
      text = `${actor} came into view.`;
      break;
    default:
      text = event.actor_id ? `${actor} did something.` : "Something happened.";
  }

  return {
    character_id: witnessId,
    event_id: event.id,
    tick: event.tick,
    zone_id: event.zone_id,
    text,
    importance: rules.importance[event.type] ?? rules.defaultImportance,
    participants: [...participants],
  };
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function score(m: MemoryRow, query: MemoryQuery, rules: MemoryRules): number {
  const r = rules.recall;
  const recency = Math.pow(0.5, Math.max(0, query.tick - m.tick) / r.halfLifeTicks);
  const importance = m.importance / 10;
  let participants: string[] = [];
  try {
    participants = JSON.parse(m.participants) as string[];
  } catch {
    participants = [];
  }
  const sameZone = m.zone_id === query.zoneId ? 1 : 0;
  const shares = participants.some((id) => query.presentCharacters.includes(id)) ? 1 : 0;
  const keywords = query.keywords ?? [];
  const keywordMatch = keywords.length
    ? keywords.some((k) => m.text.toLowerCase().includes(k.toLowerCase())) ? 1 : 0
    : 0;
  const relevance = (sameZone + shares + keywordMatch) / 3;
  return r.recencyWeight * recency + r.importanceWeight * importance + r.relevanceWeight * relevance;
}

// Ranked best-first. Ties break by higher id, so the order is total and independent of float noise.
export function recall(
  db: Db,
  characterId: string,
  query: MemoryQuery,
  limit: number,
  rules: MemoryRules = DEFAULT_MEMORY_RULES,
): MemoryRow[] {
  const rows = db
    .prepare(
      `SELECT id, character_id, event_id, tick, zone_id, text, importance, participants
       FROM memories WHERE character_id = ?`,
    )
    .all(characterId) as MemoryRow[];
  return rows
    .map((m) => ({ m, s: round6(score(m, query, rules)) }))
    .sort((a, b) => b.s - a.s || b.m.id - a.m.id)
    .slice(0, Math.max(0, limit))
    .map((x) => x.m);
}
