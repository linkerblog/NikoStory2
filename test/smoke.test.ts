import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import { canSee, type EngineServices } from "../src/engine.js";
import { openDb } from "../src/db.js";
import type { Narrator } from "../src/narrator.js";
import type { Interpreter, InterpretContext } from "../src/interpreter.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
// These suites cover the world after the opening, so they mark the save as past the fall the same
// way a v0.2.0 database without a `phase` does. The opening itself is covered by `opening.test.ts`.
const create = (path = ":memory:", seed = 1337, overrides: Partial<EngineServices> = {}) => {
  const g = createGame(path, DATA, seed, () => ({ ...offlineServices(), ...overrides }));
  g.db.prepare("UPDATE settings SET value = 'play' WHERE key = 'phase'").run();
  return g;
};

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

test("the south door leads outside and back, coherent with the 1 m grid", async () => {
  const { engine, db } = create();
  await engine.start();
  db.prepare("UPDATE entities SET x = 5, y = 13 WHERE id = 'niko'").run(); // just inside the front door
  const r = await engine.takeTurn({ type: "move", dir: "S" });
  assert.equal(r.ok, true);
  assert.equal(engine.zone.id, "outdoor");
  const out = engine.state();
  assert.equal(out.zoneId, "outdoor");
  assert.deepEqual([out.niko.x, out.niko.y], [20, 36]); // the tile just outside the front door
  // and back in: the entry tile is derived from the reciprocal door, not stored twice
  const back = await engine.takeTurn({ type: "move", dir: "N" });
  assert.equal(back.ok, true);
  assert.equal(engine.zone.id, "house_001");
  assert.deepEqual([engine.state().niko.x, engine.state().niko.y], [5, 13]);
});

test("walking into a building generates it deterministically and lets Niko explore and leave", async () => {
  const { engine, db } = create();
  await engine.start();
  db.prepare("UPDATE entities SET zone_id = 'outdoor', x = 6, y = 9 WHERE id = 'niko'").run(); // at the bakery door
  const r = await engine.takeTurn({ type: "move", dir: "N" });
  assert.equal(r.ok, true);
  assert.equal(engine.zone.id, "building_bakery");
  assert.equal(engine.zone.kind, "building");
  assert.deepEqual([engine.state().niko.x, engine.state().niko.y], [5, 7]); // inside, on the entry tile
  // the interior is persisted so it survives a restart
  const rows = db.prepare("SELECT id FROM zones WHERE id = 'building_bakery'").all() as { id: string }[];
  assert.deepEqual(rows.map((x) => x.id), ["building_bakery"]);
  // walk one tile east and back, then leave through the door
  assert.equal((await engine.takeTurn({ type: "move", dir: "E" })).ok, true);
  assert.equal((await engine.takeTurn({ type: "move", dir: "W" })).ok, true);
  const out = await engine.takeTurn({ type: "move", dir: "S" });
  assert.equal(out.ok, true);
  assert.equal(engine.zone.id, "outdoor");
  assert.deepEqual([engine.state().niko.x, engine.state().niko.y], [6, 9]);
});

test("a door with no portal is sealed", async () => {
  const { engine, db } = create();
  await engine.start();
  db.prepare("UPDATE entities SET x = 5, y = 13 WHERE id = 'niko'").run();
  engine.zone.portals.length = 0; // the 'D' tile now has nothing behind it
  const r = await engine.takeTurn({ type: "move", dir: "S" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /sealed/);
});

test("an invalid architect draft is discarded for the deterministic building", async () => {
  const bad: Narrator = {
    async narrate() { return { text: "ok" }; },
    async generateZone() { return { map: ["###", "#.#", "###"] }; }, // wrong size, no door
  };
  const { engine, db } = create(":memory:", 1337, { narrator: bad });
  await engine.start();
  db.prepare("UPDATE entities SET zone_id = 'outdoor', x = 6, y = 9 WHERE id = 'niko'").run();
  assert.equal((await engine.takeTurn({ type: "move", dir: "N" })).ok, true);
  const z = engine.zone;
  assert.equal(z.width, 11);
  assert.equal(z.height, 9);
  assert.equal(z.map[8][5], "D"); // the engine stamped its own exit
});

test("a valid architect draft is used, keeping the exit and entry walkable", async () => {
  const good: Narrator = {
    async narrate() { return { text: "ok" }; },
    async generateZone() {
      const map = ["###########"];
      for (let y = 1; y < 8; y++) map.push("#.........#");
      map.push("###########");
      map[8] = "###########";
      return { name: "the tea house", map };
    },
  };
  const { engine, db } = create(":memory:", 1337, { narrator: good });
  await engine.start();
  db.prepare("UPDATE entities SET zone_id = 'outdoor', x = 6, y = 9 WHERE id = 'niko'").run();
  assert.equal((await engine.takeTurn({ type: "move", dir: "N" })).ok, true);
  assert.equal(engine.zone.name, "the tea house");
  assert.equal(engine.zone.map[8][5], "D");
});

test("free text is mapped to real actions and otherwise answered by the narrator", async () => {
  const { engine, db } = create();
  await engine.start();
  const start = engine.state().niko;
  assert.equal((await engine.takeTurn({ type: "free", text: "go north" })).ok, true);
  assert.equal(engine.state().niko.y, start.y - 1);
  const tick = engine.state().tick;
  assert.equal((await engine.takeTurn({ type: "free", text: "do a backflip" })).ok, true);
  assert.equal(engine.state().tick, tick + 1); // an unmapped line still advances the world
  const says = (db.prepare("SELECT COUNT(*) c FROM events WHERE type = 'say'").get() as { c: number }).c;
  assert.equal(says, 1);
});

test("free text can start a conversation with a nearby NPC", async () => {
  const { engine, db } = create();
  db.prepare("UPDATE entities SET x = 5, y = 2 WHERE id = 'niko'").run(); // next to Marta at (6,2)
  await engine.start();
  assert.equal((await engine.takeTurn({ type: "free", text: "talk to Marta" })).ok, true);
  const open = (db.prepare("SELECT COUNT(*) c FROM conversations WHERE status = 'open'").get() as { c: number }).c;
  assert.equal(open, 1);
});

test("the interpreter never sees characters from another zone", async () => {
  let seen: InterpretContext | undefined;
  const spy: Interpreter = {
    async interpret(c) { seen = c; return { effects: [{ kind: "wait" }], keywords: [] }; },
  };
  const { engine, db } = create(":memory:", 1337, { interpreter: spy });
  await engine.start();
  db.prepare("UPDATE entities SET x = 5, y = 6 WHERE id = 'ivy'").run(); // in the house, near the bakery entry coords
  db.prepare("UPDATE entities SET zone_id = 'outdoor', x = 6, y = 9 WHERE id = 'niko'").run();
  assert.equal((await engine.takeTurn({ type: "move", dir: "N" })).ok, true); // into the bakery, Niko at (5,7)
  assert.equal((await engine.takeTurn({ type: "free", text: "look around" })).ok, true);
  assert.ok(seen);
  assert.equal(seen!.zone.id, "building_bakery");
  assert.ok(!seen!.visible.some((v) => v.name === "Ivy"), JSON.stringify(seen!.visible));
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

test("the stakes migration applies on a database from the previous version", () => {
  const path = join(mkdtempSync(join(tmpdir(), "niko-mig3-")), "game.db");
  const db1 = openDb(path);
  db1.prepare("INSERT INTO settings (key, value) VALUES ('probe', 'kept')").run();
  db1.exec("DROP TABLE agenda_state; DROP TABLE conversations; DROP TABLE facts_known");
  db1.prepare("DELETE FROM migrations WHERE n = 3").run();
  db1.close();

  const db2 = openDb(path);
  const migrations = (db2.prepare("SELECT n FROM migrations ORDER BY n").all() as { n: number }[]).map((r) => r.n);
  assert.deepEqual(migrations, [1, 2, 3, 4, 5, 6, 7, 8]);
  const tables = (db2.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
    .map((r) => r.name);
  for (const t of ["agenda_state", "conversations", "facts_known"]) assert.ok(tables.includes(t));
  assert.equal((db2.prepare("SELECT value FROM settings WHERE key = 'probe'").get() as { value: string }).value, "kept");
  db2.close();
});

test("the story_summary migration applies on top of a v0.4.0 database and keeps its rows", () => {
  const path = join(mkdtempSync(join(tmpdir(), "niko-mig5-")), "game.db");
  const db1 = openDb(path);
  db1.prepare("INSERT INTO settings (key, value) VALUES ('probe', 'kept')").run();
  db1.prepare("INSERT INTO story_summary (upto_tick, text) VALUES (20, 'old summary')").run();
  db1.exec("DROP TABLE story_summary");
  db1.prepare("DELETE FROM migrations WHERE n = 5").run();
  db1.close();

  const db2 = openDb(path);
  const migrations = (db2.prepare("SELECT n FROM migrations ORDER BY n").all() as { n: number }[]).map((r) => r.n);
  assert.deepEqual(migrations, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((db2.prepare("SELECT COUNT(*) c FROM story_summary").get() as { c: number }).c, 0);
  assert.equal((db2.prepare("SELECT value FROM settings WHERE key = 'probe'").get() as { value: string }).value, "kept");
  db2.close();
});

test("the conversation-participants migration backfills existing rows on a pre-v0.6.0 database", () => {
  const path = join(mkdtempSync(join(tmpdir(), "niko-mig6-")), "game.db");
  const db1 = openDb(path);
  // Recreate the pre-migration shape of `conversations` and forget migration 6 applied it.
  db1.exec("DROP TABLE conversations");
  db1.exec(`CREATE TABLE conversations (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     npc_id       TEXT    NOT NULL,
     goal_id      TEXT    NOT NULL,
     status       TEXT    NOT NULL CHECK (status IN ('open','closed')),
     beat         INTEGER NOT NULL DEFAULT 0,
     started_tick INTEGER NOT NULL
   )`);
  db1.prepare(
    "INSERT INTO conversations (npc_id, goal_id, status, beat, started_tick) VALUES ('marta', 'marta_warn', 'open', 2, 5)",
  ).run();
  db1.prepare("DELETE FROM migrations WHERE n = 6").run();
  db1.close();

  const db2 = openDb(path);
  const migrations = (db2.prepare("SELECT n FROM migrations ORDER BY n").all() as { n: number }[]).map((r) => r.n);
  assert.deepEqual(migrations, [1, 2, 3, 4, 5, 6, 7, 8]);
  const row = db2.prepare("SELECT npc_id, initiator_id, listener_id, beat FROM conversations WHERE id = 1").get() as
    { npc_id: string; initiator_id: string; listener_id: string; beat: number };
  assert.equal(row.npc_id, "marta");
  assert.equal(row.initiator_id, "niko");
  assert.equal(row.listener_id, "marta");
  assert.equal(row.beat, 2); // existing data is untouched
  db2.close();
});

const itemRows = (db: ReturnType<typeof openDb>) =>
  db.prepare("SELECT id, zone_id, x, y, holder_id, hidden FROM items ORDER BY id").all();

test("migration 7 applies on a v0.6.0 database and seeds the items once", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "niko-mig7-")), "game.db");
  const g1 = create(path);
  await g1.engine.start();
  await g1.engine.takeTurn({ type: "wait" });
  // A v0.6.0 save has no items table, no seed marker and a game already under way.
  g1.db.exec("DROP TABLE items");
  g1.db.prepare("DELETE FROM migrations WHERE n = 7").run();
  g1.db.prepare("DELETE FROM settings WHERE key = 'items_seeded'").run();
  g1.db.prepare("INSERT INTO settings (key, value) VALUES ('probe', 'kept')").run();
  g1.db.close();

  const g2 = create(path);
  await g2.engine.start();
  const migrations = (g2.db.prepare("SELECT n FROM migrations ORDER BY n").all() as { n: number }[]).map((r) => r.n);
  assert.deepEqual(migrations, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual((itemRows(g2.db) as { id: string }[]).map((r) => r.id), ["house_key", "letter"]);
  assert.equal(g2.engine.state().tick, 1); // the old game is untouched
  assert.equal((g2.db.prepare("SELECT value FROM settings WHERE key = 'probe'").get() as { value: string }).value, "kept");
  g2.db.close();
});

test("a restart after a take does not put the item back", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "niko-items-")), "game.db");
  const g1 = create(path);
  g1.db.prepare("UPDATE entities SET x = 6, y = 4 WHERE id = 'niko'").run();
  await g1.engine.start();
  assert.equal((await g1.engine.takeTurn({ type: "item", verb: "take", target: "letter" })).ok, true);
  g1.db.close();

  const g2 = create(path);
  await g2.engine.start();
  assert.deepEqual(g2.engine.state().inventory.map((i) => i.id), ["letter"]);
  assert.equal((g2.db.prepare("SELECT COUNT(*) c FROM items WHERE id = 'letter'").get() as { c: number }).c, 1);
  assert.ok(!g2.engine.state().items.some((i) => i.id === "letter"));
  g2.db.close();
});

test("same seed and same actions give the same item state", async () => {
  const run = async () => {
    const g = create();
    g.db.prepare("UPDATE entities SET x = 7, y = 8 WHERE id = 'niko'").run();
    await g.engine.start();
    await g.engine.takeTurn({ type: "item", verb: "search", target: "wardrobe" });
    await g.engine.takeTurn({ type: "item", verb: "take", target: "house_key" });
    await g.engine.takeTurn({ type: "move", dir: "N" });
    await g.engine.takeTurn({ type: "item", verb: "drop", target: "house_key" });
    return { items: itemRows(g.db), state: g.engine.state() };
  };
  const a = await run(), b = await run();
  assert.deepEqual(a.items, b.items);
  assert.deepEqual(a.state.items, b.state.items);
  assert.deepEqual(a.state.inventory, b.state.inventory);
});

test("a reset plants the items again", async () => {
  const g = create();
  g.db.prepare("UPDATE entities SET x = 6, y = 4 WHERE id = 'niko'").run();
  await g.engine.start();
  await g.engine.takeTurn({ type: "item", verb: "take", target: "letter" });
  await g.reset();
  assert.deepEqual((itemRows(g.db) as { id: string; holder_id: string | null }[]).map((r) => [r.id, r.holder_id]), [["house_key", null], ["letter", null]]);
});
