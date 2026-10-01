import { extractJson, type LlmClient } from "./llm.js";
import type { DeltaSink } from "./narrator.js";
import type { GameRules } from "./rules.js";
import { sanitizeEffect, type Effect } from "./interpreter.js";
import type { WorldFacts } from "./world.js";

// One actor's view of the world, handed to the `npc` role. The model proposes effects for this one
// actor only; the engine validates them with the same tile, path and witness rules it uses for Niko.
export interface NpcActor {
  id: string; name: string; personality: string; voice?: string;
  // Who the character is beyond a tone of voice (`Depth` in `src/cast.ts`); absent in a legacy save.
  traits?: string[]; quirk?: string; fear?: string; backstory?: string;
  // How the character carries itself toward Niko (a phrase from `data/cast.json`); the engine moves it, the
  // model only knows it so its words and choices agree with where the character keeps itself.
  bearing?: string;
}
export interface NpcAgenda { goal_id: string; kind: string; want: string }
export interface NpcVisible { id: string; name: string; proximity: string; direction: string; health?: string }
export interface NpcContext {
  tick: number;
  actor: NpcActor;
  agenda: NpcAgenda | null;
  place: { id: string; name: string; room: string };
  visible: NpcVisible[];
  objects: { id: string; name: string }[];
  // The world as the people in it know it: no word of where Niko comes from.
  world?: WorldFacts;
  ether: number;
  conversation: { partner: string; partner_name: string; beat: number; maxBeats: number } | null;
  recentEvents: string[];
  // What this character remembers, ranked by recency, importance and relevance, oldest first.
  memories: string[];
  rules: GameRules;
}

export interface NpcDecision { effects: Effect[] }

// The decider is optional. Without one (offline, tests, over budget) the engine keeps its
// deterministic agenda step, so behavior and replay are unchanged.
export interface NpcDecider {
  decide(c: NpcContext, onDelta?: DeltaSink): Promise<NpcDecision | null>;
}

export class OfflineNpcDecider implements NpcDecider {
  async decide(): Promise<NpcDecision | null> {
    return null;
  }
}

// The character as the prompt tells it. The depth lines are left out when a character has none.
const characterBlock = (a: NpcActor) => [
  `Character: ${a.name}${a.personality ? `, ${a.personality}` : ""}.${a.voice ? ` ${a.voice}` : ""}`,
  a.traits?.length ? `Traits: ${a.traits.join(", ")}.` : "",
  a.quirk ? `Quirk: ${a.quirk}` : "",
  a.fear ? `Fear: ${a.fear}` : "",
  a.backstory ? `Background: ${a.backstory}` : "",
  a.bearing ? `Around Niko: ${a.bearing}.` : "",
].filter(Boolean).join("\n");

export const npcPrompt = (c: NpcContext) =>
  `You decide the next action of one character in a grid game where 1 tile = 1 metre. You are not Niko.
${characterBlock(c.actor)}
Rules:
- Use only ids that appear in the situation. Never invent characters, objects, zones or abilities.
- Stay in character and act on this character's own goal. The world in the situation is the one this character lives in. Niko does not control this character.
- Let the traits and the quirk show in what this character says and does, but not in every line. The background is private: it colours choices and is never recited.
- "memories" is what this character remembers, oldest first. Let it shape the reaction, never contradict it and do not invent a memory that is not listed.
- world.life is how ordinary days go here: use it for small details, never as plot.
- Return JSON only, with no narration and no options.
- "effects" is an ordered list, at most ${c.rules.maxEffects}. Each effect is one of:
  {"kind":"move","path":["N","N","E"]}  (N/S/E/W, at most ${c.rules.maxPathSteps} steps)
  {"kind":"wait"}
  {"kind":"speak","to":"<visible character id or null>","text":"<the character's own words>"}
  {"kind":"end_conversation"}
  {"kind":"interact","target":"<object id>","verb":"examine"}
  {"kind":"ability","id":"<ability id>","target":"<id, optional>"}
  {"kind":"attack","target":"<visible character id>"}
- "attack" only works on someone right next to this character who struck it a moment ago; use it to defend yourself, never to start a fight.
- "speak" to a character starts or continues a conversation; it only works when that character is right next to this one.
- If nothing is worth doing, return {"effects":[{"kind":"wait"}]}.
World limits: ${c.rules.limits.join(" ") || "none."} ${c.rules.risk}
Respond ONLY with JSON: {"effects":[...]}.`;

const payload = (c: NpcContext) => ({
  tick: c.tick,
  character: c.actor,
  agenda: c.agenda,
  world: c.world ?? null,
  place: c.place,
  visible_characters: c.visible,
  nearby_objects: c.objects,
  ether: c.ether,
  conversation: c.conversation,
  recent_events: c.recentEvents,
  memories: c.memories,
  rules: { abilities: Object.values(c.rules.abilities), max_effects: c.rules.maxEffects, max_path_steps: c.rules.maxPathSteps },
});

// Tolerant of fences and prose, strict about shape: an invalid effect is dropped, never guessed.
export function parseNpcDecision(content: string): NpcDecision | null {
  const json = extractJson(content);
  if (!json) return null;
  const raw = Array.isArray(json.effects) ? json.effects : [];
  const effects: Effect[] = [];
  for (const e of raw) {
    const clean = sanitizeEffect(e);
    if (clean) effects.push(clean);
  }
  return effects.length ? { effects } : null;
}

export class OpenRouterNpcDecider implements NpcDecider {
  constructor(private llm: LlmClient) {}

  async decide(c: NpcContext, onDelta?: DeltaSink): Promise<NpcDecision | null> {
    // Spend cap reached: no decision, the engine falls back to the deterministic agenda step.
    if (this.llm.overBudget()) return null;
    const messages = [
      { role: "system", content: npcPrompt(c) },
      { role: "user", content: JSON.stringify(payload(c)) },
    ];
    const res = await this.llm.chatRetry("npc", messages, {
      json: true,
      maxTokens: 2000,
      temperature: 0.7,
      tick: c.tick,
      onReasoning: (t) => onDelta?.({ kind: "reasoning", text: t }),
    });
    return parseNpcDecision(res.content);
  }
}
