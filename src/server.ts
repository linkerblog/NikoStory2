import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame } from "./game.js";
import { deleteMeta, getMeta, setMeta } from "./db.js";
import { OfflineNarrator, OpenRouterNarrator, RETRY_HINT, systemPrompt, type Narrator } from "./narrator.js";

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
const { engine, reset, db } = createGame(join(root, env.DB_PATH ?? "game.db"), join(root, "data"), Number(env.SEED ?? 1337), (db, rules, stakes): Narrator => {
  if (env.OPENROUTER_API_KEY && env.NARRATOR_MODEL) {
    const reasoning = env.NARRATOR_REASONING === "1";
    console.log(`Narrator: OpenRouter (${env.NARRATOR_MODEL})${reasoning ? " with reasoning streaming" : ""}`);
    return new OpenRouterNarrator(db, {
      apiKey: env.OPENROUTER_API_KEY, model: env.NARRATOR_MODEL,
      language: env.NARRATION_LANGUAGE ?? "English", spendCapUsd: Number(env.SPEND_CAP_USD ?? 0.5),
      reasoning,
    }, rules, stakes);
  }
  console.log("Narrator: offline (set OPENROUTER_API_KEY and NARRATOR_MODEL in .env to use the LLM)");
  return new OfflineNarrator();
});
await engine.start();

// The effective narrator prompts: the debug-tab override when set, the built-in default otherwise.
function promptsPayload() {
  const language = env.NARRATION_LANGUAGE ?? "English";
  const sys = getMeta(db, "prompt_system");
  const ret = getMeta(db, "prompt_retry");
  return {
    language,
    model: env.NARRATOR_MODEL ?? null,
    reasoning: env.NARRATOR_REASONING === "1",
    system: sys || systemPrompt(language),
    retry: ret || RETRY_HINT,
    systemDefault: systemPrompt(language),
    retryDefault: RETRY_HINT,
    systemCustom: !!sys,
    retryCustom: !!ret,
  };
}

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

// Server-Sent Events: the narrator's live deltas reach the client while the turn is still running.
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
            await reset((d) => send("delta", d));
            send("done", { ok: true, state: engine.state() });
          } catch (e) {
            console.error(e);
            send("error", { ok: false, error: "Internal error." });
          }
          res.end();
        } else {
          await reset();
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
