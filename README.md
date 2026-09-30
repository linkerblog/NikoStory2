# NikoStory2 — prototype 0.0.1

A turn-based 2D game on a grid (1 tile = 1 m). Everything runs on your computer; the game is
a single SQLite file. The LLM (optional in this version) comes in through OpenRouter.

## Starting it

Requires Node 20 or higher.

```
npm install
cp .env.example .env      # optional: without .env the narrator runs in offline mode
npm start
```

Open http://127.0.0.1:3000. Move: arrows or WASD. Wait: space. Options: keys 1-3.
To start from scratch, delete `game.db`.

## Using the LLM

In `.env` define `OPENROUTER_API_KEY` and `NARRATOR_MODEL` (pick one at https://openrouter.ai/models;
better one that is not a reasoning model). Every call is stored in the `llm_calls` table with tokens and,
if OpenRouter returns it, cost. When `SPEND_CAP_USD` is reached the narrator goes back to offline mode.
If the LLM fails or answers badly, the offline narrator is used without breaking the game.

## Tests

```
npm run check     # types + tests
```

## What is there and what is not

Done (milestones 1 to 4 of the design document):
- SQLite with numbered migrations, stateless seeded RNG (same seed = same world).
- One hand-made zone (10x15 house), movable Niko, tick clock, Ether with regeneration.
- Perception by line of sight; every event is stored with its witnesses.
- Two NPCs with a wander routine, subject to the same movement rules as Niko.
- Narrator with JSON output and three options; the engine discards any option that is not a real
  action (the LLM proposes, the engine decides).

Pending:
- Character memory: memories, beliefs, relationships, embeddings and retrieval (milestone 6).
- NPC decisions with LLM (milestone 5) and zone generation (milestone 7). The south door is the trigger.
- Niko's abilities as actions with an Ether cost.

## Assumptions to confirm

- `weight_kg: 118` in `data/niko.json` comes from the "260 lb" in the reference session; adjust it.
- Initial Ether 3, max 100 and regeneration 1 per tick are provisional values.
- The client uses plain HTTP (no WebSocket): for a turn-based game it is enough and easier to debug.
- The client is plain JavaScript, with no types shared with the server.
- The OpenRouter narrator could not be tested end to end (no network access from where it was built);
  the tests cover the engine and the offline mode.
