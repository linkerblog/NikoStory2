import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame } from "../src/game.js";
import { canSee } from "../src/engine.js";
import { openDb } from "../src/db.js";
import { OfflineNarrator, type Narrator } from "../src/narrator.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const create = (path = ":memory:", seed = 1337, narrator: Narrator = new OfflineNarrator()) =>
  createGame(path, DATA, seed, () => narrator);

test("Niko does not walk through walls and an invalid move does not spend a turn", async () => {
  const { engine } = create();
  await engine.start();
  let last = { ok: true } as { ok: boolean; error?: string };
  for (let i = 0; i < 6 && last.ok; i++) last = await engine.takeTurn({ type: "move", dir: "W" });
  const before = engine.state();
  assert.equal(last.ok, false);
  assert.equal(before.niko.x, 1);
  const r = await engine.takeTurn({ type: "move", dir: "W" });
  assert.equal(r.ok, false);
  assert.equal(engine.state().tick, before.tick);
});

test("the exit door does not let you through: the neighboring zone does not exist yet", async () => {
  const { engine, db } = create();
  await engine.start();
  db.prepare("UPDATE entities SET x = 5, y = 13 WHERE id = 'niko'").run(); // right in front of the door
  const before = engine.state().tick;
  const r = await engine.takeTurn({ type: "move", dir: "S" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /door/);
  assert.equal(engine.state().tick, before);
});

test("perception respects walls", () => {
  const { engine } = create();
  const z = engine.zone;
  assert.equal(canSee(z, { x: 4, y: 10 }, { x: 1, y: 2 }), false); // a wall in between
  assert.equal(canSee(z, { x: 4, y: 10 }, { x: 4, y: 3 }), true);  // along the corridor
});

test("same seed, same world", async () => {
  const a = create(":memory:", 42), b = create(":memory:", 42);
  for (const g of [a, b]) {
    await g.engine.start();
    for (let i = 0; i < 40; i++) await g.engine.takeTurn({ type: "wait" });
  }
  assert.deepEqual(a.engine.positions(), b.engine.positions());
});

test("the wander fallback stays seed-dependent", async () => {
  const block = (g: ReturnType<typeof create>) => {
    for (const id of ["marta", "ivy"]) {
      const data = JSON.parse((g.db.prepare("SELECT data FROM entities WHERE id = ?").get(id) as { data: string }).data);
      data.agenda.target = "nowhere";
      g.db.prepare("UPDATE entities SET data = ? WHERE id = ?").run(JSON.stringify(data), id);
    }
  };
  const a = create(":memory:", 42), c = create(":memory:", 7);
  for (const g of [a, c]) {
    block(g);
    await g.engine.start();
    for (let i = 0; i < 40; i++) await g.engine.takeTurn({ type: "wait" });
  }
  assert.notDeepEqual(a.engine.positions(), c.engine.positions());
});

test("events store witnesses and only those who could see", async () => {
  const { engine, db } = create();
  await engine.start();
  for (let i = 0; i < 30; i++) await engine.takeTurn({ type: "wait" });
  const rows = db.prepare(
    `SELECT e.x, e.y, e.actor_id, GROUP_CONCAT(t.character_id) AS who
     FROM events e JOIN witnesses t ON t.event_id = e.id WHERE e.type = 'move' GROUP BY e.id`,
  ).all() as { x: number; y: number; actor_id: string; who: string }[];
  assert.ok(rows.length > 0);
  for (const f of rows) assert.ok(f.who.split(",").includes(f.actor_id)); // whoever acts sees themself
});

test("the game persists between sessions", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "niko-")), "game.db");
  const g1 = create(path);
  await g1.engine.start();
  for (let i = 0; i < 5; i++) await g1.engine.takeTurn({ type: "wait" });
  const e1 = g1.engine.state();
  g1.db.close();
  const g2 = create(path);
  await g2.engine.start(); // must not repeat the initial narration
  const e2 = g2.engine.state();
  assert.equal(e2.tick, 5);
  assert.deepEqual(e2.niko, e1.niko);
  assert.equal(e2.log.length, e1.log.length);
});

test("the engine discards options invented by the LLM", async () => {
  const liar: Narrator = {
    async narrate() {
      return { text: "Something happens.", options: [{ id: "fly", text: "Fly" }, { id: "wait", text: "Wait a bit" }] };
    },
  };
  const { engine } = create(":memory:", 1337, liar);
  await engine.start();
  const texts = engine.state().options.map((o) => o.text);
  assert.ok(!texts.includes("Fly"));
  assert.ok(texts.includes("Wait a bit"));
});

test("the stakes migration applies on a database from the previous version", () => {
  const path = join(mkdtempSync(join(tmpdir(), "niko-mig3-")), "game.db");
  const db1 = openDb(path);
  db1.prepare("INSERT INTO settings (key, value) VALUES ('probe', 'kept')").run();
  db1.exec("DROP TABLE agenda_state; DROP TABLE conversations; DROP TABLE facts_known");
  db1.prepare("DELETE FROM migrations WHERE n = 3").run();
  db1.close();

  const db2 = openDb(path);
  const migrations = (db2.prepare("SELECT n FROM migrations ORDER BY n").all() as { n: number }[]).map((r) => r.n);
  assert.deepEqual(migrations, [1, 2, 3]);
  const tables = (db2.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
    .map((r) => r.name);
  for (const t of ["agenda_state", "conversations", "facts_known"]) assert.ok(tables.includes(t));
  assert.equal((db2.prepare("SELECT value FROM settings WHERE key = 'probe'").get() as { value: string }).value, "kept");
  db2.close();
});
