import { extractJson, type LlmClient } from "./llm.js";
import type { DeltaSink } from "./narrator.js";
import type { GameRules } from "./rules.js";
import { sanitizeEffect, type Effect } from "./interpreter.js";

// One actor's view of the world, handed to the `npc` role. The model proposes effects for this one
// actor only; the engine validates them with the same tile, path and witness rules it uses for Niko.
export interface NpcActor { id: string; name: string; personality: string; voice?: string }
export interface NpcAgenda { goal_id: string; kind: string; want: string }
export interface NpcVisible { id: string; name: string; proximity: string; direction: string; health?: string }
export interface NpcContext {
  tick: number;
  actor: NpcActor;
  agenda: NpcAgenda | null;
  place: { id: string; name: string; room: string };
  visible: NpcVisible[];
  objects: { id: string; name: string }[];
  ether: number;
  conversation: { partner: string; partner_name: string; beat: number; maxBeats: number } | null;
  recentEvents: string[];
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

export const npcPrompt = (c: NpcContext) =>
  `You decide the next action of one character in a grid game where 1 tile = 1 metre. You are not Niko.
Character: ${c.actor.name}${c.actor.personality ? `, ${c.actor.personality}` : ""}.${c.actor.voice ? ` ${c.actor.voice}` : ""}
Rules:
- Use only ids that appear in the situation. Never invent characters, objects, zones or abilities.
- Stay in character and act on this character's own goal. Niko does not control this character.
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
  place: c.place,
  visible_characters: c.visible,
  nearby_objects: c.objects,
  ether: c.ether,
  conversation: c.conversation,
  recent_events: c.recentEvents,
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
