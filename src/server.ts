import { createServer } from "node:http";
import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "./game.js";
import { deleteMeta, getMeta, setMeta } from "./db.js";
import { RETRY_HINT, OpenRouterNarrator, systemPrompt } from "./narrator.js";
import { OpenRouterInterpreter } from "./interpreter.js";
import { OpenRouterMemories } from "./memory.js";
import { OpenRouterNpcDecider } from "./npc.js";
import { OpenRouterCastWriter } from "./cast.js";
import { OpenRouterGovernor } from "./government.js";
import { LLM_ROLES, LlmClient, type LlmRole } from "./llm.js";
import { ROLE_INFO, loadOverrides, parseCatalog, parseModelsPatch, resolveRoles, saveOverrides, type CatalogModel } from "./models.js";
import type { EngineServices } from "./engine.js";
import { applyWorldPatch, loadWorldDoc, worldPayload } from "./worlddoc.js";

const root = fileURLToPath(new URL("..", import.meta.url));

// Minimal .env, with no dependencies.
const envPath = join(root, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] !== "" && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = process.env;

// Each role has its own model, reasoning flag and idle timeout. `resolveRoles` (src/models.ts) merges the
// Models tab choices with `.env`. The engine holds this one object, so a change from the tab edits it in
// place: the player can go from offline to LLM, or swap a model, without restarting the server.
const services: EngineServices = offlineServices();
let llm: LlmClient | undefined;
let refreshServices = () => {};

function buildServices(db: import("./db.js").Db, memory: import("./memory.js").MemoryRules, stakes: import("./stakes.js").StakesRules): EngineServices {
  refreshServices = () => {
    const roles = resolveRoles(env, loadOverrides(db));
    if (!env.OPENROUTER_API_KEY || !roles.narrator.model) {
      llm = undefined;
      delete services.npcdecider;
      delete services.castwriter;
      delete services.governor;
      Object.assign(services, offlineServices());
      console.log("Roles: offline (set OPENROUTER_API_KEY in .env and pick a narrator model to use the LLM)");
      return;
    }
    if (llm) llm.configure(roles);
    else {
      llm = new LlmClient(db, {
        apiKey: env.OPENROUTER_API_KEY,
        language: env.NARRATION_LANGUAGE ?? "English",
        spendCapUsd: Number(env.SPEND_CAP_USD ?? 0.5),
        roles,
      });
      Object.assign(services, {
        narrator: new OpenRouterNarrator(llm, memory, stakes),
        interpreter: new OpenRouterInterpreter(llm),
        memories: new OpenRouterMemories(llm),
        npcdecider: new OpenRouterNpcDecider(llm),
        castwriter: new OpenRouterCastWriter(llm),
        governor: new OpenRouterGovernor(llm),
      });
    }
    const tag = (r: LlmRole) => `${r} ${roles[r].model}${roles[r].reasoning ? "(+reasoning)" : ""}`;
    console.log(`Roles: ${LLM_ROLES.map(tag).join(", ")}`);
  };
  refreshServices();
  return services;
}

const dataDir = join(root, "data");
const worldDefaults = loadWorldDoc(dataDir);
const { engine, reset, db } = createGame(
  join(root, env.DB_PATH ?? "game.db"),
  dataDir,
  Number(env.SEED ?? 1337),
  buildServices,
);
await engine.start();

// The effective narrator prompts and role config: the debug-tab override when set, the default otherwise.
function promptsPayload() {
  const language = env.NARRATION_LANGUAGE ?? "English";
  const sys = getMeta(db, "prompt_system");
  const ret = getMeta(db, "prompt_retry");
  const resolved = resolveRoles(env, loadOverrides(db));
  const roles = Object.fromEntries(
    LLM_ROLES.map((r) => [r, { model: resolved[r].model || null, reasoning: resolved[r].reasoning }]),
  );
  return {
    language,
    model: resolved.narrator.model || null,
    reasoning: resolved.narrator.reasoning,
    configured: llm !== undefined,
    roles,
    system: sys || systemPrompt(language),
    retry: ret || RETRY_HINT,
    systemDefault: systemPrompt(language),
    retryDefault: RETRY_HINT,
    systemCustom: !!sys,
    retryCustom: !!ret,
  };
}

// What the Models tab shows: the effective config of every role and where each value comes from. The key
// itself never leaves the server; the tab only learns whether there is one.
function modelsPayload() {
  const overrides = loadOverrides(db);
  const resolved = resolveRoles(env, overrides);
  const base = resolveRoles(env, {}); // what each role would be with no choice made in the tab
  const spent = (db.prepare("SELECT COALESCE(SUM(cost), 0) AS t FROM llm_calls").get() as { t: number }).t;
  return {
    ok: true,
    keyPresent: !!env.OPENROUTER_API_KEY,
    live: llm !== undefined,
    spentUsd: spent,
    spendCapUsd: Number(env.SPEND_CAP_USD ?? 0.5),
    roles: LLM_ROLES.map((r) => ({
      role: r,
      info: ROLE_INFO[r],
      model: resolved[r].model,
      modelSource: resolved[r].modelSource,
      reasoning: resolved[r].reasoning,
      reasoningSource: resolved[r].reasoningSource,
      envModel: env[`${r.toUpperCase()}_MODEL`] || null,
      baseReasoning: base[r].reasoning,
      override: overrides[r] ?? null,
    })),
  };
}

// The public OpenRouter model list feeds the tab's autocomplete. It is fetched here, without the key, and
// kept for an hour; when it cannot be reached the tab still accepts any id typed by hand.
let catalog: { at: number; models: CatalogModel[] } | undefined;
async function catalogPayload() {
  if (!catalog || Date.now() - catalog.at > 3_600_000) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`OpenRouter responded ${r.status}`);
      catalog = { at: Date.now(), models: parseCatalog(await r.json()) };
    } catch (e) {
      if (!catalog) return { ok: false, error: `Could not load the model list: ${(e as Error).message}`, models: [] };
    }
  }
  return { ok: true, models: catalog.models };
}

// Every "Start new game" is a new world with new characters. The seed is drawn here, at the edge of the
// simulation, and then lives in the save, so the game it opens still replays from its own seed.
const freshSeed = () => randomInt(1, 2 ** 31);

const html = readFileSync(join(root, "public", "index.html"));
let busy = false; // one turn at a time: the narrator is asynchronous

const readBody = (req: import("node:http").IncomingMessage) =>
  new Promise<string>((ok, fail) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 64_000) fail(new Error("Body too large")); });
    req.on("end", () => ok(s));
    req.on("error", fail);
  });

const wantsStream = (req: import("node:http").IncomingMessage) =>
  (req.headers.accept ?? "").includes("text/event-stream");

// Server-Sent Events: the turn's live deltas reach the client while it is still running.
function sse(res: import("node:http").ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  return (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = createServer(async (req, res) => {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } else if (req.method === "GET" && req.url === "/api/state") {
      json(200, engine.state());
    } else if (req.method === "GET" && req.url === "/api/debug") {
      json(200, { ...engine.debug(), prompts: promptsPayload() });
    } else if (req.method === "POST" && req.url === "/api/prompts") {
      let body: { system?: unknown; retry?: unknown };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(400, { ok: false, error: "Invalid JSON body." });
      }
      const errors: string[] = [];
      const apply = (key: string, value: unknown) => {
        if (value === undefined || value === null) return;
        if (typeof value !== "string") { errors.push(`${key} must be a string`); return; }
        const v = value.trim();
        if (!v) { deleteMeta(db, key); return; } // empty means "use the default"
        if (v.length > 8000) { errors.push(`${key} is too long (max 8000)`); return; }
        setMeta(db, key, v);
      };
      apply("prompt_system", body.system);
      apply("prompt_retry", body.retry);
      if (errors.length) return json(400, { ok: false, error: errors.join("; ") });
      json(200, { ok: true, prompts: promptsPayload() });
    } else if (req.method === "GET" && req.url === "/api/models") {
      json(200, modelsPayload());
    } else if (req.method === "GET" && req.url === "/api/models/catalog") {
      json(200, await catalogPayload());
    } else if (req.method === "POST" && req.url === "/api/models") {
      if (busy) return json(409, { ok: false, error: "Turn already in progress." });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(400, { ok: false, error: "Invalid JSON body." });
      }
      const parsed = parseModelsPatch(body);
      if ("error" in parsed) return json(400, { ok: false, error: parsed.error });
      saveOverrides(db, parsed.patch);
      refreshServices();
      json(200, modelsPayload());
    } else if (req.method === "GET" && req.url === "/api/world") {
      json(200, worldPayload(db, worldDefaults));
    } else if (req.method === "POST" && req.url === "/api/world") {
      if (busy) return json(409, { ok: false, error: "Turn already in progress." });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(400, { ok: false, error: "Invalid JSON body." });
      }
      const r = applyWorldPatch(db, body);
      if (!r.ok) return json(400, r);
      json(200, worldPayload(db, worldDefaults));
    } else if (req.method === "POST" && req.url === "/api/turn") {
      if (busy) return json(409, { ok: false, error: "Turn already in progress." });
      busy = true;
      try {
        const action = JSON.parse(await readBody(req));
        if (wantsStream(req)) {
          const send = sse(res);
          try {
            const r = await engine.takeTurn(action, (d) => send("delta", d));
            send("done", { ...r, state: engine.state() });
          } catch (e) {
            console.error(e);
            send("error", { ok: false, error: "Internal error." });
          }
          res.end();
        } else {
          const r = await engine.takeTurn(action);
          json(200, { ...r, state: engine.state() });
        }
      } finally {
        busy = false;
      }
    } else if (req.method === "POST" && req.url === "/api/reset") {
      if (busy) return json(409, { ok: false, error: "Turn already in progress." });
      busy = true;
      try {
        await readBody(req).catch(() => ""); // the reset carries no payload, but drain it to free the socket
        if (wantsStream(req)) {
          const send = sse(res);
          try {
            await reset((d) => send("delta", d), { seed: freshSeed() });
            send("done", { ok: true, state: engine.state() });
          } catch (e) {
            console.error(e);
            send("error", { ok: false, error: "Internal error." });
          }
          res.end();
        } else {
          await reset(undefined, { seed: freshSeed() });
          json(200, { ok: true, state: engine.state() });
        }
      } finally {
        busy = false;
      }
    } else {
      json(404, { ok: false, error: "Not found." });
    }
  } catch (e) {
    console.error(e);
    if (res.headersSent) res.end();
    else json(500, { ok: false, error: "Internal error." });
  }
});

const port = Number(env.PORT ?? 3000);
// Local only: the OpenRouter key is never exposed to the network.
server.listen(port, "127.0.0.1", () => console.log(`NikoStory2 at http://127.0.0.1:${port}`));
