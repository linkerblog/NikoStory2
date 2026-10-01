import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import {
  generateCast, loadCast, OpenRouterCastWriter, parseCastDraft, PERSONALITY_MAX, type CastRequest, type CastWriter,
} from "../src/cast.js";
import { LlmClient, LLM_ROLES, type LlmRole, type RoleConfig } from "../src/llm.js";
import { loadScene } from "../src/stakes.js";
import { loadZone } from "../src/world.js";
import type { Context } from "../src/narrator.js";
import type { Db } from "../src/db.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const zone = loadZone(DATA);
const scene = loadScene(DATA);
const cast = loadCast(DATA, zone, scene);

const meta = (db: Db, key: string) =>
  (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
const npcRows = (db: Db) =>
  db.prepare("SELECT id, name, x, y, data FROM entities WHERE type = 'npc' ORDER BY rowid").all() as
    { id: string; name: string; x: number; y: number; data: string }[];
const fall = (text: string) => ({ type: "fall" as const, text });

test("nobody is perceived while Niko falls: no visible characters and the sky as the place", async () => {
  const seen: Context[] = [];
  const spy = { narrate: async (c: Context) => { seen.push(c); return { text: "Wind." }; } };
  const { engine } = createGame(":memory:", DATA, 1337, () => ({ ...offlineServices(), narrator: spy }));
  await engine.start();
  await engine.takeTurn(fall("let go and fall"));
  await engine.takeTurn(fall("let go and fall"));
  assert.equal(seen.length, 3); // the opening beat plus two fall beats
  for (const c of seen) {
    assert.deepEqual(c.visible, []);
    assert.equal(c.place.name, "The sky");
    assert.equal(c.place.room, undefined);
  }
  assert.deepEqual(engine.state().npcs, []);

  // The landing puts Niko on a tile again, so the house and whoever can see him come back.
  await engine.takeTurn(fall("let go and fall"));
  const landing = seen.at(-1)!;
  assert.equal(landing.arrival?.phase, "play");
  assert.equal(landing.place.name, "House");
  assert.ok(landing.place.room);
});

test("generateCast is a pure function of the seed and builds distinct people", () => {
  assert.deepEqual(generateCast(cast, 99), generateCast(cast, 99));
  const signatures = new Set<string>();
  for (let seed = 1; seed <= 60; seed++) {
    const { npcs, factTexts } = generateCast(cast, seed);
    assert.equal(npcs.length, cast.slots.length);
    assert.equal(new Set(npcs.map((n) => n.id)).size, npcs.length);
    assert.equal(new Set(npcs.map((n) => n.name)).size, npcs.length);
    assert.equal(new Set(npcs.map((n) => `${n.x},${n.y}`)).size, npcs.length);
    for (const n of npcs) {
      assert.notEqual(n.id, "niko");
      assert.ok(!["Marta", "Ivy"].includes(n.name), "a new cast never repeats the authored one");
      assert.ok(factTexts[(n.data.agenda as { reveals: string }).reveals].includes(n.name));
    }
    signatures.add(npcs.map((n) => n.name).join("/"));
  }
  assert.ok(signatures.size > 10, "different seeds bring different casts");
});

test("a reset with a seed replaces every NPC, the seed and the wording of the facts that name them", async () => {
  const g = createGame(":memory:", DATA, 1337, () => offlineServices());
  await g.engine.start();
  assert.deepEqual(npcRows(g.db).map((r) => r.id), ["marta", "ivy"]); // the first boot is the authored game

  await g.reset(undefined, { seed: 7 });
  const expected = generateCast(cast, 7);
  assert.equal(meta(g.db, "seed"), "7");
  assert.deepEqual(
    npcRows(g.db).map((r) => [r.id, r.name, r.x, r.y, JSON.parse(r.data)]),
    expected.npcs.map((n) => [n.id, n.name, n.x, n.y, n.data]),
  );
  assert.equal(g.engine.state().phase, "fall"); // still opens with the fall
  assert.deepEqual(g.engine.state().npcs, []);

  // Facts Niko learns are worded with the generated names, not Marta's or Ivy's.
  g.db.prepare("INSERT INTO facts_known (character_id, fact_id, tick) VALUES ('niko', 'fact_marta_warning', 0)").run();
  const warner = expected.npcs[0].name;
  const known = g.engine.state().scene.known;
  assert.equal(known.length, 1);
  assert.ok(known[0].startsWith(warner), known[0]);
  assert.ok(!known[0].includes("Marta"));
});

test("a reset with a seed starts a playable game whose agendas belong to the new cast", async () => {
  const g = createGame(":memory:", DATA, 1337, () => offlineServices());
  await g.engine.start();
  await g.reset(undefined, { seed: 31 });
  for (const text of ["steer toward the house", "brace", "let go"]) assert.equal((await g.engine.takeTurn(fall(text))).ok, true);
  assert.equal(g.engine.state().phase, "play");
  for (let i = 0; i < 4; i++) assert.equal((await g.engine.takeTurn({ type: "wait" })).ok, true);
  const rows = g.db.prepare("SELECT character_id FROM agenda_state ORDER BY character_id").all() as { character_id: string }[];
  assert.deepEqual(rows.map((r) => r.character_id), generateCast(cast, 31).npcs.map((n) => n.id).sort());
});

test("the same seed replays the same new game", async () => {
  const run = async () => {
    const g = createGame(":memory:", DATA, 1337, () => offlineServices());
    await g.engine.start();
    await g.reset(undefined, { seed: 555 });
    for (const text of ["steer toward the house", "brace", "let go"]) await g.engine.takeTurn(fall(text));
    for (let i = 0; i < 6; i++) await g.engine.takeTurn({ type: "wait" });
    return { positions: g.engine.positions(), npcs: npcRows(g.db) };
  };
  assert.deepEqual(await run(), await run());
});

test("a reset without a seed restarts the authored game", async () => {
  const g = createGame(":memory:", DATA, 1337, () => offlineServices());
  await g.engine.start();
  await g.reset(undefined, { seed: 7 });
  await g.reset();
  assert.equal(meta(g.db, "seed"), "1337");
  assert.deepEqual(npcRows(g.db).map((r) => r.name), ["Marta", "Ivy"]);
  assert.equal(meta(g.db, "fact_texts"), "{}");
});

test("a malformed cast.json is rejected on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "niko-cast-"));
  const base = JSON.parse(readFileSync(join(DATA, "cast.json"), "utf-8"));
  const write = (c: unknown) => writeFileSync(join(dir, "cast.json"), JSON.stringify(c));
  const withSlot = (patch: object) => ({ ...base, slots: [{ ...base.slots[0], ...patch }, base.slots[1]] });

  write({ ...base, slots: [] });
  assert.throws(() => loadCast(dir, zone, scene), /at least one slot/);
  write({ ...base, names: ["Rowan"] });
  assert.throws(() => loadCast(dir, zone, scene), /fewer names than slots/);
  write({ ...base, names: ["Niko", "Rowan"] });
  assert.throws(() => loadCast(dir, zone, scene), /protagonist/);
  write({ ...base, temperaments: [base.temperaments[0]] });
  assert.throws(() => loadCast(dir, zone, scene), /fewer temperaments/);
  write(withSlot({ spawns: [{ x: 0, y: 0 }] })); // a wall
  assert.throws(() => loadCast(dir, zone, scene), /blocked tile/);
  write(withSlot({ spawns: [{ x: 6, y: 3 }] })); // the table
  assert.throws(() => loadCast(dir, zone, scene), /blocked tile/);
  write(withSlot({ fact: { id: "fact_missing", text: "{name}" }, agenda: { ...base.slots[0].agenda, reveals: "fact_missing" } }));
  assert.throws(() => loadCast(dir, zone, scene), /not in the scene/);
  write(withSlot({ fact: { id: "fact_ivy_letter", text: "{name}" } }));
  assert.throws(() => loadCast(dir, zone, scene), /other than its own/);

  write(base);
  assert.equal(loadCast(dir, zone, scene).slots.length, 2);
});

// --- the `cast` role ---------------------------------------------------------------------------

const IDS = ["rowan", "sable"];
const good = { personality: "wry and restless", voice: "Talks in quick asides and answers questions sideways." };

test("parseCastDraft keeps valid entries and drops the rest", () => {
  const ok = parseCastDraft('```json\n{"characters":{"rowan":{"personality":"wry and restless","voice":"Quick asides."}}}\n```', IDS);
  assert.deepEqual(ok, { rowan: { personality: "wry and restless", voice: "Quick asides." } });

  const mixed = parseCastDraft(JSON.stringify({ characters: {
    rowan: good,
    ghost: good,                                              // not one of the ids
    sable: { personality: "x".repeat(PERSONALITY_MAX + 1), voice: "Fine." }, // too long
  } }), IDS);
  assert.deepEqual(Object.keys(mixed), ["rowan"]);

  assert.deepEqual(parseCastDraft(JSON.stringify({ characters: [{ id: "sable", ...good }, { id: "sable", personality: "other one", voice: "Again." }] }), IDS),
    { sable: good }); // the array form works and the first entry per id wins
  assert.deepEqual(parseCastDraft('{"characters":{"rowan":{"personality":"only this"}}}', IDS), {});
  assert.deepEqual(parseCastDraft("no json at all", IDS), {});
});

// A fetch stub that answers every call with one content and records the request bodies.
function stubFetch(content: string) {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 7, cost: 0.001 } }), { status: 200 });
  };
  return { bodies, restore: () => { (globalThis as { fetch: unknown }).fetch = original; } };
}
const llmFor = (db: Db) => new LlmClient(db, {
  apiKey: "t", language: "English", spendCapUsd: 0.5,
  roles: Object.fromEntries(LLM_ROLES.map((r) => [r, { model: "m", reasoning: false, idleMs: 5000 }])) as Record<LlmRole, RoleConfig>,
});
const brief = [
  { id: "rowan", name: "Rowan", role: "warner", goal: "Rowan came to warn Niko." },
  { id: "sable", name: "Sable", role: "finder", goal: "Sable found a letter." },
];

test("the OpenRouter cast writer logs its own role, sends names and goals, and returns the valid picks", async () => {
  const { db } = createGame(":memory:", DATA, 1337, () => offlineServices());
  const stub = stubFetch(JSON.stringify({ characters: { rowan: good, sable: { personality: "", voice: "" } } }));
  try {
    const picks = await new OpenRouterCastWriter(llmFor(db)).write({ characters: brief });
    assert.deepEqual(picks, { rowan: good });
    assert.equal(stub.bodies.length, 1);
    const user = JSON.parse(stub.bodies[0].messages[1].content);
    assert.deepEqual(user.characters, brief);
    assert.equal((db.prepare("SELECT role FROM llm_calls").get() as { role: string }).role, "cast");
  } finally { stub.restore(); }
});

test("the cast writer makes no call over budget and returns null when nothing is usable", async () => {
  const { db } = createGame(":memory:", DATA, 1337, () => offlineServices());
  const stub = stubFetch("not json");
  try {
    assert.equal(await new OpenRouterCastWriter(llmFor(db)).write({ characters: brief }), null);
    assert.equal(stub.bodies.length, 1);
    db.prepare("INSERT INTO llm_calls (tick, role, model, cost, request, response) VALUES (0, 'cast', 'm', 1, '{}', '')").run();
    assert.equal(await new OpenRouterCastWriter(llmFor(db)).write({ characters: brief }), null);
    assert.equal(stub.bodies.length, 1); // no second call
  } finally { stub.restore(); }
});

const castWith = (write: CastWriter["write"]) =>
  createGame(":memory:", DATA, 1337, () => ({ ...offlineServices(), castwriter: { write } }));
const personalityOf = (db: Db, id: string) => {
  const d = JSON.parse((db.prepare("SELECT data FROM entities WHERE id = ?").get(id) as { data: string }).data);
  return { personality: d.personality as string, voice: d.voice as string };
};

test("a seeded reset lets the cast role write personality and voice; the pool fills in the rest", async () => {
  let asked: CastRequest | undefined;
  const g = castWith(async (req) => { asked = req; return { [req.characters[0].id]: good }; });
  await g.engine.start();
  assert.equal(asked, undefined); // the first boot is the authored game and asks nobody

  await g.reset(undefined, { seed: 7 });
  const expected = generateCast(cast, 7);
  assert.deepEqual(asked!.characters.map((c) => c.id), expected.npcs.map((n) => n.id));
  assert.deepEqual(asked!.characters.map((c) => c.name), expected.npcs.map((n) => n.name));
  assert.ok(asked!.characters.every((c) => c.role && c.goal.includes(c.name)));
  assert.ok(asked!.world);

  assert.deepEqual(personalityOf(g.db, expected.npcs[0].id), { ...good }); // written by the model
  const second = expected.npcs[1].data as { personality: string; voice: string };
  assert.deepEqual(personalityOf(g.db, expected.npcs[1].id), { personality: second.personality, voice: second.voice }); // from the pool
});

test("a failing cast role never blocks a new game", async () => {
  const g = castWith(async () => { throw new Error("boom"); });
  await g.engine.start();
  await g.reset(undefined, { seed: 7 });
  const expected = generateCast(cast, 7);
  assert.equal(g.engine.state().phase, "fall");
  assert.equal(personalityOf(g.db, expected.npcs[0].id).personality, (expected.npcs[0].data as { personality: string }).personality);
});

test("a reset without a seed does not ask the cast role", async () => {
  let calls = 0;
  const g = castWith(async () => { calls++; return null; });
  await g.engine.start();
  await g.reset();
  assert.equal(calls, 0);
  assert.deepEqual(npcRows(g.db).map((r) => r.name), ["Marta", "Ivy"]);
});
