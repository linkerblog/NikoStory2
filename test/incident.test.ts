import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import { generateGovernment, loadGovernmentData, type Government, type GovernmentRequest } from "../src/government.js";
import { DEFAULT_INCIDENTS } from "../src/rules.js";
import { setMeta, type Db } from "../src/db.js";
import type { Action, Engine } from "../src/engine.js";
import type { Context } from "../src/narrator.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const govData = loadGovernmentData(DATA, DEFAULT_INCIDENTS.government);

// A copy of `data/` whose incident rules are patched, so a test can make the report certain or impossible.
function dataWith(patch: object): string {
  const dir = mkdtempSync(join(tmpdir(), "niko-incident-"));
  cpSync(DATA, dir, { recursive: true });
  const rules = JSON.parse(readFileSync(join(dir, "rules.json"), "utf-8"));
  rules.incidents = { ...rules.incidents, ...patch };
  writeFileSync(join(dir, "rules.json"), JSON.stringify(rules));
  return dir;
}

const fall = (text: string): Action => ({ type: "fall", text });
const STEER = "spread my arms and steer toward the houses";
const BRACE = "brace for the impact";
const LET_GO = "let go and fall";

// Three fall beats ending in the living room; braced or not decides whether the Ether discharge is seen.
async function land(engine: Engine, braced: boolean): Promise<void> {
  await engine.start();
  for (const text of [STEER, braced ? BRACE : LET_GO, STEER]) assert.equal((await engine.takeTurn(fall(text))).ok, true);
}

const step = (over: object = {}) => ({
  institution: "police", after: 3, when: "always", requires: [], units: 1,
  cue: "Sirens rise outside.", want: "{name} came to look into the report.", ...over,
});
const governmentOf = (protocol: object[]): Government => ({
  city: { name: "Test Bay", summary: "A test harbor city for the suite." },
  institutions: [
    { id: "police", name: "Test Bay Police", title: "Officer", tone: "Dry and brief." },
    { id: "feds", name: "Federal Office", title: "Agent", tone: "Calm and quiet." },
  ],
  protocol: protocol as Government["protocol"],
});
const setGovernment = (db: Db, g: Government) => setMeta(db, "government", JSON.stringify(g));

const rows = <T = any>(db: Db, sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
const responders = (db: Db) =>
  rows<{ id: string; name: string; zone_id: string; x: number; y: number; data: string }>(
    db, "SELECT * FROM entities WHERE json_extract(data, '$.role') = 'responder' ORDER BY rowid");
const wait = (engine: Engine) => engine.takeTurn({ type: "wait" });
async function waitUntil(engine: Engine, done: () => boolean, max = 80): Promise<void> {
  for (let i = 0; i < max && !done(); i++) assert.equal((await wait(engine)).ok, true);
  assert.ok(done(), "the condition was never met");
}

// A game with a certain report, a spy on every narration and a government written for the test.
async function setup(protocol: object[], opts: { braced?: boolean; patch?: object; seed?: number } = {}) {
  const seen: Context[] = [];
  const spy = { narrate: async (c: Context) => { seen.push(c); return { text: "Time passes." }; } };
  const g = createGame(":memory:", dataWith({ reportChance: 1, ...opts.patch }), opts.seed ?? 1337, () => ({ ...offlineServices(), narrator: spy }));
  setGovernment(g.db, governmentOf(protocol));
  await land(g.engine, opts.braced ?? false);
  return { ...g, seen };
}

const incidentOf = (g: { engine: Engine }) => g.engine.debug().incidents[0];

test("the landing raises one incident; a brace shows the Ether discharge and the report delay is bounded", async () => {
  for (const braced of [false, true]) {
    const g = await setup([step()], { braced });
    const incidents = g.engine.debug().incidents;
    assert.equal(incidents.length, 1);
    assert.deepEqual(incidents[0].tags, braced ? ["sky_fall", "ether"] : ["sky_fall"]);
    assert.equal(incidents[0].zone_id, g.engine.state().zoneId);
    assert.equal(incidents[0].status, "pending");
    const [report] = rows(g.db, "SELECT * FROM scheduled_events WHERE kind = 'report'");
    const [min, max] = DEFAULT_INCIDENTS.reportDelay;
    assert.ok(report.due_tick >= min && report.due_tick <= max, `due ${report.due_tick}`);
  }
});

test("with no chance to report the incident stays unreported and nobody comes", async () => {
  const g = await setup([step()], { patch: { reportChance: 0 } });
  assert.equal(incidentOf(g).status, "unreported");
  assert.equal(rows(g.db, "SELECT * FROM scheduled_events").length, 0);
  for (let i = 0; i < 60; i++) await wait(g.engine);
  assert.equal(responders(g.db).length, 0);
});

test("a save with no government raises nothing", async () => {
  const g = createGame(":memory:", DATA, 1337, () => offlineServices());
  g.db.prepare("DELETE FROM settings WHERE key = 'government'").run();
  await land(g.engine, false);
  assert.equal(g.engine.debug().incidents.length, 0);
  assert.equal(rows(g.db, "SELECT * FROM scheduled_events").length, 0);
});

test("a responder appears exactly `after` ticks after the report, through the door, as an ordinary NPC", async () => {
  const g = await setup([step({ after: 3 })]);
  await waitUntil(g.engine, () => responders(g.db).length > 0, 40);
  const [unit] = responders(g.db);
  const incident = incidentOf(g);
  assert.equal(incident.status, "reported");

  const [stepRow] = rows(g.db, "SELECT * FROM scheduled_events WHERE kind = 'step'");
  assert.equal(stepRow.due_tick, incident.reported_tick! + 3);
  assert.equal(stepRow.status, "done");
  assert.equal(g.engine.state().tick, stepRow.due_tick); // it did not appear a tick early or late

  const data = JSON.parse(unit.data);
  assert.match(unit.name, /^Officer \p{L}+$/u);
  assert.equal(data.personality, "Officer of Test Bay Police");
  assert.equal(data.voice, "Dry and brief.");
  assert.equal(data.incident, incident.id);
  assert.equal(data.agenda.kind, "approach");
  assert.equal(data.agenda.target, "niko");
  assert.ok(data.agenda.want.startsWith(unit.name), data.agenda.want);

  // It came in through the front door like Niko would: the enter event sits next to the door tile.
  const door = g.engine.zone.portals[0];
  const [enter] = rows(g.db, "SELECT x, y, zone_id FROM events WHERE type = 'enter' AND actor_id = ?", unit.id);
  assert.equal(enter.zone_id, g.engine.zone.id);
  assert.ok(Math.max(Math.abs(enter.x - door.x), Math.abs(enter.y - door.y)) <= 1, `${enter.x},${enter.y} vs ${door.x},${door.y}`);
  assert.equal(g.engine.zone.map[enter.y][enter.x], ".");
});

test("the cue and the city reach the narrator, and the responder is described by who it works for", async () => {
  const g = await setup([step()]);
  await waitUntil(g.engine, () => responders(g.db).length > 0, 40);
  assert.ok(g.seen.some((c) => c.events.includes("Sirens rise outside.")), "the cue is narrated");
  assert.equal(g.seen.at(-1)!.world?.city?.name, "Test Bay");
  // It comes in through the far door and only reaches Niko's field of view as it walks up to him.
  await waitUntil(g.engine, () => g.seen.some((c) => c.visible.some((v) => v.personality === "Officer of Test Bay Police")), 40);
});

test("a responder walks up to Niko and talking to it counts as contact", async () => {
  const g = await setup([step()]);
  await waitUntil(g.engine, () => responders(g.db).length > 0, 40);
  const [unit] = responders(g.db);
  await waitUntil(g.engine, () => rows(g.db, "SELECT status FROM agenda_state WHERE character_id = ?", unit.id)[0]?.status === "arrived", 40);
  assert.equal(incidentOf(g).contacted, false);

  assert.equal((await g.engine.takeTurn({ type: "talk", target: unit.id })).ok, true);
  const incident = incidentOf(g);
  assert.equal(incident.contacted, true);
  assert.ok(incident.tags.includes("unregistered"), "the responder learns there are no papers");
});

test("steps are judged when they fire: contacted steps skip without contact, uncontacted ones skip after it", async () => {
  const protocol = [
    step({ after: 2 }),
    step({ institution: "feds", after: 60, when: "contacted", cue: "A dark car idles outside." }),
    step({ after: 60, when: "uncontacted", units: 2, cue: "Someone is going door to door." }),
  ];
  const statusOf = (db: Db) => rows<{ status: string }>(db, "SELECT status FROM scheduled_events WHERE kind = 'step' ORDER BY id").map((r) => r.status);
  // Until the report fires the protocol is not queued yet, so an empty list is not "all settled".
  const settled = (db: Db) => statusOf(db).length > 0 && statusOf(db).every((s) => s !== "pending");

  const silent = await setup(protocol);
  await waitUntil(silent.engine, () => settled(silent.db), 120);
  assert.deepEqual(statusOf(silent.db), ["done", "skipped", "done"]);
  assert.equal(responders(silent.db).length, 3); // the first officer plus the two searchers

  const spoken = await setup(protocol);
  await waitUntil(spoken.engine, () => responders(spoken.db).length > 0, 40);
  const [first] = responders(spoken.db);
  await waitUntil(spoken.engine, () => rows(spoken.db, "SELECT status FROM agenda_state WHERE character_id = ?", first.id)[0]?.status === "arrived", 40);
  assert.equal((await spoken.engine.takeTurn({ type: "talk", target: first.id })).ok, true);
  assert.equal((await spoken.engine.takeTurn({ type: "leave", target: first.id })).ok, true);
  await waitUntil(spoken.engine, () => settled(spoken.db), 120);
  assert.deepEqual(statusOf(spoken.db), ["done", "done", "skipped"]);
  const names = responders(spoken.db).map((r) => r.name);
  assert.equal(names.length, 2);
  assert.ok(names.some((n) => n.startsWith("Agent ")));
});

test("a step that requires the Ether tag only fires after a brace", async () => {
  const protocol = [step(), step({ institution: "feds", after: 6, requires: ["ether"], cue: "A dark car idles outside." })];
  const hard = await setup(protocol, { braced: false });
  await waitUntil(hard.engine, () => {
    const steps = rows(hard.db, "SELECT status FROM scheduled_events WHERE kind = 'step'");
    return steps.length > 0 && steps.every((r) => r.status !== "pending");
  }, 60);
  assert.equal(responders(hard.db).length, 1);

  const braced = await setup(protocol, { braced: true });
  await waitUntil(braced.engine, () => responders(braced.db).length === 2, 60);
  assert.ok(responders(braced.db).some((r) => r.name.startsWith("Agent ")));
});

test("a sighting moves the place the institution believes Niko is in, and the responder goes there", async () => {
  const g = await setup([step({ after: 30 })]);
  await waitUntil(g.engine, () => incidentOf(g).status === "reported", 20);
  assert.equal(incidentOf(g).last_zone, "house_001");

  // Out of the front door and onto the street, where six bystanders can see him.
  const door = g.engine.zone.portals[0];
  g.db.prepare("UPDATE entities SET x = ?, y = ? WHERE id = 'niko'").run(door.x, door.y - 1);
  assert.equal((await g.engine.takeTurn({ type: "move", dir: "S" })).ok, true);
  assert.equal(g.engine.state().zoneId, "outdoor");
  const [sighting] = rows(g.db, "SELECT * FROM scheduled_events WHERE kind = 'sighting' AND status = 'pending'");
  assert.equal(JSON.parse(sighting.payload).zone, "outdoor");

  await waitUntil(g.engine, () => incidentOf(g).last_zone === "outdoor", 20);
  await waitUntil(g.engine, () => responders(g.db).length > 0, 60);
  const [unit] = responders(g.db);
  assert.equal(unit.zone_id, "outdoor");
  const niko = g.engine.positions().niko;
  assert.ok(Math.max(Math.abs(unit.x - niko[0]), Math.abs(unit.y - niko[1])) > 10, "it arrives from the edge of the street");
  assert.equal(g.engine.zone.map[unit.y][unit.x], ".");
});

test("the same seed leaves identical incidents, queue and responders", async () => {
  const run = async () => {
    const g = createGame(":memory:", DATA, 42, () => offlineServices());
    await land(g.engine, true);
    for (let i = 0; i < 120; i++) await wait(g.engine);
    return {
      incidents: g.engine.debug().incidents,
      queue: rows(g.db, "SELECT due_tick, kind, incident_id, payload, status FROM scheduled_events ORDER BY id"),
      units: responders(g.db),
      positions: g.engine.positions(),
    };
  };
  const a = await run();
  assert.equal(a.incidents.length, 1);
  assert.deepEqual(a, await run());
});

test("a reset wipes the incidents and the queue and plants the new seed's government", async () => {
  const g = await setup([step()]);
  assert.equal(rows(g.db, "SELECT * FROM incidents").length, 1);
  await g.reset(undefined, { seed: 7 });
  assert.equal(rows(g.db, "SELECT * FROM incidents").length, 0);
  assert.equal(rows(g.db, "SELECT * FROM scheduled_events").length, 0);
  assert.deepEqual(JSON.parse((rows(g.db, "SELECT value FROM settings WHERE key = 'government'")[0]).value), generateGovernment(govData, 7));
});

// --- the `government` role at a reset -----------------------------------------------------------

const written: Government = governmentOf([step({ after: 9 })]);
const governed = (write: (req: GovernmentRequest) => Promise<Government | null>) =>
  createGame(":memory:", DATA, 1337, () => ({ ...offlineServices(), governor: { write } }));
const stored = (db: Db) => JSON.parse(rows(db, "SELECT value FROM settings WHERE key = 'government'")[0].value);

test("a seeded reset asks the governor once and stores a valid government", async () => {
  const asked: GovernmentRequest[] = [];
  const g = governed(async (req) => { asked.push(req); return written; });
  await g.engine.start();
  assert.equal(asked.length, 0); // the first boot is the authored game and asks nobody
  assert.deepEqual(stored(g.db), generateGovernment(govData, 1337));

  await g.reset(undefined, { seed: 7 });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].tags, govData.tags);
  assert.deepEqual(asked[0].limits, DEFAULT_INCIDENTS.government);
  assert.ok(asked[0].world?.facts.length);
  assert.deepEqual(stored(g.db), written);
  assert.equal(g.engine.state().phase, "fall");
});

test("an invalid draft or a failing governor leaves the deterministic government in place", async () => {
  const fallback = generateGovernment(govData, 7);
  const invalid = { ...written, protocol: [step({ after: 5, when: "contacted" })] } as Government;
  for (const write of [async () => invalid, async () => null, async () => { throw new Error("boom"); }]) {
    const g = governed(write);
    await g.engine.start();
    await g.reset(undefined, { seed: 7 });
    assert.deepEqual(stored(g.db), fallback);
    assert.equal(g.engine.state().phase, "fall");
  }
});

test("a reset without a seed does not ask the governor", async () => {
  let calls = 0;
  const g = governed(async () => { calls++; return written; });
  await g.engine.start();
  await g.reset();
  assert.equal(calls, 0);
  assert.deepEqual(stored(g.db), generateGovernment(govData, 1337));
});
