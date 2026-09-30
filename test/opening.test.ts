import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame } from "../src/game.js";
import { canSee, type Action, type Engine, type FallChoice } from "../src/engine.js";
import type { Db } from "../src/db.js";
import { OfflineNarrator, hasTileCount } from "../src/narrator.js";
import { loadOpening, loadZone } from "../src/world.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));

const create = (path = ":memory:", seed = 1337) =>
  createGame(path, DATA, seed, () => new OfflineNarrator());

const fall = (choice: FallChoice): Action => ({ type: "fall", choice });
const meta = (db: Db, key: string) =>
  (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
const count = (db: Db, table: string) =>
  (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
const playFall = async (engine: Engine, choices: FallChoice[]) => {
  for (const choice of choices) assert.equal((await engine.takeTurn(fall(choice))).ok, true);
};

test("a new game opens in the fall, tick 0, with only fall actions", async () => {
  const { engine } = create();
  await engine.start();
  const s = engine.state();
  assert.equal(s.phase, "fall");
  assert.equal(s.tick, 0);
  assert.ok(s.options.length >= 2);
  assert.ok(s.options.every((o) => o.action.type === "fall"));
  assert.equal(s.fall?.beats, 3);
  assert.equal(hasTileCount(s.log[0].text), false); // "high above the clouds", no numbers
});

test("non-fall actions during the fall are rejected and change nothing", async () => {
  const { engine, db } = create();
  await engine.start();
  const tick = engine.state().tick;
  const positions = engine.positions();
  const memories = count(db, "memories");
  const r = await engine.takeTurn({ type: "wait" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /still falling/);
  assert.equal(engine.state().tick, tick);
  assert.deepEqual(engine.positions(), positions);
  assert.equal(count(db, "memories"), memories);
});

test("brace needs its Ether, is rejected if forced and spends exactly its cost", async () => {
  const { engine, db } = create();
  await engine.start();
  const braced = (s: ReturnType<Engine["state"]>) =>
    s.options.some((o) => o.action.type === "fall" && o.action.choice === "brace");
  assert.ok(braced(engine.state())); // starts with 3 Ether, the cost is 2

  await engine.takeTurn(fall("brace"));
  assert.equal(engine.state().niko.ether, 1); // 3 - 2, no regen during the fall

  assert.ok(!braced(engine.state())); // now below cost: hidden
  const beat = meta(db, "fall_beat");
  const r = await engine.takeTurn(fall("brace"));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Ether/);
  assert.equal(engine.state().niko.ether, 1);
  assert.equal(meta(db, "fall_beat"), beat); // a rejected brace does not advance the beat
});

test("the same seed and choices land on the same tile; steer lands in the configured room", async () => {
  const a = create(":memory:", 42), b = create(":memory:", 42);
  for (const g of [a, b]) {
    await g.engine.start();
    await playFall(g.engine, ["steer", "brace", "steer"]);
  }
  assert.deepEqual(a.engine.positions(), b.engine.positions());
  const s = a.engine.state();
  assert.equal(s.phase, "play");
  assert.equal(s.room, "Living Room");
});

test("the landing is recorded once, with witnesses and importance-9 memories", async () => {
  const { engine, db } = create();
  await engine.start();
  await playFall(engine, ["steer", "brace"]);
  const before = engine.positions(); // NPCs still at their start: the fall does not advance the world
  await engine.takeTurn(fall("let_go"));
  const landing = engine.positions().niko;

  const events = db.prepare("SELECT id, x, y, data FROM events WHERE type = 'arrives'").all() as
    { id: number; x: number; y: number; data: string }[];
  assert.equal(events.length, 1);
  assert.equal(landing[0], events[0].x);
  assert.equal(landing[1], events[0].y);
  assert.equal((JSON.parse(events[0].data) as { impact: string }).impact, "soft");

  // Witnesses are those who could see the tile at the moment of the landing: Niko plus the NPCs
  // where they stood before the world step moved them.
  const atLanding = [
    { id: "niko", x: landing[0], y: landing[1] },
    { id: "marta", x: before.marta[0], y: before.marta[1] },
    { id: "ivy", x: before.ivy[0], y: before.ivy[1] },
  ];
  const expected = atLanding.filter((e) => canSee(engine.zone, e, { x: landing[0], y: landing[1] }))
    .map((e) => e.id).sort();
  const stored = (db.prepare("SELECT character_id FROM witnesses WHERE event_id = ? ORDER BY character_id")
    .all(events[0].id) as { character_id: string }[]).map((r) => r.character_id);
  assert.deepEqual(stored, expected);
  assert.ok(stored.includes("niko"));

  const memories = db.prepare("SELECT character_id, importance FROM memories WHERE event_id = ? ORDER BY character_id")
    .all(events[0].id) as { character_id: string; importance: number }[];
  assert.deepEqual(memories.map((m) => m.character_id), stored);
  for (const m of memories) assert.equal(m.importance, 9);
});

test("after landing the world is play, at tick 1, and the NPC agendas run", async () => {
  const { engine, db } = create();
  await engine.start();
  await playFall(engine, ["steer", "brace", "let_go"]);
  const s = engine.state();
  assert.equal(s.phase, "play");
  assert.equal(s.tick, 1);
  const rows = db.prepare("SELECT character_id FROM agenda_state ORDER BY character_id").all() as { character_id: string }[];
  assert.deepEqual(rows.map((r) => r.character_id), ["ivy", "marta"]);
});

test("a hard landing zeroes the Ether that the landing step then regenerates", async () => {
  const { engine } = create();
  await engine.start();
  await playFall(engine, ["steer", "let_go", "steer"]); // never braces: hard impact
  assert.equal(engine.state().niko.ether, 1); // 0 at impact, +1 regen for the landing tick
});

test("a save without a phase (v0.2.0) behaves as play", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "niko-open-")), "game.db");
  const raw = () => createGame(path, DATA, 1337, () => new OfflineNarrator());
  const g1 = raw();
  await g1.engine.start();
  await playFall(g1.engine, ["steer", "brace", "steer"]);
  g1.db.prepare("DELETE FROM settings WHERE key = 'phase'").run();
  g1.db.close();

  const g2 = raw();
  assert.equal(meta(g2.db, "phase"), undefined);
  await g2.engine.start(); // does not repeat the opening
  assert.equal(g2.engine.state().phase, "play");
  assert.equal((await g2.engine.takeTurn({ type: "wait" })).ok, true);
  g2.db.close();
});

test("a malformed opening.json is rejected on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "niko-open-data-"));
  const zone = loadZone(DATA);
  const write = (o: unknown) => writeFileSync(join(dir, "opening.json"), JSON.stringify(o));
  const base = { beats: [{ altitude: "x" }], abilities: { brace: { ether_cost: 2 } }, landing: { steer_room: "living_room" } };

  write({ ...base, beats: [] });
  assert.throws(() => loadOpening(dir, zone), /at least one beat/);
  write({ ...base, abilities: { brace: { ether_cost: -1 } } });
  assert.throws(() => loadOpening(dir, zone), /non-negative/);
  write({ ...base, landing: { steer_room: "nowhere" } });
  assert.throws(() => loadOpening(dir, zone), /not in zone/);

  write(base);
  assert.equal(loadOpening(dir, zone).beats.length, 1);
});
