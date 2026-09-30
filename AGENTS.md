# AGENTS.md

Working guide for agents and humans in this repository. `README.md` holds the player-facing
overview and the file map; this file holds the rules and the commands needed to change the code
without breaking it.

## What this project is

NikoStory2 is a single-player, turn-based 2D grid game (1 tile = 1 m) that runs entirely on
localhost. The world lives in one SQLite file; the browser draws the state and sends commands.
Narration is optional and comes from an LLM through OpenRouter, falling back to an offline
template narrator with no network and no cost.

Current scope (prototype v0.3.0): one hand-made house zone, a scripted three-beat fall that opens a
new game, Niko, two NPCs with data-driven agendas, a tick clock, Ether with regeneration,
line-of-sight perception and events stored with their witnesses. What is and is not implemented is
listed in `README.md`.

## Architecture rules (do not break)

- **The engine is the only writer of state.** `src/engine.ts` validates every action, advances the
  tick and commits changes. The narrator only proposes text and options.
- **One action API.** The client sends the `Action` union to `POST /api/turn`; the engine is the
  only place that turns an action into state. NPCs move through the same tile checks and the same
  `move` events, so no actor gets a private shortcut through walls.
- **The client never simulates.** `public/index.html` draws the state from `GET /api/state` and
  sends commands. No game state lives in the DOM or on the canvas.
- **The LLM proposes, the engine decides.** Narrator options whose `id` is not a real available
  action are discarded in `Engine.narrate`, which also clamps them to three.
- **Reactions come from knowledge.** Every event is stored with its `witnesses`: only the entities
  that could see it (vision range plus line of sight). Nothing reacts to what it did not perceive.
- **Determinism.** Randomness goes through the stateless seeded RNG (`rngFor(seed, tick, key)` in
  `src/rng.ts`); the seed and the tick live in the `settings` table. No `Math.random` and no
  wall-clock time inside the simulation, so the same seed and the same actions replay the same
  world.
- **Schema changes ship as migrations.** Append a numbered migration to `MIGRATIONS` in
  `src/db.ts`. Never edit an applied migration and never delete the savegame to change the schema.
- **Secrets stay local.** `OPENROUTER_API_KEY` lives in `.env` (gitignored) and never reaches the
  client; the server listens on `127.0.0.1` only.
- **Every LLM call is logged** to the `llm_calls` table with tokens and, when OpenRouter returns
  it, cost.

## Commands

- `npm install` — install dependencies.
- `npm start` — run the server at http://127.0.0.1:3000.
- `npm run dev` — the same with file watching.
- `npm test` — run the test suites.
- `npm run check` — type-check and test. Run this before calling anything done.
- `LAUNCHER.bat` (Windows) — installs on the first run and starts the game.

## Conventions

- **Docs.** A plan for a change to a game module is written as `Dev-XYZ.md` following
  `docs/DEV_FORMAT.md`; commit messages follow `docs/COMMITS.md`.
- **English only.** Code, comments, docs, identifiers and player-facing text are English.
- **Comments explain the why, not the what.** If the code is self-explanatory, do not comment it.
- **Narrator models.** Do not enable `reasoning` for the narrator model: it triples latency and
  cost for no benefit.
- **Responses** stay cordial, affectionate and affirming, with clear, technically precise language.
- **Progress updates** report a completion percentage from 0% through 100%, based on real task
  stages and their verification, never on elapsed time.
- **Before done:** run `npm run check`.

## Not implemented yet

- Beliefs, relationships, embeddings and semantic retrieval of memories (template memories with
  ranked recall are implemented).
- NPC decisions made by the LLM.
- Zone generation. The south door (`D`) is the trigger and currently only prints a message.
- Niko's abilities as general actions with an Ether cost; only the opening's `brace` exists.
- Adult ops: no sexual action exists yet. When one is added it must be adults-only and require
  consent from every party as op preconditions in code; Niko consents only if the player chooses so.
