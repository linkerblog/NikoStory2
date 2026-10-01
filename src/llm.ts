import type { Db } from "./db.js";

// Every model call belongs to a role. Each role has its own model, reasoning flag and idle timeout,
// so quality can be tuned per job without a global switch. The spend cap stays global.
export type LlmRole = "interpreter" | "narrator" | "architect" | "continuity" | "memory" | "npc";

export const LLM_ROLES: LlmRole[] = ["interpreter", "narrator", "architect", "continuity", "memory", "npc"];

export interface RoleConfig { model: string; reasoning: boolean; idleMs: number }
export interface LlmConfig {
  apiKey: string;
  language: string;
  spendCapUsd: number;
  roles: Record<LlmRole, RoleConfig>;
}

export interface ChatOptions {
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  tick?: number;
  onReasoning?: (text: string) => void;
  // Raw content deltas as the provider emits them; callers that need a decoded field (the narrator)
  // do their own incremental parsing and ignore this otherwise.
  onContent?: (delta: string) => void;
}

export interface ChatResult { content: string; finishReason?: string; usage: any }

// A model may wrap its JSON in prose or code fences. Extract the first balanced-looking object.
export function extractJson(content: string): any | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One shared OpenRouter client. Calls stream when the provider honours `stream`; the idle timeout
// resets on every chunk instead of capping the whole turn, so a slow reasoning model is not cut off.
export class LlmClient {
  constructor(private store: Db, private cfg: LlmConfig) {}

  // The role services read the same database (prompt overrides, recall) through this handle.
  get db(): Db { return this.store; }

  get language(): string { return this.cfg.language; }
  get spendCapUsd(): number { return this.cfg.spendCapUsd; }

  role(role: LlmRole): RoleConfig { return this.cfg.roles[role]; }

  spent(): number {
    return (this.store.prepare("SELECT COALESCE(SUM(cost), 0) AS t FROM llm_calls").get() as { t: number }).t;
  }

  overBudget(): boolean {
    return this.spent() >= this.cfg.spendCapUsd;
  }

  // Retries a call with backoff. The interpreter uses it; the narrator retries by rewriting instead.
  async chatRetry(role: LlmRole, messages: { role: string; content: string }[], opts: ChatOptions = {}, attempts = 3): Promise<ChatResult> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.chat(role, messages, opts);
      } catch (e) {
        last = e;
        if (i < attempts - 1) await sleep(1000 * (i + 1));
      }
    }
    throw last instanceof Error ? last : new Error("The model call failed.");
  }

  async chat(role: LlmRole, messages: { role: string; content: string }[], opts: ChatOptions = {}): Promise<ChatResult> {
    const rc = this.role(role);
    const stream = opts.stream !== false;
    const core: Record<string, unknown> = {
      model: rc.model,
      messages,
      max_tokens: opts.maxTokens ?? 32000,
      temperature: opts.temperature ?? 0.8,
    };
    if (stream) {
      core.stream = true;
      core.stream_options = { include_usage: true };
    }
    const rich: Record<string, unknown> = { ...core };
    if (opts.json) rich.response_format = { type: "json_object" };
    if (rc.reasoning) rich.reasoning = { enabled: true };

    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(), rc.idleMs);
    };
    arm();
    try {
      // A provider that rejects response_format or reasoning gets a plain retry rather than a failure.
      let r = await this.post(rich, ctl.signal);
      if (r.status === 400) { arm(); r = await this.post(core, ctl.signal); }
      if (!r.ok) throw new Error(`OpenRouter responded ${r.status}`);
      const type = r.headers.get("content-type") ?? "";
      if (!r.body || !type.includes("text/event-stream")) {
        const data: any = await r.json();
        const choice = data.choices?.[0];
        const content: string = choice?.message?.content ?? "";
        this.logUsage(role, rc.model, data.usage, messages, content, opts.tick);
        if (content) opts.onContent?.(content);
        return { content, finishReason: choice?.finish_reason, usage: data.usage };
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let raw = "", content = "", usage: any = null, finish: string | undefined;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
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
          if (think) opts.onReasoning?.(think);
          if (typeof d.content === "string" && d.content) {
            content += d.content;
            opts.onContent?.(d.content);
          }
        }
      }
      this.logUsage(role, rc.model, usage, messages, content, opts.tick);
      return { content, finishReason: finish, usage };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private post(body: object, signal: AbortSignal): Promise<Response> {
    return fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "NikoStory2",
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  logUsage(role: LlmRole, model: string, usage: any, request: unknown, response: string, tick?: number): void {
    this.store.prepare(
      `INSERT INTO llm_calls (tick, role, model, tokens_input, tokens_output, cost, request, response)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tick ?? this.tick(), role, model, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null,
      usage?.cost ?? null, JSON.stringify(request), response,
    );
  }

  // The engine keeps the current tick in `settings`; the caller normally passes its own tick.
  private tick(): number {
    try {
      const row = this.store.prepare("SELECT value FROM settings WHERE key = 'tick'").get() as { value?: string } | undefined;
      const n = Number(row?.value ?? 0);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
}
