import type { Db } from "./db.js";

export interface Option { id: string; text: string }
export interface Narration { text: string; options: Option[] }
export interface Context {
  tick: number;
  sheet: Record<string, unknown>;
  place: { name: string; description: string };
  visible: { name: string; location: string; personality: string }[];
  events: string[];
  actions: { id: string; label: string }[];
}
export interface Narrator { narrate(c: Context): Promise<Narration> }

// No LLM: templates. Useful for testing the engine with no cost and no network.
export class OfflineNarrator implements Narrator {
  async narrate(c: Context): Promise<Narration> {
    return {
      text: c.events.join(" "),
      options: c.actions.slice(0, 3).map((a) => ({ id: a.id, text: a.label })),
    };
  }
}

export interface LlmConfig { apiKey: string; model: string; language: string; spendCapUsd: number }

const systemPrompt = (language: string) =>
  `You are the narrator of a turn-based role-playing game. Write in ${language}.
Rules: short sentences with clear intent, fast pace, no decorative text, little world-building per turn. There is always someone talking or doing something. At most 6 sentences.
Do not decide for Niko: tell what happens and what he perceives. Do not invent characters or objects that are not in the situation.
Respond ONLY with JSON: {"narration": string, "options": [{"id": string, "text": string}]}. Up to 3 options; each "id" must be exactly one of available_actions.`;

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
  constructor(private db: Db, private cfg: LlmConfig) {}

  private spent(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(cost), 0) AS t FROM llm_calls").get() as { t: number }).t;
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

  async narrate(c: Context): Promise<Narration> {
    if (this.spent() >= this.cfg.spendCapUsd) {
      console.warn("Spend cap reached: narrator in offline mode.");
      return this.fallback.narrate(c);
    }
    const messages = [
      { role: "system", content: systemPrompt(this.cfg.language) },
      {
        role: "user",
        content: JSON.stringify({
          niko_sheet: c.sheet, place: c.place, visible_characters: c.visible,
          events_this_turn: c.events, available_actions: c.actions,
        }),
      },
    ];
    const base = { model: this.cfg.model, messages, max_tokens: 32000, temperature: 0.8 };
    try {
      let r = await this.post({ ...base, response_format: { type: "json_object" } });
      if (r.status === 400) r = await this.post(base); // some models do not accept response_format
      if (!r.ok) throw new Error(`OpenRouter responded ${r.status}`);
      const data: any = await r.json();
      const choice = data.choices?.[0];
      const content: string = choice?.message?.content ?? "";
      // Logged before validating: an invalid response also costs.
      this.db.prepare(
        `INSERT INTO llm_calls (tick, role, model, tokens_input, tokens_output, cost, request, response)
         VALUES (?, 'narrator', ?, ?, ?, ?, ?, ?)`,
      ).run(
        c.tick, this.cfg.model, data.usage?.prompt_tokens ?? null, data.usage?.completion_tokens ?? null,
        data.usage?.cost ?? null, JSON.stringify(messages), content,
      );
      return parseNarration(content, choice?.finish_reason);
    } catch (e) {
      console.warn("The LLM narrator failed, using the offline one:", (e as Error).message);
      return this.fallback.narrate(c);
    }
  }
}
