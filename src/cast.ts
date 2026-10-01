import { readFileSync } from "node:fs";
import { rngFor } from "./rng.js";
import { extractJson, type LlmClient } from "./llm.js";
import type { Agenda, AgendaKind, Point } from "./agenda.js";
import type { DeltaSink } from "./narrator.js";
import type { Scene } from "./stakes.js";
import type { WorldFacts, Zone } from "./world.js";

// A new game can replace the authored NPCs (`data/npcs.json`) with a generated cast. The pools and the
// roles live in `data/cast.json`: a role is a slot with its own agenda and the scene fact that agenda
// reveals, so a different person can fill it without touching the scene or the engine.
export interface Temperament { personality: string; voice: string }
export interface CastSlot {
  role: string;
  spawns: Point[];
  routine: { type: string; prob?: number };
  agenda: Agenda;
  fact: { id: string; text: string };
}
export interface Cast { names: string[]; temperaments: Temperament[]; slots: CastSlot[] }

export interface NpcSeed { id: string; name: string; x: number; y: number; data: Record<string, unknown> }
// `factTexts` overrides the wording of the scene facts that name a character, keyed by fact id.
export interface GeneratedCast { npcs: NpcSeed[]; factTexts: Record<string, string> }

const KINDS: ReadonlySet<string> = new Set<AgendaKind>(["approach", "follow", "visit"]);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const fill = (text: string, name: string) => text.replaceAll("{name}", name);

// A malformed cast is rejected on load, like the other data files: a slot whose fact the scene does not
// know, or a spawn inside a wall, would otherwise corrupt a new game only after the player pressed Start.
export function loadCast(dataDir: string, zone?: Zone, scene?: Scene): Cast {
  const raw = JSON.parse(readFileSync(`${dataDir}/cast.json`, "utf-8")) as Partial<Cast>;
  const slots = raw.slots ?? [];
  if (!Array.isArray(slots) || slots.length === 0) throw new Error("cast.json needs at least one slot");
  const names = raw.names ?? [];
  if (!Array.isArray(names) || !names.every(isText) || new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
    throw new Error("cast.json names must be distinct, non-empty strings");
  }
  if (names.some((n) => n.toLowerCase() === "niko")) throw new Error("cast.json names cannot reuse the protagonist's name");
  if (names.length < slots.length) throw new Error("cast.json has fewer names than slots");
  const temperaments = raw.temperaments ?? [];
  if (!Array.isArray(temperaments) || !temperaments.every((t) => isText(t?.personality) && isText(t?.voice))) {
    throw new Error("cast.json temperaments need a personality and a voice");
  }
  if (temperaments.length < slots.length) throw new Error("cast.json has fewer temperaments than slots");
  const factIds = new Set(scene?.facts.map((f) => f.id));
  for (const s of slots) {
    if (!isText(s?.role)) throw new Error("cast.json slot needs a role");
    if (!Array.isArray(s.spawns) || s.spawns.length === 0) throw new Error(`cast.json slot ${s.role} needs spawns`);
    for (const p of s.spawns) {
      if (!Number.isInteger(p?.x) || !Number.isInteger(p?.y)) throw new Error(`cast.json slot ${s.role} has a bad spawn`);
      if (zone && (zone.map[p.y]?.[p.x] !== "." || zone.objects.some((o) => o.blocks && o.x === p.x && o.y === p.y))) {
        throw new Error(`cast.json slot ${s.role} spawns on a blocked tile (${p.x},${p.y})`);
      }
    }
    const a = s.agenda;
    if (!isText(a?.goal_id) || !isText(a.want) || !KINDS.has(a.kind) || !isText(a.target)) {
      throw new Error(`cast.json slot ${s.role} needs a complete agenda`);
    }
    if (!isText(s.fact?.id) || !isText(s.fact.text)) throw new Error(`cast.json slot ${s.role} needs a fact id and text`);
    if (a.reveals !== s.fact.id) throw new Error(`cast.json slot ${s.role} reveals a fact other than its own`);
    if (scene && !factIds.has(s.fact.id)) throw new Error(`cast.json slot ${s.role} fact ${s.fact.id} is not in the scene`);
  }
  return { names, temperaments, slots };
}

// A draw without replacement, so no two characters of one cast share a name or a temperament.
function draw<T>(pool: readonly T[], count: number, rng: () => number): T[] {
  const left = [...pool];
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(left.splice(Math.floor(rng() * left.length), 1)[0]);
  return out;
}

const slug = (name: string) => name.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();

// Pure function of (cast, seed): the same seed always brings the same people, so a saved game replays.
export function generateCast(cast: Cast, seed: number): GeneratedCast {
  const rng = rngFor(seed, 0, "cast");
  const names = draw(cast.names, cast.slots.length, rng);
  const temperaments = draw(cast.temperaments, cast.slots.length, rng);
  const taken = new Set<string>();
  const factTexts: Record<string, string> = {};
  const npcs = cast.slots.map((slot, i): NpcSeed => {
    const free = slot.spawns.filter((p) => !taken.has(`${p.x},${p.y}`));
    if (!free.length) throw new Error(`cast.json slot ${slot.role} has no free spawn left`);
    const spawn = free[Math.floor(rng() * free.length)];
    taken.add(`${spawn.x},${spawn.y}`);
    const name = names[i];
    factTexts[slot.fact.id] = fill(slot.fact.text, name);
    return {
      id: slug(name) || `npc_${i}`, name, x: spawn.x, y: spawn.y,
      data: {
        personality: temperaments[i].personality,
        voice: temperaments[i].voice,
        routine: slot.routine,
        role: slot.role,
        agenda: { ...slot.agenda, want: fill(slot.agenda.want, name) },
      },
    };
  });
  return { npcs, factTexts };
}

// The `cast` role. The pool above gives every character a temperament; this optional role lets a model
// write a personality and a voice instead, from the character's name and what they came to do. Like
// every role it only proposes: the engine keeps what passes `parseCastDraft` and the pool temperament
// stands for everyone else, so a missing, failed or over-budget call never blocks a new game.
export interface Personality { personality: string; voice: string }
export interface CastBrief { id: string; name: string; role: string; goal: string }
export interface CastRequest { characters: CastBrief[]; world?: WorldFacts }
export interface CastWriter {
  write(req: CastRequest, onDelta?: DeltaSink): Promise<Record<string, Personality> | null>;
}

export const castBrief = (cast: GeneratedCast): CastBrief[] =>
  cast.npcs.map((n) => ({
    id: n.id, name: n.name, role: String(n.data.role ?? ""), goal: String((n.data.agenda as Agenda | undefined)?.want ?? ""),
  }));

export const castPrompt = () =>
  `You give a personality and a voice to the characters of a turn-based role-playing game. Always write in English.
Rules:
- For every character id, return "personality": two or three traits in at most ${PERSONALITY_MAX} characters, and "voice": one sentence, at most ${VOICE_MAX} characters, on how that character speaks.
- Fit each character to the goal they came with, but do not copy the goal, and make the characters clearly different from each other.
- No pronouns, gender, age or species: the text is reused in other prompts.
- Do not name other people, do not state facts about the world and do not use numbers.
- Use only the ids you are given.
Respond ONLY with JSON: {"characters":{"<id>":{"personality":string,"voice":string}}}.`;

export const PERSONALITY_MAX = 80;
export const VOICE_MAX = 160;

const oneLine = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length >= 3 && t.length <= max ? t : null;
};

// Tolerant of fences, prose and an array form; strict about each entry: an unknown id, a missing field
// or a text that is too long is dropped, never trimmed or guessed.
export function parseCastDraft(content: string, ids: readonly string[]): Record<string, Personality> {
  const json = extractJson(content);
  const raw = json?.characters;
  const entries: [unknown, any][] = Array.isArray(raw)
    ? raw.map((e: any) => [e?.id, e])
    : raw && typeof raw === "object" ? Object.entries(raw) : [];
  const out: Record<string, Personality> = {};
  for (const [id, e] of entries) {
    if (typeof id !== "string" || !ids.includes(id) || out[id]) continue;
    const personality = oneLine(e?.personality, PERSONALITY_MAX), voice = oneLine(e?.voice, VOICE_MAX);
    if (personality && voice) out[id] = { personality, voice };
  }
  return out;
}

export class OpenRouterCastWriter implements CastWriter {
  constructor(private llm: LlmClient) {}

  async write(req: CastRequest, onDelta?: DeltaSink): Promise<Record<string, Personality> | null> {
    if (this.llm.overBudget()) return null;
    const messages = [
      { role: "system", content: castPrompt() },
      { role: "user", content: JSON.stringify({ world: req.world ?? null, characters: req.characters }) },
    ];
    const res = await this.llm.chatRetry("cast", messages, {
      json: true, maxTokens: 2000, temperature: 0.9, tick: 0,
      onReasoning: (t) => onDelta?.({ kind: "reasoning", text: t }),
    }, 2);
    const picks = parseCastDraft(res.content, req.characters.map((c) => c.id));
    return Object.keys(picks).length ? picks : null;
  }
}
