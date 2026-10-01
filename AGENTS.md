# AGENTS.md

Working guide for agents and humans in this repository. `README.md` holds the player-facing
overview and the file map; this file holds the rules and the commands needed to change the code
without breaking it.

## What this project is

NikoStory2 is a single-player, turn-based 2D grid game (1 tile = 1 m) that runs entirely on
localhost. The world lives in one SQLite file; the browser draws the state and sends commands.
Narration is optional and comes from an LLM through OpenRouter, falling back to an offline
template narrator with no network and no cost.

Current scope (prototype v0.13.0): a city of five outdoor districts, five homes a new game can open in, a scripted three-beat fall that opens a
new game, Niko, two NPCs with data-driven agendas, depth (traits, quirk, fear, backstory), ranked memories and a bearing that makes them follow Niko, and an optional `npc` role that proposes their
actions, a tick clock, Ether with regeneration, line-of-sight perception and events stored with their
witnesses, portable items with `take`/`drop`/`search`/`read`, unarmed combat with hit points, a scene goal, and incidents: the landing is reported and a government
written for each new game answers on a delay. Free text is the only
input: an interpreter role turns it into typed effects the engine validates. What is and is not
implemented is listed in `README.md`.

## Architecture rules (do not break)

- **A new game opens somewhere new.** `reset(onDelta, { seed })` also draws the start (`pickStart` in `src/homes.ts`):
  one home of `data/house_zone.json` and `data/homes.json` and one lot of `data/city.json`, from `rngFor(seed, 0, "start")`,
  stored in `settings` (`home`, `lot`). The authored game (no seed) always starts in `house_001` on `street_home`. A
  home must honour its contract (`living_room`, `table`, `wardrobe`, spawns per cast role) and a new item that belongs
  in the home uses `on`, never coordinates of one house. The city is data: add a district to `data/city.json`, not code.
- **A bearing is a move, not a shortcut.** A character with a `bearing` walks toward Niko with the same `bfsStep`,
  `free` and `move` events as anyone; the chance per tick is drawn through `rngFor`. Crossing a door is a `trail` in the
  character's data that `runTrails` settles in `stepWorld`; it is hidden from prompts. Only characters with a bearing do
  this: responders and legacy NPCs behave as before.
- **A new game is a new cast.** `reset(onDelta, { seed })` in `src/game.ts` replaces the NPCs with a
  cast generated from that seed (`src/cast.ts`, `data/cast.json`). The seed is drawn at the server's
  edge and then lives in the save, so the cast replays from it. A role slot owns its agenda and the
  scene fact it reveals. The optional `cast` role only picks each character's personality and voice;
  the engine validates it and the pool temperament is the fallback. Never hard-code an NPC id outside `data/npcs.json` and the tests of it.
- **The world reacts through incidents.** The landing raises an incident (`src/incidents.ts`); only a
  witness or a bystander can report it, and the report queues the government's protocol in
  `scheduled_events`, a table the engine drains in `stepWorld` in `(due_tick, id)` order. The government (an
  invented city, its institutions and the protocol, `src/government.ts`) is written by the optional
  `government` role at a seeded `reset`, validated by `sanitizeGovernment` and stored in `settings`;
  `data/government.json` is the fallback. Responders are ordinary NPCs spawned through a door: no private
  shortcuts. The institution learns where Niko is only through sightings, never by reading his position.
  A delay, a roll or a spawn is never decided by a model.
- **The world is the author's, and it is read fresh.** The worldbuilding lives in `data/world.json` and in the
  World tab's edit (`world_doc`, an install preference that `clearSave` keeps); `src/worlddoc.ts` is the only
  place that validates and compiles it, and the engine re-reads it on every call. The narrator and the
  continuity check get all of it. Every role that stands for someone else in the world (interpreter, NPC
  decider, architect, cast writer, government writer) gets `publicWorld`, without [Init], [Personality] and
  [Initial history]: nobody in the world knows where Niko comes from. A new role must be added to
  `WORLD_USERS`; a test fails if it is not. [Daily life] (`WorldFacts.life`) is public texture, kept apart from
  `facts`: prompts use it for small details and never as plot or as a fact to contradict.
- **Depth is all or nothing.** A character's `traits`, `quirk`, `fear` and `backstory` pass `parseDepth` (`src/cast.ts`)
  or are dropped whole. The backstory is private, names nobody and never mentions Niko or the fall. When the `cast`
  role rewrites a personality, the depth is the model's own or none, never the pool's for another temperament.
- **The fall has no company.** While `phase` is `fall` nobody is perceptible and the narrator's place
  is the sky; the house and its people come back with the landing.
- **The engine is the only writer of state.** `src/engine.ts` validates every action and effect,
  advances the tick and commits changes. The interpreter only proposes typed effects; the narrator
  only proposes text.
- **One action API.** The client sends `move`/`wait`/`fall`/`free` to `POST /api/turn`; the
  interpreter's effects map onto the same `Action` union in `src/actions.ts`, and the engine is the
  only place that turns an action into state. NPCs move through the same tile checks and the same
  `move` events, so no actor gets a private shortcut through walls.
- **The client never simulates.** `public/index.html` draws the state from `GET /api/state` and
  sends commands. No game state lives in the DOM or on the canvas.
- **The LLM proposes, the engine decides.** The interpreter may only use ids present in the
  situation; an effect with an unknown id, a path through a wall or more than `rules.maxEffects`
  effects is rejected with a reason. Risky outcomes are rolled by the engine with `rngFor`, never by
  the model.
- **Health is the engine's.** HP lives in `entities.data` (`hp`, `hp_max`, `guard_until`, `downed_until`);
  only `src/engine.ts` writes it, through `Engine.strike` for Niko and NPCs alike, with the blow rolled by
  `rngFor`. The Ether Core takes damage first and 0 HP downs a character, it never kills. Prompts get a
  health word from `healthBand`, never a number, and `publicData` strips the raw keys from every sheet.
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
- **Every LLM call is logged** to the `llm_calls` table with its real role (`interpreter`,
  `narrator`, `architect`, `continuity`, `memory`, `npc`, `cast`, `government`), tokens and, when OpenRouter returns it,
  cost.
- **Roles are configured, not hard-coded.** Each role has its own model, reasoning flag and idle
  timeout (`<ROLE>_MODEL`/`<ROLE>_REASONING`/`<ROLE>_IDLE_MS`); the spend cap is the only global. The
  Models tab overrides model and reasoning at runtime (`role_config`, resolved in `src/models.ts`:
  tab, then `.env`, then the narrator's model); it is an install preference, so `clearSave` keeps it,
  and the API key is never editable or readable from the browser.
  `post` uses an idle timeout that resets on every chunk, never a total timeout.

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
- NPC knowledge of facts, beliefs and relationships; NPCs still do not read `facts_known`.
- Zone generation. The south door (`D`) is the trigger and currently only prints a message.
- Consequences beyond a responder walking up to Niko and talking: custody, arrest, searches of other zones
  and pursuit through doors. Incidents other than the landing (a blow in the street is next), NPCs knowing
  about an alert (rumours, the press) and a city larger than the street.
- Weapons, equipment, ranged attacks, fall damage and death. `brace` is the only ability in
  `data/rules.json`; an `ability` effect other than a declared ability is rejected. Offline NPCs never
  fight back: retaliation comes only from the `npc` role.
- `give`, `use`, locks, containers, items for NPCs (they cannot take or read yet) and a scene after
  `scene_resolved`. The letter text and the goal text are placeholders until the author writes them.
- Adult ops: no sexual action exists yet. When one is added it must be adults-only and require
  consent from every party as op preconditions in code; Niko consents only if the player chooses so.
