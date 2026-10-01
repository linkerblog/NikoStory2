import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import { canSee, fallIntent, type Action, type Engine } from "../src/engine.js";
import type { Db } from "../src/db.js";
import { hasTileCount } from "../src/narrator.js";
import { loadOpening, loadZone } from "../src/world.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));

const create = (path = ":memory:", seed = 1337) =>
  createGame(path, DATA, seed, () => offlineServices());

const fall = (text: string): Action => ({ type: "fall", text });
const STEER = "spread my arms and steer toward the houses";
const BRACE = "brace for the impact";
const LET_GO = "let go and fall";
const meta = (db: Db, key: string) =>
  (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
const count = (db: Db, table: string) =>
  (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
const playFall = async (engine: Engine, texts: string[]) => {
  for (const text of texts) assert.equal((await engine.takeTurn(fall(text))).ok, true);
};

test("a new game opens in the fall, tick 0, with free text and no preset options", async () => {
  const { engine } = create();
  await engine.start();
  const s = engine.state();
  assert.equal(s.phase, "fall");
  assert.equal(s.tick, 0);
  assert.ok(!("options" in s)); // free text: the engine never sends an option list
  assert.equal(s.fall?.beats, 3);
  assert.equal(hasTileCount(s.log[0].text), false); // "high above the clouds", no numbers
});

test("an empty fall action is rejected and changes nothing", async () => {
  const { engine, db } = create();
  await engine.start();
  const beat = meta(db, "fall_beat");
  const r = await engine.takeTurn(fall("   "));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /what Niko does/i);
  assert.equal(meta(db, "fall_beat"), beat);
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

test("a brace spends its Ether only when there is enough, the text only proposes", async () => {
  const { engine, db } = create();
  await engine.start(); // 3 Ether, the brace costs 2
  await engine.takeTurn(fall(BRACE));
  assert.equal(engine.state().niko.ether, 1); // 3 - 2, no regen during the fall

  const beat = meta(db, "fall_beat");
  const r = await engine.takeTurn(fall(BRACE)); // only 1 Ether left: the brace simply fails
  assert.equal(r.ok, true);
  assert.equal(engine.state().niko.ether, 1); // no spend
  assert.equal(meta(db, "fall_beat"), String(Number(beat) + 1)); // the turn still advances
});

test("fallIntent reads steer and brace from free text", () => {
  assert.deepEqual(fallIntent("steer toward the rooftops"), { steer: true, brace: false });
  assert.deepEqual(fallIntent("brace for the impact"), { steer: false, brace: true });
  assert.deepEqual(fallIntent("let go and fall"), { steer: false, brace: false });
  assert.deepEqual(fallIntent("brace and steer over the houses"), { steer: true, brace: true });
});

test("the same seed and choices land on the same tile; steer lands in the configured room", async () => {
  const a = create(":memory:", 42), b = create(":memory:", 42);
  for (const g of [a, b]) {
    await g.engine.start();
    await playFall(g.engine, [STEER, BRACE, STEER]);
  }
  assert.deepEqual(a.engine.positions(), b.engine.positions());
  const s = a.engine.state();
  assert.equal(s.phase, "play");
  assert.equal(s.room, "Living Room");
});

test("the landing is recorded once, with witnesses and importance-9 memories", async () => {
  const { engine, db } = create();
  await engine.start();
  await playFall(engine, [STEER, BRACE]);
  const before = engine.positions(); // NPCs still at their start: the fall does not advance the world
  await engine.takeTurn(fall(LET_GO));
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
  await playFall(engine, [STEER, BRACE, LET_GO]);
  const s = engine.state();
  assert.equal(s.phase, "play");
  assert.equal(s.tick, 1);
  const rows = db.prepare("SELECT character_id FROM agenda_state ORDER BY character_id").all() as { character_id: string }[];
  assert.deepEqual(rows.map((r) => r.character_id), ["ivy", "marta"]);
});

test("a hard landing zeroes the Ether that the landing step then regenerates", async () => {
  const { engine } = create();
  await engine.start();
  await playFall(engine, [STEER, LET_GO, STEER]); // never braces: hard impact
  assert.equal(engine.state().niko.ether, 1); // 0 at impact, +1 regen for the landing tick
});

test("a save without a phase (v0.2.0) behaves as play", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "niko-open-")), "game.db");
  const raw = () => createGame(path, DATA, 1337, () => offlineServices());
  const g1 = raw();
  await g1.engine.start();
  await playFall(g1.engine, [STEER, BRACE, STEER]);
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
  const base = { beats: [{ altitude: "x" }], brace_ability: "brace", landing: { steer_room: "living_room" } };

  write({ ...base, beats: [] });
  assert.throws(() => loadOpening(dir, zone), /at least one beat/);
  write({ ...base, brace_ability: "" });
  assert.throws(() => loadOpening(dir, zone), /brace ability id/);
  write({ ...base, landing: { steer_room: "nowhere" } });
  assert.throws(() => loadOpening(dir, zone), /not in zone/);

  write(base);
  assert.equal(loadOpening(dir, zone).beats.length, 1);
});
