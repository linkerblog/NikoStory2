import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createGame } from "../src/game.js";
import { OfflineNarrator, type Narrator } from "../src/narrator.js";
import type { Db } from "../src/db.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));

// Skips the opening: a legacy save without a `phase` plays as `play`. The fall is in `opening.test.ts`.
const create = (narrator: Narrator = new OfflineNarrator()) => {
  const g = createGame(":memory:", DATA, 1337, () => narrator);
  g.db.prepare("UPDATE settings SET value = 'play' WHERE key = 'phase'").run();
  return g;
};

// Niko at (5,2) is next to Marta at (6,2), so the first `talk` has a valid target.
const setup = async (narrator: Narrator = new OfflineNarrator()) => {
  const g = create(narrator);
  g.db.prepare("UPDATE entities SET x = 5, y = 2 WHERE id = 'niko'").run();
  await g.engine.start();
  return g;
};

const open = (db: Db) => (db.prepare("SELECT COUNT(*) c FROM conversations WHERE status = 'open'").get() as { c: number }).c;
const status = (db: Db, id: string) =>
  (db.prepare("SELECT status FROM agenda_state WHERE character_id = ?").get(id) as { status: string } | undefined)?.status;
const facts = (db: Db, id: string) =>
  (db.prepare("SELECT COUNT(*) c FROM facts_known WHERE character_id = 'niko' AND fact_id = ?").get(id) as { c: number }).c;

test("talk is refused when there is nobody adjacent", async () => {
  const { engine } = create();
  await engine.start();
  const r = await engine.takeTurn({ type: "talk", target: "marta" });
  assert.equal(r.ok, false);
  assert.equal(engine.state().tick, 0);
});

test("reply and leave are refused without an open conversation", async () => {
  const { engine } = await setup();
  assert.equal((await engine.takeTurn({ type: "reply", target: "marta", choice: "ask" })).ok, false);
  assert.equal((await engine.takeTurn({ type: "leave", target: "marta" })).ok, false);
});

test("a conversation is played, closed by the engine and delivers its fact once", async () => {
  const { engine, db } = await setup();
  assert.equal((await engine.takeTurn({ type: "talk", target: "marta" })).ok, true);
  assert.equal(open(db), 1);

  for (let i = 0; i < 4; i++) {
    const r = await engine.takeTurn({ type: "reply", target: "marta", choice: "ask" });
    assert.equal(r.ok, true);
  }
  assert.equal(open(db), 0);
  assert.equal(status(db, "marta"), "done");
  assert.equal(facts(db, "fact_marta_warning"), 1);
  assert.ok(engine.state().log.some((l) => l.text.includes("Marta"))); // the conversation is on screen

  // Reopening and closing again must not store the fact twice.
  await engine.takeTurn({ type: "talk", target: "marta" });
  await engine.takeTurn({ type: "leave", target: "marta" });
  assert.equal(facts(db, "fact_marta_warning"), 1);
});

test("leaving closes the conversation immediately", async () => {
  const { engine, db } = await setup();
  await engine.takeTurn({ type: "talk", target: "marta" });
  const r = await engine.takeTurn({ type: "leave", target: "marta" });
  assert.equal(r.ok, true);
  assert.equal(open(db), 0);
});

test("movement is refused while the conversation is open", async () => {
  const { engine } = await setup();
  await engine.takeTurn({ type: "talk", target: "marta" });
  const r = await engine.takeTurn({ type: "move", dir: "N" });
  assert.equal(r.ok, false);
});

test("the engine discards conversation options the narrator invented", async () => {
  const liar: Narrator = { async narrate() { return { text: "x", options: [{ id: "nope", text: "Nope" }] }; } };
  const { engine } = await setup(liar);
  await engine.takeTurn({ type: "talk", target: "marta" });
  const texts = engine.state().options.map((o) => o.text);
  assert.ok(!texts.includes("Nope"));
  assert.ok(engine.state().options.some((o) => o.action.type === "reply"));
});

test("the engine injects talk for a waiting NPC the narrator ignored", async () => {
  const liar: Narrator = { async narrate() { return { text: "x", options: [{ id: "nope", text: "Nope" }] }; } };
  const g = create(liar);
  g.db.prepare("UPDATE entities SET x = 5, y = 2 WHERE id = 'niko'").run();
  g.db.prepare("INSERT INTO agenda_state (character_id, goal_id, status, since_tick) VALUES ('marta', 'marta_warn', 'arrived', 0)").run();
  await g.engine.start();
  assert.ok(g.engine.state().options.some((o) => o.action.type === "talk"));
});
