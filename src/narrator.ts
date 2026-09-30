import type { Db } from "./db.js";
import { recall, DEFAULT_MEMORY_RULES, type MemoryQuery, type MemoryRules } from "./memory.js";
import { DEFAULT_STAKES_RULES, type StakesRules } from "./stakes.js";
import type { WorldFacts } from "./world.js";

export interface Option { id: string; text: string }
export interface Narration { text: string; options: Option[] }
export interface VisibleActor { name: string; proximity: string; direction: string; personality: string }
export interface ConversationContext { npc: string; beat: number; maxBeats: number; want: string }
// The opening: `impact` is only set on the landing beat; `beat`/`beats` drive the fall beats.
export interface ArrivalContext {
  phase: "fall" | "play";
  altitude: string;
  beat: number;
  beats: number;
  impact?: "soft" | "hard";
  choices?: string[];
}
export interface Context {
  tick: number;
  sheet: Record<string, unknown>;
  place: { name: string; description: string; room?: string };
  visible: VisibleActor[];
  events: string[];
  actions: { id: string; label: string }[];
  lastMove?: string | null;
  recentNarrations?: string[];
  scene?: { question: string; knownFacts: string[] };
  conversation?: ConversationContext | null;
  memory?: MemoryQuery;
  world?: WorldFacts;
  arrival?: ArrivalContext;
}
export interface Narrator { narrate(c: Context): Promise<Narration> }

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
  async narrate(c: Context): Promise<Narration> {
    if (c.conversation) {
      const { npc, beat, want } = c.conversation;
      const text = beat === 0 && want
        ? `${npc} says: "${want}"`
        : beat === 1
          ? `${npc} repeats the point, firmer now.`
          : beat === 2
            ? `${npc} adds one more detail and watches Niko.`
            : `${npc} finishes and waits for an answer.`;
      return { text, options: c.actions.slice(0, 3).map((a) => ({ id: a.id, text: a.label })) };
    }
    if (c.arrival) {
      const text = c.arrival.impact
        ? LANDING_LINES[c.arrival.impact]
        : FALL_LINES[c.arrival.altitude] ?? `Niko falls, ${c.arrival.altitude}.`;
      return { text, options: c.actions.slice(0, 3).map((a) => ({ id: a.id, text: a.label })) };
    }
    return {
      text: c.events.join(" "),
      options: c.actions.slice(0, 3).map((a) => ({ id: a.id, text: a.label })),
    };
  }
}

export interface LlmConfig { apiKey: string; model: string; language: string; spendCapUsd: number }

const systemPrompt = (language: string) =>
  `You are the narrator of a turn-based role-playing game. Write in ${language}.
Rules:
- Short sentences, at most two per narration, fast rhythm, no decorative text.
- Never state a distance as a number: no tiles, no metres. Use the proximity words in the situation.
- Do not restate what the previous narrations already said.
- End on pressure, a question or a visible choice.
- Give up to 3 options that differ in intent.
- Do not decide for Niko: tell what happens and what he perceives. Do not invent characters or objects that are not in the situation.
- The world facts in the situation are true; do not contradict them and do not invent new ones.
Respond ONLY with JSON: {"narration": string, "options": [{"id": string, "text": string}]}. Each "id" must be exactly one of available_actions.`;

const RETRY_HINT =
  "Your previous narration was rejected: it repeated an earlier narration or used a number for distance. " +
  "Rewrite it in at most two short sentences, do not repeat the previous narrations, and do not use tiles or metres.";

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
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(
      finishReason === "length"
        ? `Narrator response was truncated at max_tokens (${content.length} chars)`
        : `Narrator response has no JSON object (${content.length} chars)`,
    );
  }
  let json: any;
  try {
    json = JSON.parse(match[0]);
  } catch {
    throw new Error(`Narrator response is not valid JSON (${match[0].length} chars)`);
  }
  if (typeof json?.narration !== "string" || !Array.isArray(json.options)) throw new Error("Invalid format");
  const options = json.options.filter((o: any) => typeof o?.id === "string" && typeof o?.text === "string");
  return { text: json.narration, options };
}

export class OpenRouterNarrator implements Narrator {
  private fallback = new OfflineNarrator();
  constructor(
    private db: Db,
    private cfg: LlmConfig,
    private rules: MemoryRules = DEFAULT_MEMORY_RULES,
    private stakes: StakesRules = DEFAULT_STAKES_RULES,
  ) {}

  private spent(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(cost), 0) AS t FROM llm_calls").get() as { t: number }).t;
  }

  // Highest-ranked memories survive the budget: lowest-ranked are dropped first, then the rest are
  // printed oldest-first so the model reads them chronologically.
  private memories(q: MemoryQuery): string[] {
    const { promptMaxItems, promptMaxChars } = this.rules.recall;
    const line = (m: { tick: number; text: string }) => `t${m.tick}: ${m.text}`;
    const selected = recall(this.db, q.characterId, q, promptMaxItems, this.rules);
    while (
      selected.length > 0 &&
      (selected.length > promptMaxItems || selected.reduce((n, m) => n + line(m).length, 0) > promptMaxChars)
    ) {
      selected.pop();
    }
    return selected.sort((a, b) => a.tick - b.tick || a.id - b.id).map(line);
  }

  private post(body: object): Promise<Response> {
    return fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "NikoStory2",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }

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
      niko_memories: c.memory ? this.memories(c.memory) : [],
      events_this_turn: c.events,
      available_actions: c.actions,
    };
  }

  // One model call, logged before validation (an invalid response also costs).
  private async attempt(messages: { role: string; content: string }[], c: Context): Promise<Narration> {
    const base = { model: this.cfg.model, messages, max_tokens: 32000, temperature: 0.8 };
    let r = await this.post({ ...base, response_format: { type: "json_object" } });
    if (r.status === 400) r = await this.post(base); // some models do not accept response_format
    if (!r.ok) throw new Error(`OpenRouter responded ${r.status}`);
    const data: any = await r.json();
    const choice = data.choices?.[0];
    const content: string = choice?.message?.content ?? "";
    this.db.prepare(
      `INSERT INTO llm_calls (tick, role, model, tokens_input, tokens_output, cost, request, response)
       VALUES (?, 'narrator', ?, ?, ?, ?, ?, ?)`,
    ).run(
      c.tick, this.cfg.model, data.usage?.prompt_tokens ?? null, data.usage?.completion_tokens ?? null,
      data.usage?.cost ?? null, JSON.stringify(messages), content,
    );
    return parseNarration(content, choice?.finish_reason);
  }

  async narrate(c: Context): Promise<Narration> {
    if (this.spent() >= this.cfg.spendCapUsd) {
      console.warn("Spend cap reached: narrator in offline mode.");
      return this.fallback.narrate(c);
    }
    const recent = c.recentNarrations ?? [];
    const rejected = (n: Narration) => narrationRejected(n.text, recent, this.stakes.overlapThreshold);
    const messages = [
      { role: "system", content: systemPrompt(this.cfg.language) },
      { role: "user", content: JSON.stringify(this.payload(c)) },
    ];
    try {
      const first = await this.attempt(messages, c);
      if (!rejected(first)) return first;
      // One retry with a stronger hint; a second failure accepts the offline narration. The retry
      // also respects the spend cap so it cannot outrun the budget.
      if (this.spent() >= this.cfg.spendCapUsd) return this.fallback.narrate(c);
      const second = await this.attempt([...messages, { role: "system", content: RETRY_HINT }], c);
      return rejected(second) ? this.fallback.narrate(c) : second;
    } catch (e) {
      console.warn("The LLM narrator failed, using the offline one:", (e as Error).message);
      return this.fallback.narrate(c);
    }
  }
}
