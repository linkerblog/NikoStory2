import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame } from "../src/game.js";
import { openDb, type Db } from "../src/db.js";
import { OfflineNarrator } from "../src/narrator.js";
import {
  DEFAULT_MEMORY_RULES, loadMemoryRules, memoryFromEvent, recall, type MemoryEvent,
} from "../src/memory.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
// Skips the opening: a legacy save without a `phase` plays as `play`. The fall is in `opening.test.ts`.
const create = (path = ":memory:", seed = 1337) => {
  const g = createGame(path, DATA, seed, () => new OfflineNarrator());
  g.db.prepare("UPDATE settings SET value = 'play' WHERE key = 'phase'").run();
  return g;
};

const dump = (db: Db) =>
  db.prepare(
    "SELECT character_id, event_id, tick, zone_id, text, importance, participants FROM memories ORDER BY id",
  ).all();

test("the memories migration applies on an older schema and keeps existing rows", () => {
  const path = join(mkdtempSync(join(tmpdir(), "niko-mem-")), "game.db");
  const db1 = openDb(path);
  db1.prepare("INSERT INTO settings (key, value) VALUES ('probe', 'kept')").run();
  db1.exec("DROP TABLE memories"); // rewind to the previous schema version
  db1.prepare("DELETE FROM migrations WHERE n = 2").run();
  db1.close();

  const db2 = openDb(path);
  const migrations = (db2.prepare("SELECT n FROM migrations ORDER BY n").all() as { n: number }[]).map((r) => r.n);
  assert.deepEqual(migrations, [1, 2, 3, 4]);
  assert.equal((db2.prepare("SELECT COUNT(*) c FROM memories").get() as { c: number }).c, 0);
  assert.equal((db2.prepare("SELECT value FROM settings WHERE key = 'probe'").get() as { value: string }).value, "kept");
  db2.close();
});

test("only the witnesses of an event get a memory of it", async () => {
  const { engine, db } = create();
  await engine.start();
  for (let i = 0; i < 30; i++) await engine.takeTurn({ type: "wait" });

  const events = db.prepare(
    `SELECT e.id AS event_id, GROUP_CONCAT(w.character_id) AS who
     FROM events e JOIN witnesses w ON w.event_id = e.id GROUP BY e.id`,
  ).all() as { event_id: number; who: string }[];
  assert.ok(events.length > 0);
  for (const e of events) {
    const holders = (db.prepare("SELECT character_id FROM memories WHERE event_id = ? ORDER BY character_id")
      .all(e.event_id) as { character_id: string }[]).map((r) => r.character_id);
    assert.deepEqual(holders, e.who.split(",").sort());
  }
  // Events without witnesses (the narration) never become memories.
  const narration = db.prepare(
    "SELECT COUNT(*) c FROM memories WHERE event_id IN (SELECT id FROM events WHERE type = 'narration')",
  ).get() as { c: number };
  assert.equal(narration.c, 0);
});

test("a character that did not witness an event has no memory of it", async () => {
  const { engine, db } = create();
  await engine.start();
  db.prepare("UPDATE entities SET x = 1, y = 1 WHERE id = 'marta'").run(); // far and out of sight
  await engine.takeTurn({ type: "wait" });

  const event = db.prepare("SELECT id FROM events WHERE type = 'wait' ORDER BY id DESC LIMIT 1").get() as { id: number };
  const witnesses = (db.prepare("SELECT character_id FROM witnesses WHERE event_id = ?").all(event.id) as
    { character_id: string }[]).map((r) => r.character_id);
  assert.ok(!witnesses.includes("marta"));
  const marta = db.prepare("SELECT COUNT(*) c FROM memories WHERE event_id = ? AND character_id = 'marta'")
    .get(event.id) as { c: number };
  assert.equal(marta.c, 0);
});

test("same seed and commands produce identical memories", async () => {
  const a = create(":memory:", 42), b = create(":memory:", 42);
  for (const g of [a, b]) {
    await g.engine.start();
    for (let i = 0; i < 40; i++) await g.engine.takeTurn({ type: "wait" });
  }
  assert.deepEqual(dump(a.db), dump(b.db));
});

test("each character's memory count equals the events they witnessed", async () => {
  const { engine, db } = create();
  await engine.start();
  for (let i = 0; i < 30; i++) await engine.takeTurn({ type: "wait" });
  const memories = db.prepare(
    "SELECT character_id, COUNT(*) c FROM memories GROUP BY character_id ORDER BY character_id",
  ).all();
  const witnesses = db.prepare(
    "SELECT character_id, COUNT(*) c FROM witnesses GROUP BY character_id ORDER BY character_id",
  ).all();
  assert.deepEqual(memories, witnesses);
});

test("recall orders by score, breaks ties by higher id and respects the limit", () => {
  const db = openDb(":memory:");
  const addEvent = db.prepare("INSERT INTO events (tick, zone_id, type, data) VALUES (?, ?, ?, ?)");
  const addMemory = db.prepare(
    `INSERT INTO memories (character_id, event_id, tick, zone_id, text, importance, participants)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const ev = (tick: number, importance: number, text: string, zone = "house_001", participants: string[] = []) => {
    const eventId = Number(addEvent.run(tick, zone, "wait", "{}").lastInsertRowid);
    return Number(
      addMemory.run("niko", eventId, tick, zone, text, importance, JSON.stringify(participants)).lastInsertRowid,
    );
  };

  const oldLow = ev(0, 1, "long ago");
  const recent = ev(100, 10, "just now");
  const tieA = ev(50, 5, "tie a");
  const tieB = ev(50, 5, "tie b");

  const query = { characterId: "niko", tick: 100, zoneId: "house_001", presentCharacters: [] };
  const all = recall(db, "niko", query, 10, DEFAULT_MEMORY_RULES);
  assert.equal(all.length, 4);
  assert.equal(all[0].id, recent);
  assert.deepEqual(all.filter((m) => m.tick === 50).map((m) => m.id), [tieB, tieA]);
  assert.equal(all.at(-1)!.id, oldLow);

  const limited = recall(db, "niko", query, 2, DEFAULT_MEMORY_RULES);
  assert.deepEqual(limited, all.slice(0, 2));
  assert.deepEqual(recall(db, "nobody", query, 10, DEFAULT_MEMORY_RULES), []);
});

test("recall rewards memories that share a participant with the characters present", () => {
  const db = openDb(":memory:");
  const addEvent = db.prepare("INSERT INTO events (tick, zone_id, type, data) VALUES (?, ?, ?, ?)");
  const addMemory = db.prepare(
    `INSERT INTO memories (character_id, event_id, tick, zone_id, text, importance, participants)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const ev = (text: string, participants: string[]) => {
    const eventId = Number(addEvent.run(10, "house_001", "wait", "{}").lastInsertRowid);
    return Number(addMemory.run("niko", eventId, 10, "house_001", text, 5, JSON.stringify(participants)).lastInsertRowid);
  };
  const alone = ev("Niko waited alone", ["niko"]);
  const withMarta = ev("Niko talked to Marta", ["niko", "marta"]);
  const ranked = recall(db, "niko", { characterId: "niko", tick: 10, zoneId: "house_001", presentCharacters: ["marta"] }, 10);
  assert.deepEqual(ranked.map((m) => m.id), [withMarta, alone]);
});

test("an unknown event kind gets the default importance and still creates a memory", () => {
  const event: MemoryEvent = {
    id: 1, tick: 3, zone_id: "z", type: "portal", actor_id: "niko", x: 0, y: 0,
    data: {}, names: { niko: "Niko" }, witnesses: ["niko"],
  };
  const m = memoryFromEvent(event, "niko", DEFAULT_MEMORY_RULES);
  assert.equal(m.importance, DEFAULT_MEMORY_RULES.defaultImportance);
  assert.equal(m.character_id, "niko");
  assert.match(m.text, /Niko/);
});

test("the rules load from data and keep the provisional defaults", () => {
  const rules = loadMemoryRules(DATA);
  assert.equal(rules.recall.promptMaxItems, 8);
  assert.equal(rules.recall.promptMaxChars, 1200);
  assert.equal(rules.recall.halfLifeTicks, 50);
  assert.ok(rules.importance.talk >= rules.importance.move);
});

test("a talked event creates memories only for its witnesses (Dev-002 regression)", async () => {
  const { engine, db } = create();
  db.prepare("UPDATE entities SET x = 5, y = 2 WHERE id = 'niko'").run(); // next to Marta
  await engine.start();
  await engine.takeTurn({ type: "talk", target: "marta" });
  for (let i = 0; i < 4; i++) await engine.takeTurn({ type: "reply", target: "marta", choice: "ask" });

  const event = db.prepare("SELECT id FROM events WHERE type = 'talked' ORDER BY id DESC LIMIT 1").get() as { id: number };
  assert.ok(event);
  const holders = (
    db.prepare("SELECT character_id FROM memories WHERE event_id = ? ORDER BY character_id").all(event.id) as
      { character_id: string }[]
  ).map((r) => r.character_id);
  const witnesses = (
    db.prepare("SELECT character_id FROM witnesses WHERE event_id = ? ORDER BY character_id").all(event.id) as
      { character_id: string }[]
  ).map((r) => r.character_id);
  assert.ok(witnesses.includes("niko"));
  assert.deepEqual(holders, witnesses);

  const memory = db.prepare("SELECT importance, text FROM memories WHERE event_id = ? AND character_id = 'niko'")
    .get(event.id) as { importance: number; text: string };
  assert.equal(memory.importance, 7);
  assert.match(memory.text, /talked with Marta/);
});
