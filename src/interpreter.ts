import { parseFreeAction, type Action, type Dir, type ItemRef, type ReplyChoice } from "./actions.js";
import { extractJson, type LlmClient } from "./llm.js";
import type { DeltaSink } from "./narrator.js";
import type { GameRules } from "./rules.js";
import type { Ent, WorldFacts, Zone } from "./world.js";

// What the player's text means, as typed effects. The engine validates every one of them against the
// same rules as any other action; the model only proposes, it never writes state.
export type Effect =
  | { kind: "move"; path: Dir[] }                       // up to rules.maxPathSteps
  | { kind: "wait" }
  | { kind: "speak"; to: string | null; text: string; tone?: ReplyChoice }
  | { kind: "end_conversation" }
  | { kind: "interact"; target: string; verb: string }  // object or item ids; the engine closes the verb list
  | { kind: "ability"; id: string; target?: string }
  | { kind: "attack"; target: string };                // a character id; the engine rolls the blow

export interface Interpretation {
  effects: Effect[];                // at most rules.maxEffects; the engine rejects anything longer
  impossible?: { reason: string };  // nothing valid could be extracted
  keywords: string[];               // names and objects the text mentions, for recall
}

export interface InterpretContext {
  text: string;
  tick: number;
  sheet: Record<string, unknown>;
  // The world as anyone in it would know it; Niko's own origin is already in the sheet, not here.
  world?: WorldFacts;
  ether: number;
  etherMax: number;
  rules: GameRules;
  zone: Zone;
  ents: Ent[];
  visible: { id: string; name: string; proximity: string; direction: string; health?: string }[];
  // Niko's inventory plus the non-hidden items he can see. A hidden item is never sent, so the model
  // cannot take what nobody has found.
  items: ItemRef[];
  conversation: { npc_id: string; npc: string; beat: number; want: string } | null;
  memories: string[];
  summary: string | null;
  recentNarrations: string[];
}

export interface Interpreter {
  interpret(c: InterpretContext, onDelta?: DeltaSink): Promise<Interpretation>;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "at", "with", "for", "my", "me", "i",
  "niko", "he", "his", "her", "she", "it", "that", "this", "then", "into", "from", "toward",
]);

// Names and objects the raw text mentions. Not semantic: enough to bias recall before the model has
// spoken, and the interpreter's own keywords replace them once it answers.
export function keywordsOf(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 4 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}

// The deterministic effects of the offline interpreter, from the one action the text maps to. An
// unmapped line becomes a monologue (`speak` with no target), exactly what the engine did before.
export function actionToEffects(a: Action): Effect[] {
  switch (a.type) {
    case "move": return [{ kind: "move", path: [a.dir] }];
    case "wait": return [{ kind: "wait" }];
    case "talk": return [{ kind: "speak", to: a.target, text: "" }];
    case "reply": return [{ kind: "speak", to: a.target, text: "", tone: a.choice }];
    case "leave": return [{ kind: "end_conversation" }];
    case "examine": return [{ kind: "interact", target: a.target, verb: "examine" }];
    case "item": return [{ kind: "interact", target: a.target, verb: a.verb }];
    case "say": return [{ kind: "speak", to: null, text: a.text }];
    case "ability": return [{ kind: "ability", id: a.id, target: a.target }];
    case "attack": return [{ kind: "attack", target: a.target }];
    default: return [{ kind: "wait" }];
  }
}

export class OfflineInterpreter implements Interpreter {
  async interpret(c: InterpretContext, _onDelta?: DeltaSink): Promise<Interpretation> {
    const mapped = parseFreeAction(c.text, c.zone, c.ents, c.conversation ?? undefined, c.items);
    return mapped
      ? { effects: actionToEffects(mapped), keywords: keywordsOf(c.text) }
      : { effects: [{ kind: "speak", to: null, text: c.text }], keywords: keywordsOf(c.text) };
  }
}

export function describeEffect(e: Effect): string {
  switch (e.kind) {
    case "move": return `move ${e.path.join("")}`;
    case "wait": return "wait";
    case "speak": return e.to ? `speak to ${e.to}` : "speak";
    case "end_conversation": return "end the conversation";
    case "interact": return `${e.verb} ${e.target}`;
    case "ability": return `ability ${e.id}${e.target ? ` on ${e.target}` : ""}`;
    case "attack": return `attack ${e.target}`;
  }
}

const DIRS: Dir[] = ["N", "S", "E", "W"];

// Models say "open" for what the engine calls a search and "grab" for a take. Any other verb is kept
// as given: the engine rejects it with a reason instead of silently turning it into an examine.
const VERB_ALIASES: Record<string, string> = { open: "search", grab: "take", pick_up: "take", pickup: "take" };
function normalizeVerb(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return "examine";
  const verb = v.trim().toLowerCase().replace(/\s+/g, "_");
  return VERB_ALIASES[verb] ?? verb;
}

export function sanitizeEffect(e: any): Effect | null {
  if (!e || typeof e !== "object") return null;
  switch (e.kind) {
    case "move": {
      if (!Array.isArray(e.path)) return null;
      const path = e.path.filter((d: unknown): d is Dir => DIRS.includes(d as Dir));
      return path.length ? { kind: "move", path } : null;
    }
    case "wait":
      return { kind: "wait" };
    case "speak": {
      const to = typeof e.to === "string" && e.to ? e.to : null;
      const text = typeof e.text === "string" ? e.text : "";
      if (!text && to === null) return null;
      const tone = e.tone === "ask" || e.tone === "reassure" || e.tone === "press" ? e.tone : undefined;
      return tone ? { kind: "speak", to, text, tone } : { kind: "speak", to, text };
    }
    case "end_conversation":
      return { kind: "end_conversation" };
    case "interact": {
      if (typeof e.target !== "string" || !e.target) return null;
      return { kind: "interact", target: e.target, verb: normalizeVerb(e.verb) };
    }
    case "ability": {
      if (typeof e.id !== "string" || !e.id) return null;
      return typeof e.target === "string" ? { kind: "ability", id: e.id, target: e.target } : { kind: "ability", id: e.id };
    }
    case "attack": {
      if (typeof e.target !== "string" || !e.target) return null;
      return { kind: "attack", target: e.target };
    }
    default:
      return null;
  }
}

// Tolerant of fences and prose, strict about shape: an invalid effect is dropped, never guessed.
export function parseInterpretation(content: string, finishReason?: string): Interpretation {
  const json = extractJson(content);
  if (!json) {
    throw new Error(
      finishReason === "length"
        ? `Interpreter response was truncated at max_tokens (${content.length} chars)`
        : `Interpreter response has no JSON object (${content.length} chars)`,
    );
  }
  const raw = Array.isArray(json.effects) ? json.effects : [];
  const effects: Effect[] = [];
  for (const e of raw) {
    const clean = sanitizeEffect(e);
    if (clean) effects.push(clean);
  }
  const keywords: string[] = Array.isArray(json.keywords)
    ? json.keywords.filter((k: unknown): k is string => typeof k === "string" && !!k.trim()).map((k: string) => k.trim()).slice(0, 8)
    : [];
  const reason = json.impossible?.reason;
  const impossible = typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : undefined;
  if (!effects.length && !impossible) throw new Error("Interpreter response had no usable effects");
  return impossible ? { effects, impossible, keywords } : { effects, keywords };
}

export const interpreterPrompt = (rules: GameRules, language: string) =>
  `You turn what the player wrote into typed effects for a grid game. The player may write in any language.
Rules:
- Use only ids that appear in the situation. Never invent characters, objects, zones or abilities.
- Return JSON only, with no narration and no options.
- "effects" is an ordered list, at most ${rules.maxEffects}. Each effect is one of:
  {"kind":"move","path":["N","N","E"]}  (N/S/E/W, at most ${rules.maxPathSteps} steps)
  {"kind":"wait"}
  {"kind":"speak","to":"<character id or null>","text":"<the player's own words>","tone":"ask|reassure|press"}
  {"kind":"end_conversation"}
  {"kind":"interact","target":"<object or item id>","verb":"examine|search|take|drop|read"}  (search targets an object, take/drop/read an item)
  {"kind":"ability","id":"<ability id>","target":"<id, optional>"}
  {"kind":"attack","target":"<visible character id>"}  (a punch or a kick at someone right next to Niko; the engine rolls whether it lands)
- The world in the situation is true: do not accept an action that contradicts it.
- Keep speak.text in the player's own words and language; do not rewrite it as narration.
- If nothing in the text can be done under these rules, return {"effects":[],"impossible":{"reason":"<short reason, in ${language}>"}}.
- "keywords": the names and objects the text mentions, for memory recall.
World limits: ${rules.limits.join(" ") || "none."} ${rules.risk}
Respond ONLY with JSON: {"effects":[...],"keywords":[...]} or {"effects":[],"impossible":{"reason":"..."},"keywords":[...]}.`;

export class OpenRouterInterpreter implements Interpreter {
  private offline = new OfflineInterpreter();
  constructor(private llm: LlmClient) {}

  private payload(c: InterpretContext) {
    return {
      player_text: c.text,
      niko_sheet: c.sheet,
      world: c.world ?? null,
      ether: { current: c.ether, max: c.etherMax },
      rules: {
        abilities: Object.values(c.rules.abilities),
        max_effects: c.rules.maxEffects,
        max_path_steps: c.rules.maxPathSteps,
        limits: c.rules.limits,
        risk: c.rules.risk,
      },
      place: {
        id: c.zone.id,
        name: c.zone.name,
        description: c.zone.description,
        objects: c.zone.objects.map((o) => ({ id: o.id, name: o.name })),
        doors: (c.zone.portals ?? []).map((p) => ({ label: p.label, to: p.to })),
      },
      visible_characters: c.visible,
      items: c.items,
      conversation: c.conversation,
      niko_memories: c.memories,
      story_so_far: c.summary,
      previous_narrations: c.recentNarrations,
    };
  }

  async interpret(c: InterpretContext, onDelta?: DeltaSink): Promise<Interpretation> {
    // Spend cap reached: the role goes offline rather than stopping play.
    if (this.llm.overBudget()) return this.offline.interpret(c, onDelta);
    const messages = [
      { role: "system", content: interpreterPrompt(c.rules, this.llm.language) },
      { role: "user", content: JSON.stringify(this.payload(c)) },
    ];
    const res = await this.llm.chatRetry("interpreter", messages, {
      json: true,
      maxTokens: 8000,
      temperature: 0.2,
      tick: c.tick,
      onReasoning: (t) => onDelta?.({ kind: "reasoning", text: t }),
    });
    return parseInterpretation(res.content, res.finishReason);
  }
}
