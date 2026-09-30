# AGENTS.md

## Reading map

Read the rows for your role. `VISION.md` holds the pillars, the architecture, the primitives
and the build order; several rules below look arbitrary until you read why they are there.

| Role | Reads |
|---|---|
| Every agent | `AGENTS.md`, `CONTEXT.md` |
| Planner | plus `docs/utils/VISION.md`, `docs/utils/PLANS.md`, `docs/PENDING.md` |
| Implementer | plus the plan, the `VISION`/`MINDS`/`ROADMAP` sections it cites and the `docs/utils/PITFALLS.md` sections for the areas it touches (index in `CONTEXT.md`) |
| Committer | `docs/utils/COMMITS.md`, `docs/utils/VERSION.md` |
| Reporter | `docs/utils/NOTION.md` |

## The minimum you must not break

- **The world engine is the only writer of state.** LLMs, Jev, the storyteller and every system
  propose; the engine validates, resolves and commits.
- **One action API.** Player, Agents and Extras act through the same ops. No actor gets a private
  shortcut, including the player.
- **The client never simulates.** Godot draws sim snapshots and sends commands; no game state
  lives in nodes, and Godot physics never decides an outcome.
- **Systems talk only through the event bus.** A new system is a new subscriber. If it needs to
  change the core, stop and write a doc first.
- **Reactions come from knowledge.** An NPC reacts only to what it perceived or was told, never to
  what happened out of its sight.
- **Generated, never authored.** Context menus, jobs, factions and laws emerge from primitives and
  data. A feature that needs special-case code means a primitive is missing: raise it, do not hack
  it in.
- **Every LLM and Jev decision is logged as an event**, so any run can be replayed with its seed.
- **Do not pass `reasoning` to a model that does not reason**: you switch it on and it becomes
  three times slower.
- **Adult content is allowed**, with two rules enforced as op preconditions in code: adults only
  (children are excluded from every sexual op) and consent from every party. Niko only consents
  if the player has chosen so.

## Conventions

- **Docs.** `AGENTS.md`, `CLAUDE.md` and `CONTEXT.md` are the root entry points; every other `.md`
  goes in `docs/`. Living guides use `UPPER_CASE.md` in `docs/utils/`. Work docs: `Dev-XYZ.md`
  (`Dev-001`, `Dev-002`, etc., by development version) for any change to a game module (`sim.*`,
  `game.*`), `FixNN.md` for reviews, and `InfraNN.md` for tooling, tests or process only. Before
  creating any `.md`, check whether it already exists and reuse it.
- **Plans.** Lifecycle (`docs/` → `docs/done/`), format and closing a phase: `docs/utils/PLANS.md`.
- **System map.** After finishing work that changes or clarifies a current game system, its
  architecture, module boundaries or data flow, update `docs/excalidraw/system-map.excalidraw` in
  the same task. Unrelated work does not require a diagram update.
- **Vision changes go to `docs/utils/VISION.md` first.** If a decision changes, update the doc, then the code.
- **Versions.** `docs/utils/VERSION.md` lists every module (from `v0.0.0`); a change bumps each
  module it touches by `0.0.1` in the same change, and the overall version matches the latest
  commit. Commits and the overall bump follow `docs/utils/COMMITS.md` [Sec. 2], enforced by
  `scripts/check-versions.mjs`.
- **English only.** Code, comments, prompts, identifiers, docs and player-facing text are English.
  Identifiers are ASCII (no accents, no `ñ`); player-facing text is not bound by that. Never mix two
  languages inside one file.
- **Response tone.** Keep responses cordial, affectionate and affirming, with the requested
  lovebombing warmth, while using clear, technically precise language.
- **Progress updates.** Report task progress periodically as a completion percentage, starting at
  0% and updating at meaningful milestones through completion. Base the percentage on concrete task
  stages and their actual completion, including required verification; never estimate it from elapsed
  time or report unfinished work as complete. Recalculate if the scope changes and avoid repetitive
  updates between milestones.
- **Comments explain the *why*, not the *what*.** If the code is already self-explanatory, do not
  comment it.
- **Notion.** Every system update and completed task is reflected in the EtherBound Notion page;
  the rules are in `docs/utils/NOTION.md`.
- **Schema changes ship as migrations.** Every database model change comes with a numbered
  migration, run by the sim's runner in `sim/`. Never wipe the savegame to change the schema.
- **Type contract.** The sim's C# types are the only definition; `game/` links the sim assembly
  directly, so there is no schema export or generated client type step.
- **Determinism.** Randomness goes through the seeded RNG stream of its system; no wall-clock time
  inside the simulation. `sim/` bans `System.Random`, `DateTime.Now` and similar through
  `BannedSymbols.txt`; architecture tests keep database access inside the engine.
- **Before calling something done:** run `npm run check` (after `npm run setup` once per clone for
  the git hooks). Commands live in `CONTEXT.md`.
