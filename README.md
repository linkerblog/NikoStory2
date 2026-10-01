# NikoStory2 — prototype v0.3.0

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
game. Open http://127.0.0.1:3000. A new game opens with a short fall from the sky: three beats where
you write what Niko does (free text; "steer" and "brace" in the text steer the fall and cushion the
impact). After landing in the house, walk out of the front door to the street and into the buildings
around it; each building's interior is generated the first time you enter and is kept. Everything sits
on a 2D grid where 1 tile = 1 metre. You always have a free-text box (in the Actions panel and the
command line): write what Niko does and the engine maps it to an action or answers it as narration.
Move with the arrows or WASD. Wait: space. Options: keys 1-3.
To start from scratch, press the `Reset` button (or type `reset` in the command line); to wipe the save
by hand, delete `game.db`.

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
| `src/world.ts` | Loads the zone, world and opening data and seeds Niko and the NPCs |
| `src/zones.ts` | Zone store, the deterministic street/building generator and the LLM-draft validator |
| `src/engine.ts` | Actions, the opening fall, tick clock, Ether, perception, agendas, conversations, narration and `state()` |
| `src/agenda.ts` | Deterministic goals and BFS pathing for NPCs |
| `src/stakes.ts` | Scene hook, proximity/direction helpers and the stakes rules |
| `src/memory.ts` | Template memories per witnessed event and deterministic recall |
| `src/narrator.ts` | `OfflineNarrator`, `OpenRouterNarrator`, JSON parsing and the narration checks |
| `src/rng.ts` | Stateless seeded RNG (`rngFor`) |
| `src/game.ts` | Wires database, world and engine together |
| `src/server.ts` | Minimal `.env` loader and HTTP server (one turn at a time) |
| `public/index.html` | Terminal-style client (Dev-005): draws state and sends commands |
| `data/` | Zone, rooms, scene, world facts, opening, Niko and NPC data as JSON |
| `test/` | `node:test` suites |

## Tests

```
npm run check     # types + tests
npm test          # tests only
```

## What is implemented

- SQLite with numbered migrations and a stateless seeded RNG (same seed = same world).
- A scripted three-beat fall opens a new game: each beat takes free text (what Niko does), the engine
  scans it deterministically for steer/brace intents (a brace costs Ether), the fall does not advance
  the world, and the landing is deterministic and lands inside the house. The landing is stored as a
  high-importance `arrives` event seen only by its witnesses.
- Free text everywhere, not just the opening: `parseFreeAction` maps movement, wait, talk, examine and
  conversation replies deterministically, and any other line becomes a `say` event the narrator
  answers. The client shows a free-text box next to the narrated options and the command line uses the
  same path, so the player can always write what Niko does.
- The narrator receives the world facts (`data/world.json`) and Niko's origin so the prose matches
  the setting; the opening works with the offline narrator too.
- A multi-zone world on one 2D grid (1 tile = 1 m): the hand-made 10x15 house, a 40x40 street with
  six buildings, and building interiors generated on first entry. Doors link zones; the entry tile is
  derived from the reciprocal door, so navigation stays coherent at every scale. Perception, collision
  and events are per zone. Niko can leave the house and explore freely.
- Building interiors are asked of the LLM (the architect call) and validated by the engine: exact size,
  solid border, walkable entry and a floor majority. A missing, invalid or over-budget draft falls back
  to a deterministic generator, so play never depends on the model. Generated zones persist in `zones`.
- The house keeps its named rooms; Niko moves on the grid, a tick clock advances the world, and Ether
  regenerates each tick.
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
- The narrator streams over Server-Sent Events: narration tokens (and reasoning tokens, when the
  model emits them) reach the client while the turn is still running, which shows a live draft and
  keeps the action buttons disabled until the turn finishes. The offline narrator answers instantly
  and the client types it out.
- A `Debug` tab apart from the game view (topbar tab or `F2`): it reads `GET /api/debug` and has its
  own tab island. **Overview** shows the raw snapshot, seed, settings, entities, events with their
  witnesses, memories, LLM calls and counts; **Prompts** shows the narrator's system prompt, the retry
  hint and every prompt actually sent (the `llm_calls.request` messages, with their response), and lets
  you edit the system prompt and retry hint (saved as overrides in `settings`, empty restores the
  default).

## Not implemented yet

- Beliefs, relationships, embeddings and semantic retrieval of memories.
- NPC decisions made with the LLM and NPC-to-NPC conversations.
- NPCs crossing zones: they only act in the zone Niko is in, and idle while he is away.
- Niko's abilities as general actions with an Ether cost; only the opening's `brace` exists.

## Assumptions to confirm

- `weight_kg: 118` in `data/niko.json` comes from the "260 lb" reference; adjust it.
- Initial Ether 3, max 100 and regeneration 1 per tick are provisional values; the `brace` cost of
  2 in `data/opening.json` is provisional so bracing is affordable exactly once at the start.
- The world facts in `data/world.json` and the opening lore in `data/niko.json` (`origin`, `core`)
  come from a brainstorming summary; confirm them against the original session before relying on
  them.
- The stakes values in `data/stakes_rules.json` (four conversation beats, proximity 1/3, the 0.6
  overlap threshold) and the scene hook in `data/scene.json` are provisional.
- The client uses plain HTTP (no WebSocket): for a turn-based game it is enough and easier to debug.
- The client is plain JavaScript, with no types shared with the server.
- The OpenRouter narrator could not be tested end to end (no network access from where it was
  built); the tests cover the engine, the offline mode and the narration checks.
