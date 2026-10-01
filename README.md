# NikoStory2 — prototype v0.7.0

A turn-based 2D game on a grid (1 tile = 1 m). Everything runs on your computer and the world
lives in a single SQLite file. The browser draws the state and sends commands; it never simulates.
The only input is free text: an LLM role, the **interpreter**, reads what you wrote and proposes
typed effects; the engine validates and commits them, so it stays the only writer of state.
Narration and the other roles are optional and come from an LLM through OpenRouter, falling back to
a fully offline mode with no network and no cost.

## Starting it

Requires Node 20 or higher.

```
npm install
cp .env.example .env      # optional: without .env every role runs offline
npm start
```

On Windows you can also double-click `LAUNCHER.bat`: it installs on the first run and starts the
game. Open http://127.0.0.1:3000. A new game opens with a short fall from the sky: three beats where
you write what Niko does (free text; "steer" and "brace" in the text steer the fall and cushion the
impact). After landing in the house, walk out of the front door to the street and into the buildings
around it; each building's interior is generated the first time you enter and is kept. Everything sits
on a 2D grid where 1 tile = 1 metre. Write what Niko does in the Actions box or the command line and
the engine resolves it. Move with the arrows or WASD; wait with space. There are no preset options.
To start from scratch, press the `Reset` button (or type `reset` in the command line); to wipe the save
by hand, delete `game.db`.

## Using the LLM

In `.env` define `OPENROUTER_API_KEY` and `NARRATOR_MODEL` (pick one at https://openrouter.ai/models).
Every role has its own model, reasoning flag and idle timeout: `<ROLE>_MODEL` (defaults to
`NARRATOR_MODEL`), `<ROLE>_REASONING` and `<ROLE>_IDLE_MS`, for the roles `INTERPRETER`, `NARRATOR`,
`ARCHITECT`, `CONTINUITY`, `MEMORY` and `NPC`. Reasoning defaults on for the interpreter, the
architect, the continuity check and the NPC decider, and off for the narrator and the memory writer.
A turn can take several calls
(interpreter, narrator, continuity, memory), and the idle timeout resets on every streamed chunk, so a
long reasoning call is not cut off. Every call is stored in `llm_calls` with its real role, tokens and,
if OpenRouter returns it, cost; the Debug tab shows the cost per role. When `SPEND_CAP_USD` is
reached every role goes offline and those turns are flagged `degraded`. A narration that repeats a
previous one or states distance in tiles is rejected and retried once; a flagged narration gets one
continuity rewrite. If that fails the offline narrator is used without breaking the game.

## Project layout

| Path | Contents |
|---|---|
| `src/db.ts` | SQLite open, numbered migrations and `settings` helpers |
| `src/world.ts` | Loads the zone, world and opening data and seeds Niko and the NPCs |
| `src/zones.ts` | Zone store, the deterministic street/building generator and the LLM-draft validator |
| `src/actions.ts` | The single `Action` union and the deterministic free-text parser |
| `src/rules.ts` | Loads and validates `data/rules.json` (abilities, effect limits, inventory slots, world limits) |
| `src/items.ts` | Items: the `Item` type, `data/items.json` validation and the once-per-save seeding |
| `src/interpreter.ts` | The `Effect`/`Interpretation` types, the offline interpreter and the OpenRouter one |
| `src/llm.ts` | Per-role model/reasoning/idle config, the streaming OpenRouter client and role logging |
| `src/engine.ts` | Effects, the opening fall, tick clock, Ether, perception, agendas, conversations, narration and `state()` |
| `src/agenda.ts` | Deterministic goals and BFS pathing for NPCs |
| `src/npc.ts` | The optional `npc` role: one proposal per actor, validated by the engine |
| `src/stakes.ts` | Scene hook, proximity/direction helpers and the stakes rules |
| `src/memory.ts` | Template memories, ranked recall, the memory role and the rolling summary |
| `src/narrator.ts` | `OfflineNarrator`, `OpenRouterNarrator`, JSON parsing, the narration checks and the continuity pass |
| `src/rng.ts` | Stateless seeded RNG (`rngFor`) |
| `src/game.ts` | Wires database, world, engine and the roles together |
| `src/server.ts` | Minimal `.env` loader and HTTP server (one turn at a time) |
| `public/index.html` | Terminal-style client: draws state and sends commands |
| `data/` | Zone, rooms, scene, items, world facts, opening, rules, Niko and NPC data as JSON |
| `test/` | `node:test` suites |

## Tests

```
npm run check     # types + tests
npm test          # tests only
```

## What is implemented

- Free text as the only input, in any language. The **interpreter** reads it and returns typed effects
  (`move`, `wait`, `speak`, `end_conversation`, `interact`, `ability`; `interact` carries one of the
  verbs `examine`, `search`, `take`, `drop`, `read`); the engine validates every one
  against the rules, applies them in order (one effect = one tick, at most `maxEffects`), stops at the
  first rejection and narrates the whole turn once. An effect with an unknown id, a path through a
  wall or too many effects is rejected with a reason.
- The interpreter may only use ids present in the situation; risky outcomes are rolled by the engine
  with `rngFor(seed, tick, "risk")` and stored in the event, never decided by the model.
- Offline mode wraps the deterministic parser, so zero-cost play and the tests run the same engine.
- The planner/narrator split: the model proposes prose and typed effects, the engine commits state.
- A scripted three-beat fall opens a new game: each beat takes free text, the engine scans it
  deterministically for steer/brace intents (a brace costs the ability's Ether), the fall does not
  advance the world, and the landing is deterministic and lands inside the house. The landing is stored
  as a high-importance `arrives` event seen only by its witnesses.
- A multi-zone world on one 2D grid (1 tile = 1 m): the hand-made 10x15 house, a 40x40 street with
  six buildings, and building interiors generated on first entry. Doors link zones; the entry tile is
  derived from the reciprocal door, so navigation stays coherent at every scale. Perception, collision
  and events are per zone.
- Building interiors are asked of the LLM (the architect role) and validated by the engine: exact
  size, solid border, walkable entry and a floor majority. A missing, invalid or over-budget draft
  falls back to a deterministic generator, so play never depends on the model.
- Character memory: low-importance events (`move`, `wait`, `appears`) get a deterministic template
  memory at the moment they happen; the `memory` role words the rest (talks, says, interactions,
  arrivals) at the end of the turn and a failed call falls back to the template, so every witness
  always gets one. Memories are ranked by recency, importance and relevance; the interpreter's
  keywords feed the narrator's recall query.
- A rolling summary every `summaryEveryTicks` ticks (migration 5, `story_summary`), written by the
  memory role from the previous summary plus the events since, and sent to the interpreter and the
  narrator as `story_so_far`.
- Two NPCs with data-driven agendas (`approach`, `follow`, `visit`) that path deterministically and
  offer to talk when they arrive; a blocked path falls back to wandering.
- An optional `npc` role lets one NPC at a time decide its own action: it proposes typed effects that
  the engine validates through the same tile, path and witness rules as Niko, and a missing, invalid
  or over-budget proposal falls back to the deterministic agenda. Two NPCs can hold a conversation
  between them, capped by `maxBeats` and closed by the engine; only the witnesses of the exchange
  remember it and, since Niko is not a party, no fact is revealed to him. The role runs at most once
  per NPC per turn, only while Niko can see the NPC and every `npcThinkEveryTicks` ticks.
- Conversations as effects: `speak` to an open conversation is a reply, `end_conversation` leaves;
  the engine closes the exchange after `maxBeats`, storing the revealed fact once.
- Items (migration 7, `items`): portable things with a single owner, a tile or a character, enforced by
  a `CHECK`. Four verbs are resolved by the engine, each one effect and one tick: `take` (adjacent, not
  hidden, portable, under `rules.inventorySlots`), `drop`, `search` (reveals the hidden items on an
  object's tile) and `read` (a second source of Niko's facts, equal to a conversation). A hidden item
  reaches no prompt and no client until it is found; an unknown verb is rejected with a reason. Item
  events carry their witnesses, who learn that Niko read something and not what it said. The items are
  seeded once per save from `data/items.json`, so an older save gains them and a later `take` is never undone.
- One scene (`data/scene.json`) with a question, facts and a goal: when Niko knows every fact the goal
  requires, by talking or by reading, the engine resolves the scene once, records `scene_resolved`
  and tells the narrator to close the beat on the answer. The narrator only receives the facts Niko
  already knows, and the goal text (the answer) only once it is resolved. The client shows the map
  items (click one to fill `take <name>`), the Inventory and the Goal.
- The narrator streams over Server-Sent Events: narration tokens and reasoning tokens reach the client
  while the turn runs, and a `stage` delta reports the phase (`interpreting`, `resolving`, `narrating`,
  `checking`). The narrator is followed by deterministic checks and one continuity rewrite; a turn that
  fell back to offline narration is flagged `degraded`.
- A `Debug` tab apart from the game view (topbar tab or `F2`): it reads `GET /api/debug` and shows the
  raw snapshot, seed, settings, entities, events with their witnesses, memories, the rolling summary,
  LLM calls and the cost per role, plus the prompts (system, retry and every request actually sent),
  which you can edit (saved as overrides in `settings`, empty restores the default).

## Not implemented yet

- Beliefs, relationships, embeddings and semantic retrieval of memories.
- NPC knowledge of facts, beliefs and relationships; NPCs still do not read `facts_known`.
- NPCs crossing zones: they only act in the zone Niko is in, and idle while he is away.
- Combat, health and equipment; attacking is refused by the interpreter with a reason.
- `give`, `use`, locks, containers, NPCs that take or react to items, items in generated buildings,
  and a second scene after `scene_resolved`.
- Zone generation. The south door (`D`) is the trigger and currently only prints a message.

## Assumptions to confirm

- `weight_kg: 118` in `data/niko.json` comes from the "260 lb" reference; adjust it.
- Initial Ether 3, max 100 and regeneration 1 per tick are provisional values; the `brace` cost of
  2 in `data/rules.json` is provisional so bracing is affordable exactly once at the start.
- The world facts in `data/world.json` and the opening lore in `data/niko.json` (`origin`, `core`)
  come from a brainstorming summary; confirm them against the original session before relying on
  them.
- The stakes values in `data/stakes_rules.json` (four conversation beats, proximity 1/3, the 0.6
  overlap threshold) and the scene hook in `data/scene.json` are provisional. The `rules.json`
  effect limits (`maxEffects` 4, `maxPathSteps` 6, `summaryEveryTicks` 20) are provisional too, as
  is `npcThinkEveryTicks` 3, the cadence of the `npc` role, and `inventorySlots` 8.
- The letter's `text`, the `fact_letter_text` wording and the goal `text` are placeholders
  (`<authored by the user>`) in `data/items.json` and `data/scene.json`: they decide the story's
  answer, so they wait for the author. The spare key in the wardrobe is a provisional example item.
- The client uses plain HTTP (no WebSocket): for a turn-based game it is enough and easier to debug.
- The client is plain JavaScript, with no types shared with the server.
- The OpenRouter roles could not be tested end to end (no network access from where it was built);
  the tests cover the engine, the offline roles and the narration/continuity checks.
