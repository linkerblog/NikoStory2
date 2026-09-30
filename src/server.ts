import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame } from "./game.js";
import { OfflineNarrator, OpenRouterNarrator, type Narrator } from "./narrator.js";

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
const { engine } = createGame(join(root, env.DB_PATH ?? "game.db"), join(root, "data"), Number(env.SEED ?? 1337), (db): Narrator => {
  if (env.OPENROUTER_API_KEY && env.NARRATOR_MODEL) {
    console.log(`Narrator: OpenRouter (${env.NARRATOR_MODEL})`);
    return new OpenRouterNarrator(db, {
      apiKey: env.OPENROUTER_API_KEY, model: env.NARRATOR_MODEL,
      language: env.NARRATION_LANGUAGE ?? "English", spendCapUsd: Number(env.SPEND_CAP_USD ?? 0.5),
    });
  }
  console.log("Narrator: offline (set OPENROUTER_API_KEY and NARRATOR_MODEL in .env to use the LLM)");
  return new OfflineNarrator();
});
await engine.start();

const html = readFileSync(join(root, "public", "index.html"));
let busy = false; // one turn at a time: the narrator is asynchronous

const readBody = (req: import("node:http").IncomingMessage) =>
  new Promise<string>((ok, fail) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 10_000) fail(new Error("Body too large")); });
    req.on("end", () => ok(s));
    req.on("error", fail);
  });

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
    } else if (req.method === "POST" && req.url === "/api/turn") {
      if (busy) return json(409, { ok: false, error: "Turn already in progress." });
      busy = true;
      try {
        const r = await engine.takeTurn(JSON.parse(await readBody(req)));
        json(200, { ...r, state: engine.state() });
      } finally {
        busy = false;
      }
    } else {
      json(404, { ok: false, error: "Not found." });
    }
  } catch (e) {
    console.error(e);
    json(500, { ok: false, error: "Internal error." });
  }
});

const port = Number(env.PORT ?? 3000);
// Local only: the OpenRouter key is never exposed to the network.
server.listen(port, "127.0.0.1", () => console.log(`NikoStory2 at http://127.0.0.1:${port}`));
