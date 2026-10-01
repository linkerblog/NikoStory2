import { readFileSync } from "node:fs";
import type { Db } from "./db.js";
import { extractJson, type LlmClient } from "./llm.js";

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
    case "arrives":
      text = event.data.impact === "hard"
        ? `${actor} crashed down from the sky.`
        : `${actor} dropped from the sky and landed.`;
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

// The lines a prompt shows for a recall query: highest-ranked survive the item and character budget,
// then the survivors are printed oldest-first so the model reads them chronologically.
export function recalledLines(db: Db, query: MemoryQuery, rules: MemoryRules = DEFAULT_MEMORY_RULES): string[] {
  const { promptMaxItems, promptMaxChars } = rules.recall;
  const line = (m: MemoryRow) => `t${m.tick}: ${m.text}`;
  const selected = recall(db, query.characterId, query, promptMaxItems, rules);
  while (
    selected.length > 0 &&
    (selected.length > promptMaxItems || selected.reduce((n, m) => n + line(m).length, 0) > promptMaxChars)
  ) {
    selected.pop();
  }
  return selected.sort((a, b) => a.tick - b.tick || a.id - b.id).map(line);
}

// One memory sentence for a specific witness of a specific event, written by the `memory` role.
export interface MemorySentence { event_id: number; character_id: string; text: string; importance: number }

export interface MemoryWriteContext {
  tick: number;
  zoneId: string;
  presentCharacters: string[];
  summary: string | null;
}

export interface SummaryInput {
  previous: string | null;
  events: string[];
  uptoTick: number;
  tick: number;
}

// The memory role: wording for the events where the exact words matter, and the rolling summary.
// It never writes to the database itself; the engine inserts what it returns, append-only.
export interface MemoryWriter {
  write(events: MemoryEvent[], ctx: MemoryWriteContext): Promise<MemorySentence[]>;
  summarize(input: SummaryInput): Promise<string | null>;
}

// Offline play writes no LLM text: the engine falls back to the deterministic template for every
// witness, so memory still works with no network and no cost.
export class OfflineMemories implements MemoryWriter {
  async write(): Promise<MemorySentence[]> { return []; }
  async summarize(): Promise<string | null> { return null; }
}

function memoryEventPayload(event: MemoryEvent) {
  const name = (id: string | null | undefined) => (id ? event.names[id] ?? id : null);
  return {
    event_id: event.id,
    type: event.type,
    actor: name(event.actor_id),
    target: name((event.data.target as string | undefined) ?? null),
    data: event.data,
    template: memoryFromEvent(event, event.witnesses[0] ?? "niko", DEFAULT_MEMORY_RULES).text,
    witnesses: event.witnesses.map((id) => ({ character_id: id, name: event.names[id] ?? id })),
  };
}

export const memoryPrompt = (language: string) =>
  `You write the memory one character keeps of an event they witnessed. Write in ${language}.
Rules:
- One short sentence per witness, first person is not used: "<name> ...", and only what that witness could perceive.
- Use only the given event_id and character_id values.
- importance is 1 (trivial) to 10 (life-changing).
Respond ONLY with JSON: {"memories":[{"event_id": number, "character_id": string, "text": string, "importance": number}]}.`;

export const summaryPrompt = (language: string) =>
  `You keep the running story summary of a game. Write in ${language}.
Rules:
- At most four short sentences: who Niko is with, what changed, what is unresolved.
- Do not invent facts; use only the previous summary and the events listed.
Respond ONLY with JSON: {"summary": string}.`;

export class OpenRouterMemories implements MemoryWriter {
  constructor(private llm: LlmClient) {}

  async write(events: MemoryEvent[], ctx: MemoryWriteContext): Promise<MemorySentence[]> {
    if (!events.length || this.llm.overBudget()) return [];
    const messages = [
      { role: "system", content: memoryPrompt(this.llm.language) },
      { role: "user", content: JSON.stringify({
        place: ctx.zoneId,
        story_so_far: ctx.summary,
        events: events.map(memoryEventPayload),
      }) },
    ];
    const res = await this.llm.chatRetry("memory", messages, { json: true, maxTokens: 4000, temperature: 0.4, tick: ctx.tick });
    const json = extractJson(res.content);
    if (!json || !Array.isArray(json.memories)) return [];
    const known = new Map(events.map((e) => [e.id, new Set(e.witnesses)]));
    const out: MemorySentence[] = [];
    for (const m of json.memories as any[]) {
      const eventId = Number(m?.event_id);
      const characterId = typeof m?.character_id === "string" ? m.character_id : "";
      const text = typeof m?.text === "string" ? m.text.trim() : "";
      const witnesses = known.get(eventId);
      if (!witnesses || !witnesses.has(characterId) || !text) continue;
      const importance = Math.max(1, Math.min(10, Math.round(Number(m?.importance) || 5)));
      out.push({ event_id: eventId, character_id: characterId, text, importance });
    }
    return out;
  }

  async summarize(input: SummaryInput): Promise<string | null> {
    if (this.llm.overBudget()) return null;
    const messages = [
      { role: "system", content: summaryPrompt(this.llm.language) },
      { role: "user", content: JSON.stringify({
        previous_summary: input.previous,
        events_since: input.events,
        from_tick: input.uptoTick,
        to_tick: input.tick,
      }) },
    ];
    try {
      const res = await this.llm.chatRetry("memory", messages, { json: true, maxTokens: 800, temperature: 0.3, tick: input.tick });
      const json = extractJson(res.content);
      const text = typeof json?.summary === "string" ? json.summary.trim() : "";
      return text || null;
    } catch (e) {
      console.warn("The summary call failed:", (e as Error).message);
      return null;
    }
  }
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
