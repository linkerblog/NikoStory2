import type { Db } from "./db.js";
import { LLM_ROLES, type LlmRole, type RoleConfig } from "./llm.js";

// What each role does, shown next to its model in the Models tab.
export const ROLE_INFO: Record<LlmRole, string> = {
  interpreter: "Turns the player's free text into typed effects the engine validates.",
  narrator: "Writes the narration of every turn. Also the default model of every other role.",
  architect: "Designs the interior of a building the first time the player enters it.",
  continuity: "Checks a narration against the known facts and asks for one rewrite.",
  memory: "Writes each character's memories and the running story summary.",
  npc: "Proposes what a non-player character does on its turn.",
  cast: "Picks the personality and voice of each new game's characters.",
  government: "Writes each new game's city, its institutions and how they answer an incident.",
};

export const REASONING_DEFAULT: Record<LlmRole, boolean> = {
  interpreter: true, narrator: false, architect: true, continuity: true, memory: false, npc: true, cast: false,
  government: true,
};

export interface RoleOverride { model: string | null; reasoning: boolean | null }
export type Overrides = Partial<Record<LlmRole, RoleOverride>>;

export type ModelSource = "ui" | "env" | "narrator" | "none";
export type ReasoningSource = "ui" | "env" | "default";
export interface ResolvedRole extends RoleConfig { modelSource: ModelSource; reasoningSource: ReasoningSource }

type Env = Record<string, string | undefined>;

// Precedence for the model: the Models tab, then `<ROLE>_MODEL`, then the narrator's model. The narrator
// itself falls back to `NARRATOR_MODEL`. Reasoning: the tab, then `<ROLE>_REASONING`, then the role default.
// The idle timeout is not editable: `<ROLE>_IDLE_MS`, else 120 s with reasoning and 60 s without.
export function resolveRoles(env: Env, overrides: Overrides): Record<LlmRole, ResolvedRole> {
  const narrator = overrides.narrator?.model || env.NARRATOR_MODEL || "";
  const out = {} as Record<LlmRole, ResolvedRole>;
  for (const role of LLM_ROLES) {
    const key = role.toUpperCase();
    const o = overrides[role];
    let model = "", modelSource: ModelSource = "none";
    if (o?.model) { model = o.model; modelSource = "ui"; }
    else if (env[`${key}_MODEL`]) { model = env[`${key}_MODEL`]!; modelSource = "env"; }
    else if (role !== "narrator" && narrator) { model = narrator; modelSource = "narrator"; }

    let reasoning = REASONING_DEFAULT[role], reasoningSource: ReasoningSource = "default";
    if (o?.reasoning !== null && o?.reasoning !== undefined) { reasoning = o.reasoning; reasoningSource = "ui"; }
    else if (env[`${key}_REASONING`] !== undefined) { reasoning = env[`${key}_REASONING`] === "1"; reasoningSource = "env"; }

    const idleMs = Number(env[`${key}_IDLE_MS`] ?? (reasoning ? 120_000 : 60_000));
    out[role] = { model, reasoning, idleMs, modelSource, reasoningSource };
  }
  return out;
}

export function loadOverrides(db: Db): Overrides {
  const rows = db.prepare("SELECT role, model, reasoning FROM role_config").all() as
    { role: string; model: string | null; reasoning: number | null }[];
  const out: Overrides = {};
  for (const r of rows) {
    if (!(LLM_ROLES as string[]).includes(r.role)) continue;
    out[r.role as LlmRole] = { model: r.model, reasoning: r.reasoning === null ? null : r.reasoning === 1 };
  }
  return out;
}

// A row with nothing left to override is deleted, so "reset" really returns to the `.env` behaviour.
export function saveOverrides(db: Db, patch: Overrides): void {
  const upsert = db.prepare(
    `INSERT INTO role_config (role, model, reasoning) VALUES (?, ?, ?)
     ON CONFLICT(role) DO UPDATE SET model = excluded.model, reasoning = excluded.reasoning`,
  );
  const del = db.prepare("DELETE FROM role_config WHERE role = ?");
  db.transaction(() => {
    for (const [role, o] of Object.entries(patch) as [LlmRole, RoleOverride][]) {
      if (o.model === null && o.reasoning === null) del.run(role);
      else upsert.run(role, o.model, o.reasoning === null ? null : o.reasoning ? 1 : 0);
    }
  })();
}

// OpenRouter ids are `vendor/name`, optionally with a `:variant` suffix (`:free`, `:online`).
const MODEL_ID = /^[\w.~-]+\/[\w.~:+@-]+$/;

// Validates the body of POST /api/models. An empty model or a null reasoning clears that override.
export function parseModelsPatch(body: unknown): { patch: Overrides } | { error: string } {
  const roles = (body as { roles?: unknown } | null)?.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return { error: "roles must be an object." };
  const patch: Overrides = {};
  for (const [role, raw] of Object.entries(roles)) {
    if (!(LLM_ROLES as string[]).includes(role)) return { error: `Unknown role "${role}".` };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${role} must be an object.` };
    const { model, reasoning } = raw as { model?: unknown; reasoning?: unknown };
    let m: string | null = null;
    if (model !== undefined && model !== null) {
      if (typeof model !== "string") return { error: `${role}: model must be a string.` };
      m = model.trim() || null;
      if (m && (m.length > 120 || !MODEL_ID.test(m))) return { error: `${role}: "${m}" is not a model id like vendor/name.` };
    }
    if (reasoning !== undefined && reasoning !== null && typeof reasoning !== "boolean") {
      return { error: `${role}: reasoning must be true, false or null.` };
    }
    patch[role as LlmRole] = { model: m, reasoning: typeof reasoning === "boolean" ? reasoning : null };
  }
  return { patch };
}

export interface CatalogModel { id: string; name: string; context: number | null; promptUsd: number | null; completionUsd: number | null }

// OpenRouter prices are USD per token as strings; the tab shows USD per million tokens.
export function parseCatalog(data: unknown): CatalogModel[] {
  const list = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return [];
  const perMillion = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1000) / 1000 : null;
  };
  const out: CatalogModel[] = [];
  for (const m of list) {
    if (!m || typeof m.id !== "string") continue;
    out.push({
      id: m.id,
      name: typeof m.name === "string" ? m.name : m.id,
      context: typeof m.context_length === "number" ? m.context_length : null,
      promptUsd: perMillion(m.pricing?.prompt),
      completionUsd: perMillion(m.pricing?.completion),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
