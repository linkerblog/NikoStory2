import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import type { Bearing } from "../src/cast.js";
import { publicData } from "../src/combat.js";
import type { Db } from "../src/db.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));

const BEARINGS: Record<string, Bearing> = {
  shadow: { id: "shadow", mode: "follow", range: 2, leash: 12, prob: 1, word: "stays a step or two behind Niko" },
  trailing: { id: "trailing", mode: "follow", range: 4, leash: 8, prob: 0.6, word: "trails a few steps behind Niko" },
  lingers: { id: "lingers", mode: "linger", range: 2, leash: 3, prob: 1, word: "stays around without following" },
  stays: { id: "stays", mode: "stay", range: 1, leash: 1, prob: 0, word: "does not follow Niko" },
};

// The authored game past the fall, with Marta as the only other person in the house and no routine of her
// own, so what she does is down to her bearing.
function setup(bearing: Bearing | null, agenda: "none" | "done" | "arrived" = "done") {
  const g = createGame(":memory:", DATA, 1337, () => offlineServices());
  g.db.prepare("UPDATE settings SET value = 'play' WHERE key = 'phase'").run();
  g.db.prepare("DELETE FROM entities WHERE id = 'ivy'").run();
  const row = g.db.prepare("SELECT data FROM entities WHERE id = 'marta'").get() as { data: string };
  const data = JSON.parse(row.data);
  data.routine = { type: "wander", prob: 0 };
  if (bearing) data.bearing = bearing; else delete data.bearing;
  if (agenda === "none") delete data.agenda;
  g.db.prepare("UPDATE entities SET data = ? WHERE id = 'marta'").run(JSON.stringify(data));
  if (agenda !== "none") {
    g.db.prepare("INSERT OR REPLACE INTO agenda_state (character_id, goal_id, status, since_tick) VALUES ('marta', 'marta_warn', ?, 0)").run(agenda);
  }
  return g;
}

const at = (db: Db, id: string) => db.prepare("SELECT zone_id, x, y, data FROM entities WHERE id = ?").get(id) as
  { zone_id: string; x: number; y: number; data: string };
const put = (db: Db, id: string, x: number, y: number, zone?: string) =>
  db.prepare("UPDATE entities SET x = ?, y = ?, zone_id = COALESCE(?, zone_id) WHERE id = ?").run(x, y, zone ?? null, id);
const gap = (db: Db) => {
  const m = at(db, "marta"), n = at(db, "niko");
  return Math.max(Math.abs(m.x - n.x), Math.abs(m.y - n.y));
};
const wait = async (g: ReturnType<typeof setup>, n: number) => { for (let i = 0; i < n; i++) await g.engine.takeTurn({ type: "wait" }); };

test("a shadow closes the gap to Niko across the house and keeps it", async () => {
  const g = setup(BEARINGS.shadow);
  await g.engine.start();
  put(g.db, "niko", 1, 13); // Marta stands at (6,2): the far end of the house
  assert.ok(gap(g.db) > 8);
  await wait(g, 24);
  assert.ok(gap(g.db) <= 2, `gap ${gap(g.db)}`);
  const closed = gap(g.db);
  await wait(g, 6);
  assert.ok(gap(g.db) <= 2 && gap(g.db) >= 1, `it keeps its distance, gap ${closed} then ${gap(g.db)}`);
  // Every step was an ordinary move event with a direction, so nobody walked through a wall.
  const moves = g.db.prepare("SELECT data FROM events WHERE type = 'move' AND actor_id = 'marta'").all() as { data: string }[];
  assert.ok(moves.length > 5 && moves.every((m) => ["N", "S", "E", "W"].includes(JSON.parse(m.data).dir)));
});

test("a character that stays, or has no bearing, does not follow", async () => {
  for (const bearing of [BEARINGS.stays, null]) {
    const g = setup(bearing);
    await g.engine.start();
    put(g.db, "niko", 1, 13);
    const before = at(g.db, "marta");
    await wait(g, 12);
    assert.deepEqual([at(g.db, "marta").x, at(g.db, "marta").y], [before.x, before.y], bearing?.id ?? "legacy");
  }
});

test("a character that lingers closes in when Niko is within its leash and ignores him beyond it", async () => {
  const g = setup(BEARINGS.lingers);
  await g.engine.start();
  put(g.db, "marta", 6, 2);
  put(g.db, "niko", 1, 13); // far beyond a leash of three
  await wait(g, 8);
  assert.deepEqual([at(g.db, "marta").x, at(g.db, "marta").y], [6, 2]);
  put(g.db, "niko", 6, 5); // three tiles away, inside the leash
  assert.equal(gap(g.db), 3);
  await wait(g, 6);
  assert.ok(gap(g.db) <= 2, `gap ${gap(g.db)}`);
});

test("the same seed and the same turns give the same following", async () => {
  const run = async () => {
    const g = setup(BEARINGS.trailing);
    await g.engine.start();
    put(g.db, "niko", 2, 12);
    await wait(g, 20);
    return { marta: at(g.db, "marta"), events: g.db.prepare("SELECT type, actor_id, x, y FROM events ORDER BY id").all() };
  };
  assert.deepEqual(await run(), await run());
});

test("someone who was waiting to speak to Niko takes the chase up again when he walks off", async () => {
  const g = setup(BEARINGS.shadow, "arrived");
  await g.engine.start();
  put(g.db, "marta", 6, 2);
  put(g.db, "niko", 2, 12);
  await wait(g, 2);
  assert.equal((g.db.prepare("SELECT status FROM agenda_state WHERE character_id = 'marta'").get() as { status: string }).status, "active");
  await wait(g, 26);
  assert.ok(gap(g.db) <= 1, `she caught up, gap ${gap(g.db)}`);

  // Without a bearing the old behaviour stands: she waits where she is.
  const old = setup(null, "arrived");
  await old.engine.start();
  put(old.db, "marta", 6, 2);
  put(old.db, "niko", 2, 12);
  await wait(old, 6);
  assert.equal((old.db.prepare("SELECT status FROM agenda_state WHERE character_id = 'marta'").get() as { status: string }).status, "arrived");
  assert.deepEqual([at(old.db, "marta").x, at(old.db, "marta").y], [6, 2]);
});

// --- through a door -------------------------------------------------------------------------------

const out = async (g: ReturnType<typeof setup>) => {
  put(g.db, "niko", 5, 13); // just inside the front door
  assert.equal((await g.engine.takeTurn({ type: "move", dir: "S" })).ok, true);
  assert.equal(g.engine.zone.id, "outdoor");
};

test("a follower walks to the door and comes through after Niko, arriving beside it", async () => {
  const g = setup(BEARINGS.shadow);
  await g.engine.start();
  put(g.db, "marta", 5, 10); // three tiles from the door
  await out(g);

  // The mark is on her, hidden from every prompt, and she is still inside while she walks to the door.
  const marked = JSON.parse(at(g.db, "marta").data);
  assert.equal(marked.trail.to, "outdoor");
  assert.equal(at(g.db, "marta").zone_id, "house_001");
  assert.equal("trail" in publicData(marked), false);

  await wait(g, 2);
  assert.equal(at(g.db, "marta").zone_id, "house_001", "she has not got there yet");
  await wait(g, 4);
  const m = at(g.db, "marta");
  assert.equal(m.zone_id, "outdoor");
  assert.equal("trail" in JSON.parse(m.data), false, "the mark is spent");
  assert.ok(gap(g.db) <= 3, `she arrives behind him, gap ${gap(g.db)}`);
  const enter = g.db.prepare("SELECT data FROM events WHERE type = 'enter' AND actor_id = 'marta'").get() as { data: string };
  assert.deepEqual([JSON.parse(enter.data).from, JSON.parse(enter.data).to], ["house_001", "outdoor"]);

  // On the street she keeps following like anyone with a shadow's bearing.
  put(g.db, "niko", 13, 36);
  await wait(g, 20);
  assert.ok(gap(g.db) <= 2, `gap ${gap(g.db)}`);
});

test("a follower lands on a free tile when Niko stands where she would arrive", async () => {
  const g = setup(BEARINGS.shadow);
  await g.engine.start();
  put(g.db, "marta", 5, 12);
  await out(g);
  await wait(g, 4);
  const m = at(g.db, "marta"), n = at(g.db, "niko");
  assert.equal(m.zone_id, "outdoor");
  assert.notDeepEqual([m.x, m.y], [n.x, n.y]);
  assert.ok(Math.max(Math.abs(m.x - n.x), Math.abs(m.y - n.y)) <= 3);
});

test("the mark is dropped when Niko does not stay where she was heading", async () => {
  const g = setup(BEARINGS.shadow);
  await g.engine.start();
  put(g.db, "marta", 4, 8); // a few tiles from the door, so she is still walking when he turns back
  await out(g);
  assert.ok(JSON.parse(at(g.db, "marta").data).trail);
  // Back inside before she arrives: she is in the house with him, and nothing is left on her.
  const back = await g.engine.takeTurn({ type: "move", dir: "N" });
  assert.equal(back.ok, true);
  assert.equal(g.engine.zone.id, "house_001");
  await wait(g, 8);
  assert.equal(at(g.db, "marta").zone_id, "house_001");
  assert.equal("trail" in JSON.parse(at(g.db, "marta").data), false);
});

test("a character that lingers, stays or is too far never follows through a door", async () => {
  // The trailing bearing has a leash of eight: (5,3) is ten tiles from the door Niko takes, so she is out of reach.
  for (const [bearing, spot] of [[BEARINGS.lingers, [5, 12]], [BEARINGS.stays, [5, 12]], [BEARINGS.trailing, [5, 3]]] as const) {
    const g = setup(bearing);
    await g.engine.start();
    put(g.db, "marta", spot[0], spot[1]);
    await out(g);
    await wait(g, 14);
    assert.equal(at(g.db, "marta").zone_id, "house_001", bearing.id);
    assert.equal("trail" in JSON.parse(at(g.db, "marta").data), false, bearing.id);
  }
});

test("a responder, which has no bearing, is never marked", async () => {
  const g = setup(null);
  await g.engine.start();
  put(g.db, "marta", 5, 12);
  await out(g);
  await wait(g, 6);
  assert.equal(at(g.db, "marta").zone_id, "house_001");
});
