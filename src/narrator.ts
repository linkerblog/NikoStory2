import { getMeta, type Db } from "./db.js";
import { recall, DEFAULT_MEMORY_RULES, type MemoryQuery, type MemoryRules } from "./memory.js";
import { DEFAULT_STAKES_RULES, type StakesRules } from "./stakes.js";
import type { WorldFacts } from "./world.js";

export interface Option { id: string; text: string }
export interface Narration { text: string; options: Option[] }
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
// whatever thinking tokens the provider streams (shown dim, never enabled here), and "reset" asks the
// client to drop the current draft before a retry or a fallback.
export type DeltaKind = "text" | "reasoning" | "reset";
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
      return { text, options: c.actions.slice(0, 3).map((a) => ({ id: a.id, text: a.label })) };
    }
    if (c.arrival) {
      if (c.arrival.impact) {
        return { text: LANDING_LINES[c.arrival.impact], options: c.actions.slice(0, 3).map((a) => ({ id: a.id, text: a.label })) };
      }
      const base = FALL_LINES[c.arrival.altitude] ?? `Niko falls, ${c.arrival.altitude}.`;
      const text = c.arrival.text?.trim();
      return { text: text ? `${base} Niko acts: "${text}".` : base, options: c.actions.slice(0, 3).map((a) => ({ id: a.id, text: a.label })) };
    }
    return {
      text: c.events.join(" "),
      options: c.actions.slice(0, 3).map((a) => ({ id: a.id, text: a.label })),
    };
  }
}

export interface LlmConfig { apiKey: string; model: string; language: string; spendCapUsd: number; reasoning?: boolean }

export const systemPrompt = (language: string) =>
  `You are the narrator of a turn-based role-playing game. Write in ${language}.
Rules:
- Short sentences, at most two per narration, fast rhythm, no decorative text.
- Never state a distance as a number: no tiles, no metres. Use the proximity words in the situation.
- Do not restate what the previous narrations already said.
- End on pressure, a question or a visible choice.
- Give up to 3 options that differ in intent. During the fall's free-form beats, echo what Niko does and give no options.
- Do not decide for Niko: tell what happens and what he perceives. Do not invent characters or objects that are not in the situation.
- The world facts in the situation are true; do not contradict them and do not invent new ones.
Respond ONLY with JSON: {"narration": string, "options": [{"id": string, "text": string}]}. Each "id" must be exactly one of available_actions. If available_actions is empty, return an empty options list.`;

export const RETRY_HINT =
  "Your previous narration was rejected: it repeated an earlier narration or used a number for distance. " +
  "Rewrite it in at most two short sentences, do not repeat the previous narrations, and do not use tiles or metres.";

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
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let json: any;
  try { json = JSON.parse(match[0]); } catch { return null; }
  if (!Array.isArray(json?.map) || json.map.some((r: unknown) => typeof r !== "string")) return null;
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

  // One model call, logged before validation (an invalid response also costs). When the provider
  // honours `stream`, narration text is forwarded token by token and reasoning tokens are forwarded
  // as they arrive; when it ignores `stream`, the single JSON body is read and its narration emitted
  // in one delta so the client sees the same shape.
  private async streamAttempt(messages: { role: string; content: string }[], c: Context, onDelta?: DeltaSink): Promise<Narration> {
    const core = {
      model: this.cfg.model, messages, max_tokens: 32000, temperature: 0.8,
      stream: true, stream_options: { include_usage: true },
    };
    const rich = {
      ...core,
      response_format: { type: "json_object" },
      // Off by default: reasoning triples latency and cost. When on, its tokens are streamed too.
      ...(this.cfg.reasoning ? { reasoning: { enabled: true } } : {}),
    };
    // The plain retry drops response_format and reasoning so an unsupported parameter cannot hard-fail.
    let r = await this.post(rich);
    if (r.status === 400) r = await this.post(core);
    if (!r.ok) throw new Error(`OpenRouter responded ${r.status}`);
    const type = r.headers.get("content-type") ?? "";
    if (!r.body || !type.includes("text/event-stream")) {
      const data: any = await r.json();
      const choice = data.choices?.[0];
      const content: string = choice?.message?.content ?? "";
      this.logUsage(c.tick, data.usage, JSON.stringify(messages), content);
      const text = partialNarration(content);
      if (text) onDelta?.({ kind: "text", text });
      return parseNarration(content, choice?.finish_reason);
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let raw = "", content = "", shown = "", usage: any = null, finish: string | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = raw.indexOf("\n")) >= 0) {
        const line = raw.slice(0, nl).replace(/\r$/, "").trim();
        raw = raw.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let json: any;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const d = choice.delta ?? {};
        const think = typeof d.reasoning === "string"
          ? d.reasoning
          : Array.isArray(d.reasoning_details)
            ? d.reasoning_details.map((x: any) => x?.text ?? "").join("")
            : "";
        if (think) onDelta?.({ kind: "reasoning", text: think });
        if (typeof d.content === "string" && d.content) {
          content += d.content;
          const now = partialNarration(content);
          if (now !== null && now.length > shown.length && now.startsWith(shown)) {
            onDelta?.({ kind: "text", text: now.slice(shown.length) });
            shown = now;
          }
        }
      }
    }
    this.logUsage(c.tick, usage, JSON.stringify(messages), content);
    return parseNarration(content, finish);
  }

  private logUsage(tick: number, usage: any, request: string, response: string): void {
    this.db.prepare(
      `INSERT INTO llm_calls (tick, role, model, tokens_input, tokens_output, cost, request, response)
       VALUES (?, 'narrator', ?, ?, ?, ?, ?, ?)`,
    ).run(
      tick, this.cfg.model, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null,
      usage?.cost ?? null, request, response,
    );
  }

  // The architect call: one non-streaming request that designs a building. Any failure returns null
  // and the engine uses its deterministic generator, so a bad or expensive model cannot break play.
  async generateZone(req: ZoneRequest): Promise<ZoneDraft | null> {
    if (this.spent() >= this.cfg.spendCapUsd) return null;
    const messages = [
      { role: "system", content: architectPrompt(req) },
      { role: "user", content: JSON.stringify({ building: req.name, size: { width: req.width, height: req.height }, entry: req.entry, world: req.world ?? null }) },
    ];
    try {
      const r = await this.post({ model: this.cfg.model, messages, max_tokens: 8000, temperature: 0.7, response_format: { type: "json_object" } });
      if (!r.ok) return null;
      const data: any = await r.json();
      const content: string = data.choices?.[0]?.message?.content ?? "";
      this.logUsage(req.tick, data.usage, JSON.stringify(messages), content);
      return parseZoneDraft(content);
    } catch (e) {
      console.warn("The architect call failed, using the deterministic building:", (e as Error).message);
      return null;
    }
  }

  async narrate(c: Context, onDelta?: DeltaSink): Promise<Narration> {
    if (this.spent() >= this.cfg.spendCapUsd) {
      console.warn("Spend cap reached: narrator in offline mode.");
      return this.fallback.narrate(c, onDelta);
    }
    const recent = c.recentNarrations ?? [];
    const rejected = (n: Narration) => narrationRejected(n.text, recent, this.stakes.overlapThreshold);
    // Prompts can be overridden from the debug tab (settings table); empty means "use the default".
    const system = getMeta(this.db, "prompt_system") || systemPrompt(this.cfg.language);
    const retry = getMeta(this.db, "prompt_retry") || RETRY_HINT;
    const messages = [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(this.payload(c)) },
    ];
    try {
      const first = await this.streamAttempt(messages, c, onDelta);
      if (!rejected(first)) return first;
      // One retry with a stronger hint; a second failure accepts the offline narration. The retry
      // also respects the spend cap so it cannot outrun the budget. The client drops the first draft.
      onDelta?.({ kind: "reset", text: "" });
      if (this.spent() >= this.cfg.spendCapUsd) return this.fallback.narrate(c, onDelta);
      const second = await this.streamAttempt([...messages, { role: "system", content: retry }], c, onDelta);
      if (!rejected(second)) return second;
      onDelta?.({ kind: "reset", text: "" });
      return this.fallback.narrate(c, onDelta);
    } catch (e) {
      console.warn("The LLM narrator failed, using the offline one:", (e as Error).message);
      onDelta?.({ kind: "reset", text: "" });
      return this.fallback.narrate(c, onDelta);
    }
  }
}
