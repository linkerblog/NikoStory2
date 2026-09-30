# NikoStory2 — prototype v0.1.0

A turn-based 2D game on a grid (1 tile = 1 m). Everything runs on your computer and the world
lives in a single SQLite file. The browser draws the state and sends commands; it never simulates.
Narration is optional and comes from an LLM through OpenRouter, falling back to an offline
narrator with no network and no cost.

## Starting it

Requires Node 20 or higher.

```
npm install
cp .env.example .env      # optional: without .env the narrator runs in offline mode
npm start
```

On Windows you can also double-click `LAUNCHER.bat`: it installs on the first run and starts the
game. Open http://127.0.0.1:3000. Move: arrows or WASD. Wait: space. Options: keys 1-3. To start
from scratch, delete `game.db`.

## Using the LLM

In `.env` define `OPENROUTER_API_KEY` and `NARRATOR_MODEL` (pick one at
https://openrouter.ai/models; better one that is not a reasoning model). Every call is stored in
the `llm_calls` table with tokens and, if OpenRouter returns it, cost. When `SPEND_CAP_USD` is
reached the narrator goes back to offline mode. If the LLM fails or answers badly, the offline
narrator is used without breaking the game.

## Project layout

| Path | Contents |
|---|---|
| `src/db.ts` | SQLite open, numbered migrations and `settings` helpers |
| `src/world.ts` | Loads `data/house_zone.json` and seeds Niko and the NPCs |
| `src/engine.ts` | Actions, tick clock, Ether, perception, narration and `state()` |
| `src/memory.ts` | Template memories per witnessed event and deterministic recall |
| `src/narrator.ts` | `OfflineNarrator`, `OpenRouterNarrator` and JSON parsing |
| `src/rng.ts` | Stateless seeded RNG (`rngFor`) |
| `src/game.ts` | Wires database, world and engine together |
| `src/server.ts` | Minimal `.env` loader and HTTP server (one turn at a time) |
| `public/index.html` | Canvas client: draws state and sends commands |
| `data/` | Zone, Niko and NPC data as JSON |
| `test/` | `node:test` suites |

## Tests

```
npm run check     # types + tests
npm test          # tests only
```

## What is implemented

- SQLite with numbered migrations and a stateless seeded RNG (same seed = same world).
- One hand-made zone (10x15 house), movable Niko, tick clock, Ether with regeneration.
- Perception by line of sight; every event is stored with its witnesses.
- Character memory: one template-based memory per witness of each event, ranked by recency,
  importance and relevance, with Niko's recalled memories fed to the narrator prompt.
- Two NPCs with a wander routine, subject to the same movement rules as Niko.
- A narrator with JSON output and three options; the engine discards any option that is not a real
  action (the LLM proposes, the engine decides).

## Not implemented yet

- Beliefs, relationships, embeddings and semantic retrieval of memories.
- NPC decisions made with the LLM and zone generation. The south door (`D`) is the trigger.
- Niko's abilities as actions with an Ether cost.

## Assumptions to confirm

- `weight_kg: 118` in `data/niko.json` comes from the "260 lb" reference; adjust it.
- Initial Ether 3, max 100 and regeneration 1 per tick are provisional values.
- The client uses plain HTTP (no WebSocket): for a turn-based game it is enough and easier to debug.
- The client is plain JavaScript, with no types shared with the server.
- The OpenRouter narrator could not be tested end to end (no network access from where it was
  built); the tests cover the engine and the offline mode.
