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
export interface Temperament { personality: string; voice: string; depth?: Depth; bearing?: string }
export interface CastSlot {
  role: string;
  spawns: Point[];
  routine: { type: string; prob?: number };
  agenda: Agenda;
  fact: { id: string; text: string };
}
export interface Cast { names: string[]; temperaments: Temperament[]; slots: CastSlot[]; bearings: Record<string, Bearing> }

// How a character carries itself toward Niko once its errand is done. `follow` walks after him and through
// doors, `linger` stays around within `leash` tiles without leaving the zone, `stay` keeps to its own business.
// `range` is the gap it is content with, `prob` the chance per tick it closes it. Stored whole in
// `entities.data.bearing`, so the engine reads no file.
export type BearingMode = "follow" | "linger" | "stay";
export interface Bearing { id: string; mode: BearingMode; range: number; leash: number; prob: number; word: string }
export const BEARING_LIMITS = { range: [1, 8], leash: [1, 20], word: [3, 120] } as const;
const MODES: ReadonlySet<string> = new Set<BearingMode>(["follow", "linger", "stay"]);

export function parseBearing(id: string, raw: unknown): Bearing | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || !MODES.has(r.mode as string)) return null;
  const L = BEARING_LIMITS;
  const { range, leash, prob } = r as { range: unknown; leash: unknown; prob: unknown };
  if (!Number.isInteger(range) || (range as number) < L.range[0] || (range as number) > L.range[1]) return null;
  if (!Number.isInteger(leash) || (leash as number) < L.leash[0] || (leash as number) > L.leash[1]) return null;
  if (typeof prob !== "number" || !(prob >= 0 && prob <= 1)) return null;
  const word = typeof r.word === "string" ? r.word.replace(/\s+/g, " ").trim() : "";
  if (!id || word.length < L.word[0] || word.length > L.word[1]) return null;
  return { id, mode: r.mode as BearingMode, range: range as number, leash: leash as number, prob, word };
}

// The bearing of a stored character, or nothing: a legacy save, a responder or an authored NPC without one
// reads exactly as before.
export const readBearing = (data: Record<string, unknown>): Bearing | null =>
  data.bearing && typeof data.bearing === "object" ? parseBearing(String((data.bearing as { id?: unknown }).id ?? ""), data.bearing) : null;

// Who a character is beyond a tone of voice. Stored flat in `entities.data` beside `personality` and
// `voice`. It is all or nothing: a depth that fails `parseDepth` is dropped whole, never trimmed.
export interface Depth { traits: string[]; quirk: string; fear: string; backstory: string }
export const DEPTH_LIMITS = { trait: 24, traitsMin: 2, traitsMax: 4, quirk: 120, fear: 80, backstory: 200 };
export const DEPTH_KEYS = ["traits", "quirk", "fear", "backstory"] as const;

const sentence = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length >= 3 && t.length <= max ? t : null;
};

export function parseDepth(raw: unknown): Depth | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.traits)) return null;
  const L = DEPTH_LIMITS;
  const traits = r.traits.map((t) => sentence(t, L.trait));
  if (traits.length < L.traitsMin || traits.length > L.traitsMax || traits.some((t) => t === null)) return null;
  if (new Set((traits as string[]).map((t) => t.toLowerCase())).size !== traits.length) return null;
  const quirk = sentence(r.quirk, L.quirk), fear = sentence(r.fear, L.fear), backstory = sentence(r.backstory, L.backstory);
  return quirk && fear && backstory ? { traits: traits as string[], quirk, fear, backstory } : null;
}

// The depth of a stored character, or nothing: a legacy save or an authored NPC without it reads as before.
export const readDepth = (data: Record<string, unknown>): Depth | null => parseDepth(data);

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
  if (temperaments.some((t) => t.depth !== undefined && !parseDepth(t.depth))) {
    throw new Error("cast.json temperament depth needs traits, a quirk, a fear and a backstory within bounds");
  }
  if (temperaments.length < slots.length) throw new Error("cast.json has fewer temperaments than slots");
  const bearings: Record<string, Bearing> = {};
  for (const [id, b] of Object.entries((raw.bearings ?? {}) as Record<string, unknown>)) {
    const parsed = parseBearing(id, b);
    if (!parsed) throw new Error(`cast.json bearing ${id} needs a mode, a range, a leash, a chance and a phrase within bounds`);
    bearings[id] = parsed;
  }
  if (temperaments.some((t) => t.bearing !== undefined && !bearings[t.bearing])) {
    throw new Error("cast.json temperament names a bearing that is not defined");
  }
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
  return { names, temperaments, slots, bearings };
}

// A draw without replacement, so no two characters of one cast share a name or a temperament.
function draw<T>(pool: readonly T[], count: number, rng: () => number): T[] {
  const left = [...pool];
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(left.splice(Math.floor(rng() * left.length), 1)[0]);
  return out;
}

const slug = (name: string) => name.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();

// Pure function of (cast, seed, home): the same seed always brings the same people, so a saved game replays.
// A home that lists its own spawns per role (`data/homes.json`) places them; the authored house leaves it to
// the slots, which carry the tiles of that one house.
export function generateCast(cast: Cast, seed: number, home?: { spawns?: Record<string, Point[]> }): GeneratedCast {
  const rng = rngFor(seed, 0, "cast");
  const names = draw(cast.names, cast.slots.length, rng);
  const temperaments = draw(cast.temperaments, cast.slots.length, rng);
  const taken = new Set<string>();
  const factTexts: Record<string, string> = {};
  const npcs = cast.slots.map((slot, i): NpcSeed => {
    const free = (home?.spawns?.[slot.role] ?? slot.spawns).filter((p) => !taken.has(`${p.x},${p.y}`));
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
        ...(temperaments[i].depth ?? {}),
        ...(temperaments[i].bearing ? { bearing: cast.bearings[temperaments[i].bearing!] } : {}),
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
export interface Personality { personality: string; voice: string; depth?: Depth; bearing?: string }
export interface CastBrief { id: string; name: string; role: string; goal: string }
// `bearings` maps each bearing the role may choose to the phrase that says what it means.
export interface CastRequest { characters: CastBrief[]; world?: WorldFacts; bearings?: Record<string, string> }
export interface CastWriter {
  write(req: CastRequest, onDelta?: DeltaSink): Promise<Record<string, Personality> | null>;
}

export const castBrief = (cast: GeneratedCast): CastBrief[] =>
  cast.npcs.map((n) => ({
    id: n.id, name: n.name, role: String(n.data.role ?? ""), goal: String((n.data.agenda as Agenda | undefined)?.want ?? ""),
  }));

export const castPrompt = (bearings: Record<string, string> = {}) =>
  `You give a personality, a voice and an inner life to the characters of a turn-based role-playing game. Always write in English.
Rules:
- For every character id, return "personality": two or three traits in at most ${PERSONALITY_MAX} characters, and "voice": one sentence, at most ${VOICE_MAX} characters, on how that character speaks.
- Also return "traits": ${DEPTH_LIMITS.traitsMin} to ${DEPTH_LIMITS.traitsMax} different words or short phrases of at most ${DEPTH_LIMITS.trait} characters each; "quirk": one small habit that shows in what the character does or says, at most ${DEPTH_LIMITS.quirk} characters; "fear": one ordinary worry, at most ${DEPTH_LIMITS.fear} characters; and "backstory": one or two sentences of past that a person of this world could have lived, at most ${DEPTH_LIMITS.backstory} characters.
- The backstory is private and has nothing to do with Niko or with the sky: do not mention a fall, a light or a stranger. Use the daily life of the world for its small details.
${Object.keys(bearings).length ? `- Also return "bearing": how the character carries itself around a stranger once its errand is done, one of ${Object.entries(bearings).map(([k, w]) => `"${k}" (${w})`).join(", ")}. Choose the one that fits the personality.
` : ""}- Fit each character to the goal they came with, but do not copy the goal, and make the characters clearly different from each other.
- No pronouns, gender, age or species: the text is reused in other prompts.
- Do not name other people, do not state facts about the world and do not use numbers.
- Use only the ids you are given.
Respond ONLY with JSON: {"characters":{"<id>":{"personality":string,"voice":string,"traits":[string],"quirk":string,"fear":string,"backstory":string${Object.keys(bearings).length ? ',"bearing":string' : ""}}}}.`;

export const PERSONALITY_MAX = 80;
export const VOICE_MAX = 160;

const oneLine = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length >= 3 && t.length <= max ? t : null;
};

// Tolerant of fences, prose and an array form; strict about each entry: an unknown id, a missing field
// or a text that is too long is dropped, never trimmed or guessed.
export function parseCastDraft(content: string, ids: readonly string[], bearings: readonly string[] = []): Record<string, Personality> {
  const json = extractJson(content);
  const raw = json?.characters;
  const entries: [unknown, any][] = Array.isArray(raw)
    ? raw.map((e: any) => [e?.id, e])
    : raw && typeof raw === "object" ? Object.entries(raw) : [];
  const out: Record<string, Personality> = {};
  for (const [id, e] of entries) {
    if (typeof id !== "string" || !ids.includes(id) || out[id]) continue;
    const personality = oneLine(e?.personality, PERSONALITY_MAX), voice = oneLine(e?.voice, VOICE_MAX);
    if (!personality || !voice) continue;
    // The depth stands on its own: a character with a good voice and a bad quirk keeps the voice.
    const depth = parseDepth(e);
    const bearing = typeof e?.bearing === "string" && bearings.includes(e.bearing) ? e.bearing : undefined;
    out[id] = { personality, voice, ...(depth ? { depth } : {}), ...(bearing ? { bearing } : {}) };
  }
  return out;
}

export class OpenRouterCastWriter implements CastWriter {
  constructor(private llm: LlmClient) {}

  async write(req: CastRequest, onDelta?: DeltaSink): Promise<Record<string, Personality> | null> {
    if (this.llm.overBudget()) return null;
    const messages = [
      { role: "system", content: castPrompt(req.bearings) },
      { role: "user", content: JSON.stringify({ world: req.world ?? null, characters: req.characters }) },
    ];
    const res = await this.llm.chatRetry("cast", messages, {
      json: true, maxTokens: 2000, temperature: 0.9, tick: 0,
      onReasoning: (t) => onDelta?.({ kind: "reasoning", text: t }),
    }, 2);
    const picks = parseCastDraft(res.content, req.characters.map((c) => c.id), Object.keys(req.bearings ?? {}));
    return Object.keys(picks).length ? picks : null;
  }
}
