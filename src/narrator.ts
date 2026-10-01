import { getMeta, type Db } from "./db.js";
import { recalledLines, DEFAULT_MEMORY_RULES, type MemoryQuery, type MemoryRules } from "./memory.js";
import { extractJson, type LlmClient } from "./llm.js";
import { DEFAULT_STAKES_RULES, type StakesRules } from "./stakes.js";
import type { WorldFacts } from "./world.js";

export interface Narration { text: string; degraded?: boolean }
export interface VisibleActor { name: string; proximity: string; direction: string; personality: string }
export interface ConversationContext { npc: string; beat: number; maxBeats: number; want: string }
// The opening: `impact` is only set on the landing beat; `beat`/`beats` drive the fall beats and
// `text` is the free-form action the player just wrote for this beat.
export interface ArrivalContext {
  phase: "fall" | "play";
  altitude: string;
  beat: number;
  beats: number;
  impact?: "soft" | "hard";
  choices?: string[];
  text?: string;
}
// The effects a free-text turn resolved or rejected, handed to the narrator and the continuity check.
export interface TurnEffects { resolved: string[]; rejected: { effect: string; reason: string }[] }
export interface Context {
  tick: number;
  sheet: Record<string, unknown>;
  place: { name: string; description: string; room?: string };
  visible: VisibleActor[];
  events: string[];
  effects?: TurnEffects;
  summary?: string | null;
  lastMove?: string | null;
  recentNarrations?: string[];
  // `resolved` stays true once Niko knows the goal's facts; `justResolved` is true only on the turn
  // that completes them, which is the one the narrator closes on the answer.
  scene?: { question: string; knownFacts: string[]; goal?: string; resolved?: boolean; justResolved?: boolean };
  conversation?: ConversationContext | null;
  memory?: MemoryQuery;
  world?: WorldFacts;
  arrival?: ArrivalContext;
}
// A building interior the engine asks the model to design. `entry` is the floor tile just inside the
// exit; the model must keep it walkable. `tick` is only used for logging the call.
export interface ZoneRequest {
  id: string; name: string; kind: string;
  width: number; height: number;
  entry: { x: number; y: number };
  tick: number;
  world?: WorldFacts;
}
export interface ZoneDraft {
  name?: string; description?: string;
  map: string[];
  objects?: unknown;
  rooms?: unknown;
}
export interface Narrator {
  narrate(c: Context, onDelta?: DeltaSink): Promise<Narration>;
  // Optional architect: returns a building draft or null. A narrator without it (offline) makes the
  // engine use its deterministic generator instead, so the game never depends on the model.
  generateZone?(req: ZoneRequest): Promise<ZoneDraft | null>;
}

// Live output while the model is still writing. "text" is the narration as it grows, "reasoning" is
// whatever thinking tokens the provider streams (shown dim), "reset" asks the client to drop the
// current draft before a retry, and "stage" reports the phase of the turn (interpreting, resolving,
// narrating, checking).
export type DeltaKind = "text" | "reasoning" | "reset" | "stage";
export interface Delta { kind: DeltaKind; text: string }
export type DeltaSink = (d: Delta) => void;

// The fall has no map and no NPCs to describe, so the offline narrator has its own lines: one per
// beat (keyed by altitude) and one per impact. None of them states a distance.
const FALL_LINES: Record<string, string> = {
  "high above the clouds": "Niko falls through cold air, high above the clouds.",
  "through the clouds": "The clouds tear past Niko as he drops through them.",
  "above the rooftops": "Rooftops rush up toward Niko, close enough to graze.",
};

const LANDING_LINES: Record<"soft" | "hard", string> = {
  soft: "Niko hits the ground and rolls; the Ether Core takes the worst of it.",
  hard: "Niko slams into the floor and the world goes white.",
};

// No LLM: templates. Useful for testing the engine with no cost and no network, and as the fallback
// when the model fails or answers with something the engine rejects.
export class OfflineNarrator implements Narrator {
  // No streaming: the offline narrator answers instantly, so the client's typewriter handles it.
  async narrate(c: Context, _onDelta?: DeltaSink): Promise<Narration> {
    return this.compose(c);
  }

  private compose(c: Context): Narration {
    if (c.conversation) {
      const { npc, beat, want } = c.conversation;
      const text = beat === 0 && want
        ? `${npc} says: "${want}"`
        : beat === 1
          ? `${npc} repeats the point, firmer now.`
          : beat === 2
            ? `${npc} adds one more detail and watches Niko.`
            : `${npc} finishes and waits for an answer.`;
      return { text };
    }
    if (c.arrival) {
      if (c.arrival.impact) return { text: LANDING_LINES[c.arrival.impact] };
      const base = FALL_LINES[c.arrival.altitude] ?? `Niko falls, ${c.arrival.altitude}.`;
      const text = c.arrival.text?.trim();
      return { text: text ? `${base} Niko acts: "${text}".` : base };
    }
    return { text: c.events.join(" ") };
  }
}

export const systemPrompt = (language: string) =>
  `You are the narrator of a turn-based role-playing game. Write in ${language}.
Rules:
- Short sentences, at most two per narration, fast rhythm, no decorative text.
- Never state a distance as a number: no tiles, no metres. Use the proximity words in the situation.
- Do not restate what the previous narrations already said.
- End on pressure, a question or a visible choice.
- Do not decide for Niko: tell what happens and what he perceives. Do not invent characters or objects that are not in the situation.
- The world facts in the situation are true; do not contradict them and do not invent new ones.
- While arrival.phase is "fall", Niko is alone in the open air: no other character is with him, near him or able to see him, and visible_characters is empty.
- When scene.justResolved is true, Niko has just learned the answer to the scene question (scene.goal): close the beat on that answer.
Respond ONLY with JSON: {"narration": string}.`;

export const RETRY_HINT =
  "Your previous narration was rejected: it repeated an earlier narration or used a number for distance. " +
  "Rewrite it in at most two short sentences, do not repeat the previous narrations, and do not use tiles or metres.";

export const continuityPrompt = (language: string) =>
  `You check the continuity of a narration against the facts. Write in ${language}.
Flag only real problems:
- it contradicts a world fact, a known fact or the place;
- it invents characters, objects or events that are not in the situation;
- it describes something the resolved and rejected effects say did not happen.
Respond ONLY with JSON: {"ok": boolean, "problems": [string]}. If it is fine, "ok" is true and "problems" is empty.`;

// The architect prompt: a strict, small 2D floor plan the engine will validate before using it.
export const architectPrompt = (req: ZoneRequest) =>
  `You design a small ${req.width}x${req.height} building interior for a grid game where 1 tile = 1 metre.
Rules:
- "map" has exactly ${req.height} strings of exactly ${req.width} characters.
- Each character is "#" (wall), "." (floor) or "D" (a door). Use "D" once, on the bottom wall, as the exit.
- The whole outer border must be "#". The floor tile just inside the exit, (${req.entry.x},${req.entry.y}), must be ".".
- Keep it readable at this scale: few rooms, a doorway between them, furniture along the walls.
- "objects": [{"id": string, "type": string, "name": string, "x": number, "y": number, "blocks": boolean}], on floor tiles, never on the door or entry.
- "rooms": [{"id": string, "name": string, "x": number, "y": number, "w": number, "h": number}], optional labels.
- English names that fit the setting; no numbers as distances.
Respond ONLY with JSON: {"name": string, "description": string, "map": string[], "objects": [...], "rooms": [...]}.`;

const TILE_COUNT = /(?:\b\d+\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)\s*(?:tiles?|metres?|meters?|m)\b/i;

export function hasTileCount(text: string): boolean {
  return TILE_COUNT.test(text);
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

export function jaccard(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

// A narration is rejected when it states a tile count or repeats one of the last narrations too
// closely. Pure and deterministic, so it can be tested without a network.
export function narrationRejected(text: string, recent: string[], threshold: number): boolean {
  if (hasTileCount(text)) return true;
  return recent.some((r) => jaccard(text, r) >= threshold);
}

// A model may wrap its JSON in prose or code fences, and may truncate at max_tokens.
// Check explicitly so the caller learns why, instead of getting an empty-string JSON error.
export function parseNarration(content: string, finishReason?: string): Narration {
  const json = extractJson(content);
  if (!json) {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(
        finishReason === "length"
          ? `Narrator response was truncated at max_tokens (${content.length} chars)`
          : `Narrator response has no JSON object (${content.length} chars)`,
      );
    }
    throw new Error(`Narrator response is not valid JSON (${match[0].length} chars)`);
  }
  if (typeof json.narration !== "string") throw new Error("Invalid format");
  return { text: json.narration };
}

export function parseContinuity(content: string): { ok: boolean; problems: string[] } {
  const json = extractJson(content);
  if (!json) throw new Error("Continuity response has no JSON object");
  const problems: string[] = Array.isArray(json.problems)
    ? json.problems.filter((p: unknown): p is string => typeof p === "string" && !!p.trim())
    : [];
  const ok = json.ok === true || (json.ok === undefined && problems.length === 0);
  return { ok, problems };
}

// Best-effort read of the `narration` field while its JSON is still streaming: returns the decoded
// prefix available so far, or null until the field starts. Never throws on a partial escape.
export function partialNarration(buf: string): string | null {
  const m = /"narration"\s*:\s*"/.exec(buf);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = "";
  while (i < buf.length) {
    const ch = buf[i];
    if (ch === '"') return out;
    if (ch === "\\") {
      if (i + 1 >= buf.length) return out;
      const esc = buf[i + 1];
      if (esc === "u") {
        if (i + 5 >= buf.length) return out;
        const code = parseInt(buf.slice(i + 2, i + 6), 16);
        if (Number.isNaN(code)) return out;
        out += String.fromCharCode(code);
        i += 6;
      } else {
        out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" }[esc] ?? esc);
        i += 2;
      }
    } else { out += ch; i++; }
  }
  return out;
}

// A model may wrap its JSON in prose or code fences; the engine validates the shape and ignores
// everything else. Returns null when there is no usable map so the engine falls back.
export function parseZoneDraft(content: string): ZoneDraft | null {
  const json = extractJson(content);
  if (!json) return null;
  if (!Array.isArray(json.map) || json.map.some((r: unknown) => typeof r !== "string")) return null;
  return {
    name: typeof json.name === "string" ? json.name : undefined,
    description: typeof json.description === "string" ? json.description : undefined,
    map: json.map,
    objects: json.objects,
    rooms: json.rooms,
  };
}

export class OpenRouterNarrator implements Narrator {
  private fallback = new OfflineNarrator();
  constructor(
    private llm: LlmClient,
    private rules: MemoryRules = DEFAULT_MEMORY_RULES,
    private stakes: StakesRules = DEFAULT_STAKES_RULES,
  ) {}

  private get db(): Db { return this.llm.db; }

  private payload(c: Context) {
    return {
      niko_sheet: c.sheet,
      place: c.place,
      world: c.world ?? null,
      arrival: c.arrival ?? null,
      last_move: c.lastMove ?? null,
      visible_characters: c.visible,
      scene: c.scene ?? null,
      conversation: c.conversation ?? null,
      previous_narrations: c.recentNarrations ?? [],
      story_so_far: c.summary ?? null,
      effects_this_turn: c.effects ?? null,
      niko_memories: c.memory ? recalledLines(this.db, c.memory, this.rules) : [],
      events_this_turn: c.events,
    };
  }

  // One streaming narrator call. Narration text is forwarded as it decodes; reasoning tokens are
  // forwarded as they arrive. The call is logged before validation, so an invalid response still costs.
  private async attempt(messages: { role: string; content: string }[], c: Context, onDelta?: DeltaSink): Promise<Narration> {
    let content = "", shown = "";
    const res = await this.llm.chat("narrator", messages, {
      json: true, tick: c.tick, maxTokens: 32000, temperature: 0.8,
      onReasoning: (t) => onDelta?.({ kind: "reasoning", text: t }),
      onContent: (d) => {
        content += d;
        const now = partialNarration(content);
        if (now !== null && now.length > shown.length && now.startsWith(shown)) {
          onDelta?.({ kind: "text", text: now.slice(shown.length) });
          shown = now;
        }
      },
    });
    return parseNarration(res.content, res.finishReason);
  }

  private async degraded(c: Context, onDelta?: DeltaSink): Promise<Narration> {
    const n = await this.fallback.narrate(c, onDelta);
    return { text: n.text, degraded: true };
  }

  // The continuity pass runs once after the deterministic checks: when it flags a real problem, the
  // narrator rewrites once and the rewrite is accepted either way. At most two extra calls per turn.
  private async continuity(c: Context, text: string): Promise<{ ok: boolean; problems: string[] } | null> {
    if (this.llm.overBudget()) return null;
    const messages = [
      { role: "system", content: continuityPrompt(this.llm.language) },
      { role: "user", content: JSON.stringify({
        narration: text,
        world: c.world ?? null,
        place: c.place,
        known_facts: c.scene?.knownFacts ?? [],
        recent_narrations: c.recentNarrations ?? [],
        resolved_effects: c.effects?.resolved ?? [],
        rejected_effects: c.effects?.rejected ?? [],
      }) },
    ];
    try {
      const res = await this.llm.chat("continuity", messages, { json: true, maxTokens: 2000, temperature: 0, tick: c.tick });
      return parseContinuity(res.content);
    } catch (e) {
      console.warn("The continuity check failed:", (e as Error).message);
      return null;
    }
  }

  // The architect call: one non-streaming request that designs a building. Any failure returns null
  // and the engine uses its deterministic generator, so a bad or expensive model cannot break play.
  async generateZone(req: ZoneRequest): Promise<ZoneDraft | null> {
    if (this.llm.overBudget()) return null;
    const messages = [
      { role: "system", content: architectPrompt(req) },
      { role: "user", content: JSON.stringify({ building: req.name, size: { width: req.width, height: req.height }, entry: req.entry, world: req.world ?? null }) },
    ];
    try {
      const res = await this.llm.chat("architect", messages, { json: true, maxTokens: 8000, temperature: 0.7, stream: false, tick: req.tick });
      return parseZoneDraft(res.content);
    } catch (e) {
      console.warn("The architect call failed, using the deterministic building:", (e as Error).message);
      return null;
    }
  }

  async narrate(c: Context, onDelta?: DeltaSink): Promise<Narration> {
    if (this.llm.overBudget()) {
      console.warn("Spend cap reached: narrator in offline mode.");
      return this.degraded(c, onDelta);
    }
    const recent = c.recentNarrations ?? [];
    const rejected = (n: Narration) => narrationRejected(n.text, recent, this.stakes.overlapThreshold);
    // Prompts can be overridden from the debug tab (settings table); empty means "use the default".
    const system = getMeta(this.db, "prompt_system") || systemPrompt(this.llm.language);
    const retry = getMeta(this.db, "prompt_retry") || RETRY_HINT;
    const messages = [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(this.payload(c)) },
    ];
    try {
      let first = await this.attempt(messages, c, onDelta);
      if (rejected(first)) {
        // One retry with a stronger hint; a second failure accepts the offline narration. The retry
        // also respects the spend cap so it cannot outrun the budget. The client drops the first draft.
        onDelta?.({ kind: "reset", text: "" });
        if (this.llm.overBudget()) return this.degraded(c, onDelta);
        first = await this.attempt([...messages, { role: "system", content: retry }], c, onDelta);
        if (rejected(first)) {
          onDelta?.({ kind: "reset", text: "" });
          return this.degraded(c, onDelta);
        }
      }
      // The continuity check only runs for free-text turns (they carry effects), and never on the
      // offline fallback. A flagged narration is rewritten once and accepted either way.
      if (c.effects && !this.llm.overBudget()) {
        onDelta?.({ kind: "stage", text: "checking" });
        const check = await this.continuity(c, first.text);
        if (check && !check.ok && check.problems.length) {
          onDelta?.({ kind: "reset", text: "" });
          const fix = `CONTINUITY FIX: ${check.problems.join(" ")} Rewrite the narration in at most two short sentences and fix these problems.`;
          return this.attempt([...messages, { role: "system", content: fix }], c, onDelta);
        }
      }
      return first;
    } catch (e) {
      console.warn("The LLM narrator failed, using the offline one:", (e as Error).message);
      onDelta?.({ kind: "reset", text: "" });
      return this.degraded(c, onDelta);
    }
  }
}
