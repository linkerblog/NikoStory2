import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import {
  castPrompt, DEPTH_LIMITS, generateCast, loadCast, OpenRouterCastWriter, parseBearing, parseCastDraft, parseDepth,
  PERSONALITY_MAX, readBearing, readDepth,
  type CastRequest, type CastWriter,
} from "../src/cast.js";
import { LlmClient, LLM_ROLES, type LlmRole, type RoleConfig } from "../src/llm.js";
import { loadHomes, pickStart } from "../src/homes.js";
import { loadCity } from "../src/zones.js";
import { loadScene } from "../src/stakes.js";
import { loadZone } from "../src/world.js";
import type { Context } from "../src/narrator.js";
import type { Db } from "../src/db.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const zone = loadZone(DATA);
const scene = loadScene(DATA);
const cast = loadCast(DATA, zone, scene);
// The home a seeded new game opens in decides where the cast spawns, so a test that compares positions asks for it.
const homes = loadHomes(DATA, cast.slots.map((s) => s.role), "living_room");
const lots = loadCity(DATA).lots.map((l) => l.id);

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
  const expected = generateCast(cast, 7, pickStart(homes, lots, 7).home);
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

// --- depth: traits, quirk, fear and backstory ------------------------------------------------------

const deep = { traits: ["wary", "guarded"], quirk: "Taps the table.", fear: "Being cheated.", backstory: "Ran a stall for years." };

test("every pool temperament carries a valid depth, and the generated people keep it", () => {
  assert.ok(cast.temperaments.every((t) => parseDepth(t.depth) !== null));
  for (let seed = 1; seed <= 40; seed++) {
    const { npcs } = generateCast(cast, seed);
    for (const n of npcs) {
      const depth = readDepth(n.data);
      assert.ok(depth, `${n.name} has a depth`);
      const pool = cast.temperaments.find((t) => t.personality === n.data.personality)!;
      assert.deepEqual(depth, pool.depth); // depth rides on the temperament already drawn
    }
  }
});

test("the authored characters carry a depth too", async () => {
  const g = createGame(":memory:", DATA, 1337, () => offlineServices());
  await g.engine.start();
  for (const r of npcRows(g.db)) assert.ok(readDepth(JSON.parse(r.data)), r.id);
});

test("a depth is all or nothing and bounded", () => {
  assert.deepEqual(parseDepth(deep), deep);
  assert.deepEqual(parseDepth({ ...deep, quirk: "  Taps   the\ntable. " }), deep);
  const no = (over: object) => assert.equal(parseDepth({ ...deep, ...over }), null, JSON.stringify(over));
  no({ traits: ["only one"] });
  no({ traits: ["a trait", "b trait", "c trait", "d trait", "e trait"] });
  no({ traits: ["same", "Same"] });
  no({ traits: ["fine", ""] });
  no({ traits: ["fine", "x".repeat(DEPTH_LIMITS.trait + 1)] });
  no({ traits: "wary, guarded" });
  no({ quirk: "" });
  no({ quirk: "x".repeat(DEPTH_LIMITS.quirk + 1) });
  no({ fear: 3 });
  no({ backstory: "x".repeat(DEPTH_LIMITS.backstory + 1) });
  assert.equal(parseDepth(null), null);
  assert.equal(parseDepth("text"), null);
  assert.equal(parseDepth({ traits: deep.traits }), null);
});

test("parseCastDraft keeps a valid depth, and a bad one never costs the character its voice", () => {
  const draft = parseCastDraft(JSON.stringify({ characters: {
    rowan: { ...good, ...deep },
    sable: { ...good, ...deep, traits: ["one"] },
  } }), IDS);
  assert.deepEqual(draft.rowan, { ...good, depth: deep });
  assert.deepEqual(draft.sable, good); // no depth key at all, not an undefined one
});

// --- bearing: how a character carries itself around Niko -------------------------------------------

test("every temperament names a defined bearing, and the generated people carry it whole", () => {
  assert.ok(Object.keys(cast.bearings).length >= 4);
  assert.ok(cast.temperaments.every((t) => t.bearing && cast.bearings[t.bearing]));
  assert.ok(Object.values(cast.bearings).some((b) => b.mode === "follow") && Object.values(cast.bearings).some((b) => b.mode === "stay"));
  for (let seed = 1; seed <= 40; seed++) {
    for (const n of generateCast(cast, seed).npcs) {
      const b = readBearing(n.data);
      assert.ok(b, `${n.name} has a bearing`);
      const pool = cast.temperaments.find((t) => t.personality === n.data.personality)!;
      assert.deepEqual(b, cast.bearings[pool.bearing!]);
    }
  }
});

test("a bearing is bounded and a stored one reads back or reads as nothing", () => {
  const ok = { mode: "follow", range: 2, leash: 10, prob: 0.8, word: "walks along with Niko" };
  assert.deepEqual(parseBearing("companion", ok), { id: "companion", ...ok });
  const no = (over: object) => assert.equal(parseBearing("x", { ...ok, ...over }), null, JSON.stringify(over));
  no({ mode: "run" });
  no({ range: 0 });
  no({ range: 9 });
  no({ range: 1.5 });
  no({ leash: 21 });
  no({ prob: 1.2 });
  no({ prob: -0.1 });
  no({ prob: "often" });
  no({ word: "hi" });
  assert.equal(parseBearing("", ok), null);
  assert.equal(parseBearing("x", null), null);
  assert.equal(readBearing({}), null);
  assert.equal(readBearing({ bearing: "shadow" }), null);
  assert.equal(readBearing({ bearing: { ...ok, id: "companion" } })?.mode, "follow");
});

test("a malformed bearing in cast.json is rejected on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "niko-cast-bearing-"));
  const base = JSON.parse(readFileSync(join(DATA, "cast.json"), "utf-8"));
  const write = (c: unknown) => writeFileSync(join(dir, "cast.json"), JSON.stringify(c));
  write({ ...base, bearings: { ...base.bearings, shadow: { ...base.bearings.shadow, range: 0 } } });
  assert.throws(() => loadCast(dir, zone, scene), /bearing shadow/);
  write({ ...base, temperaments: [{ ...base.temperaments[0], bearing: "nowhere" }, ...base.temperaments.slice(1)] });
  assert.throws(() => loadCast(dir, zone, scene), /bearing that is not defined/);
  write(base);
  assert.equal(loadCast(dir, zone, scene).temperaments.length, base.temperaments.length);
});

test("the cast role may choose a bearing by name; an unknown name is dropped and the pool's stands", async () => {
  const names = Object.keys(cast.bearings);
  const draft = parseCastDraft(JSON.stringify({ characters: {
    rowan: { ...good, bearing: "stays" },
    sable: { ...good, bearing: "teleports" },
  } }), IDS, names);
  assert.equal(draft.rowan.bearing, "stays");
  assert.equal("bearing" in draft.sable, false);
  assert.equal("bearing" in parseCastDraft(JSON.stringify({ characters: { rowan: { ...good, bearing: "stays" } } }), IDS).rowan, false);

  // The prompt offers the names with their phrases only when there is something to choose from.
  assert.match(castPrompt(Object.fromEntries(names.map((n) => [n, cast.bearings[n].word]))), /"stays" \(goes about its own business/);
  assert.doesNotMatch(castPrompt(), /"bearing"/);

  const g = castWith(async (req) => ({ [req.characters[0].id]: { ...good, bearing: "stays" } }));
  await g.engine.start();
  await g.reset(undefined, { seed: 7 });
  const expected = generateCast(cast, 7, pickStart(homes, lots, 7).home);
  const data = (id: string) => JSON.parse((g.db.prepare("SELECT data FROM entities WHERE id = ?").get(id) as { data: string }).data);
  assert.equal(readBearing(data(expected.npcs[0].id))?.id, "stays"); // the role's choice
  assert.deepEqual(readBearing(data(expected.npcs[1].id)), readBearing(expected.npcs[1].data)); // the pool's
});

test("a malformed depth in cast.json is rejected on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "niko-cast-depth-"));
  const base = JSON.parse(readFileSync(join(DATA, "cast.json"), "utf-8"));
  const write = (c: unknown) => writeFileSync(join(dir, "cast.json"), JSON.stringify(c));
  const withDepth = (depth: unknown) => ({ ...base, temperaments: [{ ...base.temperaments[0], depth }, ...base.temperaments.slice(1)] });
  write(withDepth({ ...deep, traits: ["one"] }));
  assert.throws(() => loadCast(dir, zone, scene), /depth needs traits/);
  write(withDepth({ ...deep, backstory: "" }));
  assert.throws(() => loadCast(dir, zone, scene), /depth needs traits/);
  write(withDepth(deep));
  assert.equal(loadCast(dir, zone, scene).temperaments[0].depth?.quirk, deep.quirk);
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

test("the depth follows the personality: the model's own, or none, but never the pool's for another temperament", async () => {
  const g = castWith(async (req) => ({
    [req.characters[0].id]: { ...good, depth: deep },
    [req.characters[1].id]: good, // a valid personality without a valid depth
  }));
  await g.engine.start();
  await g.reset(undefined, { seed: 7 });
  const expected = generateCast(cast, 7);
  const data = (id: string) => JSON.parse((g.db.prepare("SELECT data FROM entities WHERE id = ?").get(id) as { data: string }).data);
  assert.deepEqual(readDepth(data(expected.npcs[0].id)), deep);
  const second = data(expected.npcs[1].id);
  assert.equal(readDepth(second), null);
  for (const k of ["traits", "quirk", "fear", "backstory"]) assert.equal(k in second, false, k);
  assert.equal(second.voice, good.voice);

  // Nobody asked for: the pool's personality and its depth stay together.
  const h = castWith(async () => null);
  await h.engine.start();
  await h.reset(undefined, { seed: 7 });
  assert.deepEqual(
    readDepth(JSON.parse((h.db.prepare("SELECT data FROM entities WHERE id = ?").get(expected.npcs[0].id) as { data: string }).data)),
    readDepth(expected.npcs[0].data),
  );
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
