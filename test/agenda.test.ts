import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame } from "../src/game.js";
import { OfflineNarrator } from "../src/narrator.js";
import type { Db } from "../src/db.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const create = (path = ":memory:", seed = 1337) => createGame(path, DATA, seed, () => new OfflineNarrator());

const agenda = (db: Db, id: string) =>
  db.prepare("SELECT goal_id, status FROM agenda_state WHERE character_id = ?").get(id) as
    { goal_id: string; status: string } | undefined;

const adjacent = (state: { niko: { x: number; y: number }; npcs: { name: string; x: number; y: number }[] }, name: string) => {
  const npc = state.npcs.find((n) => n.name === name)!;
  return Math.max(Math.abs(state.niko.x - npc.x), Math.abs(state.niko.y - npc.y)) <= 1;
};

test("an approaching NPC reaches Niko and reports its agenda", async () => {
  const { engine, db } = create();
  await engine.start();
  for (let i = 0; i < 60; i++) {
    await engine.takeTurn({ type: "wait" });
    if (agenda(db, "marta")?.status === "arrived") break;
  }
  assert.equal(agenda(db, "marta")?.status, "arrived");
  assert.equal(agenda(db, "marta")?.goal_id, "marta_warn");
  assert.ok(adjacent(engine.state(), "Marta"));
});

test("the same seed gives every NPC the same path", async () => {
  const a = create(":memory:", 42), b = create(":memory:", 42);
  for (const g of [a, b]) {
    await g.engine.start();
    for (let i = 0; i < 30; i++) await g.engine.takeTurn({ type: "wait" });
  }
  assert.deepEqual(a.engine.positions(), b.engine.positions());
  assert.deepEqual(
    a.db.prepare("SELECT character_id, goal_id, status FROM agenda_state ORDER BY character_id").all(),
    b.db.prepare("SELECT character_id, goal_id, status FROM agenda_state ORDER BY character_id").all(),
  );
});

test("an unreachable goal sets the agenda blocked and falls back to wandering", async () => {
  const { engine, db } = create();
  const data = JSON.parse((db.prepare("SELECT data FROM entities WHERE id = 'ivy'").get() as { data: string }).data);
  data.agenda.target = "a place that does not exist";
  db.prepare("UPDATE entities SET data = ? WHERE id = 'ivy'").run(JSON.stringify(data));
  const before = engine.positions().ivy;
  await engine.start();
  for (let i = 0; i < 30; i++) await engine.takeTurn({ type: "wait" });
  assert.equal(agenda(db, "ivy")?.status, "blocked");
  assert.notDeepEqual(engine.positions().ivy, before); // wander took over
});

test("agenda state survives a restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "niko-agenda-")), "game.db");
  const g1 = create(path);
  await g1.engine.start();
  for (let i = 0; i < 4; i++) await g1.engine.takeTurn({ type: "wait" });
  const saved = agenda(g1.db, "marta");
  assert.ok(saved);
  g1.db.close();

  const g2 = create(path);
  await g2.engine.start(); // must not repeat the initial narration
  assert.deepEqual(agenda(g2.db, "marta"), saved);
  g2.db.close();
});
