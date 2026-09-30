# NikoStory2 — prototype v0.2.0

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
reached the narrator goes back to offline mode. A narration that repeats a previous one or states
distance in tiles is rejected and retried once (also logged and billed); if it fails again the
offline narrator is used without breaking the game.

## Project layout

| Path | Contents |
|---|---|
| `src/db.ts` | SQLite open, numbered migrations and `settings` helpers |
| `src/world.ts` | Loads `data/house_zone.json` and seeds Niko and the NPCs |
| `src/engine.ts` | Actions, tick clock, Ether, perception, agendas, conversations, narration and `state()` |
| `src/agenda.ts` | Deterministic goals and BFS pathing for NPCs |
| `src/stakes.ts` | Scene hook, proximity/direction helpers and the stakes rules |
| `src/memory.ts` | Template memories per witnessed event and deterministic recall |
| `src/narrator.ts` | `OfflineNarrator`, `OpenRouterNarrator`, JSON parsing and the narration checks |
| `src/rng.ts` | Stateless seeded RNG (`rngFor`) |
| `src/game.ts` | Wires database, world and engine together |
| `src/server.ts` | Minimal `.env` loader and HTTP server (one turn at a time) |
| `public/index.html` | Canvas client: draws state and sends commands |
| `data/` | Zone, rooms, scene, Niko and NPC data as JSON |
| `test/` | `node:test` suites |

## Tests

```
npm run check     # types + tests
npm test          # tests only
```

## What is implemented

- SQLite with numbered migrations and a stateless seeded RNG (same seed = same world).
- One hand-made zone (10x15 house) with named rooms, movable Niko, tick clock, Ether with
  regeneration.
- Perception by line of sight; every event is stored with its witnesses.
- Character memory: one template-based memory per witness of each event, ranked by recency,
  importance and relevance, with Niko's recalled memories fed to the narrator prompt.
- Two NPCs with data-driven agendas (`approach`, `follow`, `visit`) that path deterministically and
  offer to talk when they arrive; a blocked path falls back to wandering.
- Conversations as an action: `talk` opens a multi-beat exchange the engine closes (a leave option
  or four beats), storing the revealed fact once and marking the agenda done.
- One scene hook (`data/scene.json`); the narrator only receives the facts Niko already knows.
- A narrator with a tighter prompt (room, last move, previous narrations, proximity words instead
  of tile counts) and a reject-and-retry check; the engine discards any option that is not a real
  action (the LLM proposes, the engine decides).

## Not implemented yet

- Beliefs, relationships, embeddings and semantic retrieval of memories.
- NPC decisions made with the LLM and NPC-to-NPC conversations.
- Zone generation. The south door (`D`) is the trigger.
- Niko's abilities as actions with an Ether cost.

## Assumptions to confirm

- `weight_kg: 118` in `data/niko.json` comes from the "260 lb" reference; adjust it.
- Initial Ether 3, max 100 and regeneration 1 per tick are provisional values.
- The stakes values in `data/stakes_rules.json` (four conversation beats, proximity 1/3, the 0.6
  overlap threshold) and the scene hook in `data/scene.json` are provisional.
- The client uses plain HTTP (no WebSocket): for a turn-based game it is enough and easier to debug.
- The client is plain JavaScript, with no types shared with the server.
- The OpenRouter narrator could not be tested end to end (no network access from where it was
  built); the tests cover the engine, the offline mode and the narration checks.
