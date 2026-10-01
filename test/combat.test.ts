import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import type { Db } from "../src/db.js";
import type { EngineServices } from "../src/engine.js";
import {
  DEFAULT_COMBAT, healthBand, mitigate, parseCombat, publicData, rollBlow, vitalsOf,
} from "../src/combat.js";
import { loadRules } from "../src/rules.js";
import { OfflineNarrator, type Context, type Narrator } from "../src/narrator.js";
import { OfflineInterpreter, interpreterPrompt, sanitizeEffect, type InterpretContext, type Interpreter } from "../src/interpreter.js";
import { DEFAULT_RULES } from "../src/rules.js";
import type { NpcDecider } from "../src/npc.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));

// A copy of the data directory with the rules patched, so a test can make the dice certain.
const dataWith = (patch: (rules: any) => void): string => {
  const dir = mkdtempSync(join(tmpdir(), "niko-combat-"));
  cpSync(DATA, dir, { recursive: true });
  const path = join(dir, "rules.json");
  const rules = JSON.parse(readFileSync(path, "utf-8"));
  patch(rules);
  writeFileSync(path, JSON.stringify(rules));
  return dir;
};

// Every blow lands for exactly 2.
const sure = (rules: any) => { rules.combat.strike = { hit: 1, min: 2, max: 2 }; };

const create = (dir = DATA, overrides: Partial<EngineServices> = {}) => {
  const g = createGame(":memory:", dir, 1337, () => ({ ...offlineServices(), ...overrides }));
  g.db.prepare("UPDATE settings SET value = 'play' WHERE key = 'phase'").run();
  return g;
};

const place = (db: Db, id: string, x: number, y: number) =>
  db.prepare("UPDATE entities SET x = ?, y = ? WHERE id = ?").run(x, y, id);
// Sets numeric keys of `entities.data` straight in the database, the way an older save or a hand edit would.
const patchData = (db: Db, id: string, values: Record<string, number>) =>
  db.prepare(`UPDATE entities SET data = json_set(data, ${Object.keys(values).map(() => "?, ?").join(", ")}) WHERE id = ?`)
    .run(...Object.entries(values).flatMap(([k, v]) => [`$.${k}`, v]), id);
const dataOf = (db: Db, id: string) =>
  JSON.parse((db.prepare("SELECT data FROM entities WHERE id = ?").get(id) as { data: string }).data);
const tickOf = (db: Db) => Number((db.prepare("SELECT value FROM settings WHERE key = 'tick'").get() as { value: string }).value);
const events = (db: Db, ...types: string[]) =>
  (db.prepare(`SELECT id, tick, type, actor_id, data FROM events WHERE type IN (${types.map(() => "?").join(",")}) ORDER BY id`)
    .all(...types) as { id: number; tick: number; type: string; actor_id: string; data: string }[])
    .map((e) => ({ ...e, data: JSON.parse(e.data) }));
const witnessesOf = (db: Db, eventId: number) =>
  (db.prepare("SELECT character_id FROM witnesses WHERE event_id = ? ORDER BY character_id").all(eventId) as { character_id: string }[])
    .map((r) => r.character_id);

// Niko next to Marta in the living room, with Ivy out of sight in the lower room.
const duel = (db: Db) => {
  place(db, "niko", 5, 2);
  place(db, "marta", 6, 2);
  place(db, "ivy", 1, 13);
};

test("health words follow the bands and a missing hp reads as full health", () => {
  const npc = { type: "npc", data: {} };
  assert.deepEqual(vitalsOf(npc, DEFAULT_COMBAT), { hp: 12, max: 12 });
  assert.deepEqual(vitalsOf({ type: "player", data: {} }, DEFAULT_COMBAT), { hp: 20, max: 20 });
  assert.deepEqual(vitalsOf({ type: "npc", data: { hp: 99, hp_max: 12 } }, DEFAULT_COMBAT), { hp: 12, max: 12 });
  const word = (hp: number) => healthBand({ hp, max: 12 }, DEFAULT_COMBAT);
  assert.deepEqual([12, 11, 6, 3, 1, 0].map(word), ["unhurt", "hurt", "badly hurt", "near collapse", "near collapse", "down"]);
});

test("a blow costs Ether first, then HP, and a guard cuts it before that", () => {
  const rules = DEFAULT_COMBAT; // etherPerHp 2, guardFactor 0.5
  assert.deepEqual(mitigate(3, 0, false, rules), { taken: 3, absorbed: 0, etherSpent: 0, hpLost: 3 });
  assert.deepEqual(mitigate(3, 3, false, rules), { taken: 3, absorbed: 1, etherSpent: 2, hpLost: 2 });
  assert.deepEqual(mitigate(2, 10, false, rules), { taken: 2, absorbed: 2, etherSpent: 4, hpLost: 0 });
  assert.deepEqual(mitigate(3, 0, true, rules), { taken: 1, absorbed: 0, etherSpent: 0, hpLost: 1 });
  assert.equal(mitigate(1, 0, true, rules).hpLost, 0);
});

test("a blow draws the hit first and the damage second, always two draws", () => {
  const stream = (...v: number[]) => () => v.shift()!;
  assert.deepEqual(rollBlow(DEFAULT_COMBAT, stream(0.1, 0.9)), { hit: true, damage: 3 });
  assert.deepEqual(rollBlow(DEFAULT_COMBAT, stream(0.9, 0.0)), { hit: false, damage: 0 });
  let draws = 0;
  rollBlow(DEFAULT_COMBAT, () => { draws++; return 0.5; });
  assert.equal(draws, 2);
});

test("the combat rules load from data and a malformed block is rejected", () => {
  const rules = loadRules(DATA);
  assert.equal(rules.combat.hp.niko, 20);
  assert.equal(rules.abilities.brace.guard_ticks, 2);
  assert.ok(rules.limits.every((l) => !/cannot attack/i.test(l)));
  assert.equal(parseCombat(undefined), DEFAULT_COMBAT);
  assert.throws(() => parseCombat({ strike: { hit: 2 } }), /between 0 and 1/);
  assert.throws(() => parseCombat({ strike: { min: 3, max: 1 } }), /min <= max/);
  assert.throws(() => parseCombat({ bands: [{ max: 0.5, label: "a" }] }), /end at max 1/);
  assert.throws(() => parseCombat({ bands: [{ max: 0.8, label: "a" }, { max: 0.4, label: "b" }, { max: 1, label: "c" }] }), /ascending/);
  assert.throws(() => parseCombat({ downedTicks: 0 }), /downedTicks/);
  const bad = dataWith((r) => { r.abilities[0].guard_ticks = 0; });
  assert.throws(() => loadRules(bad), /guard_ticks/);
});

test("the health keys are stripped from what a prompt may see", () => {
  assert.deepEqual(publicData({ ether: 3, hp: 5, hp_max: 9, guard_until: 4, downed_until: 7, class: "x" }), { ether: 3, class: "x" });
});

test("an attack rolls from the seed, costs a tick and only its witnesses remember it", async () => {
  const { engine, db } = create(dataWith(sure));
  duel(db);
  place(db, "ivy", 4, 2); // in the same room, so she sees it
  await engine.start();
  const r = await engine.takeTurn({ type: "attack", target: "marta" });
  assert.equal(r.ok, true);
  assert.equal(tickOf(db), 1);
  assert.equal(dataOf(db, "marta").hp, 10);
  const [hit] = events(db, "hit");
  assert.equal(hit.actor_id, "niko");
  assert.deepEqual(hit.data, { target: "marta", damage: 2, absorbed: 0, hp_lost: 2, guarded: false });
  assert.deepEqual(witnessesOf(db, hit.id), ["ivy", "marta", "niko"]);
  const mem = db.prepare("SELECT character_id, text FROM memories WHERE event_id = ? ORDER BY character_id").all(hit.id) as { character_id: string; text: string }[];
  assert.deepEqual(mem.map((m) => m.character_id), ["ivy", "marta", "niko"]);
  assert.ok(mem.every((m) => m.text === "Niko hit Marta."));

  // The same blow with the third person out of sight: she neither witnesses nor remembers it.
  const other = create(dataWith(sure));
  duel(other.db);
  await other.engine.start();
  await other.engine.takeTurn({ type: "attack", target: "marta" });
  const [far] = events(other.db, "hit");
  assert.deepEqual(witnessesOf(other.db, far.id), ["marta", "niko"]);
});

test("an attack that cannot happen is rejected with a reason and no tick", async () => {
  const { engine, db } = create(dataWith(sure));
  duel(db);
  await engine.start();
  const before = tickOf(db);
  for (const [target, error] of [
    ["nobody", /no one to strike/],
    ["ivy", /no one to strike|out of reach/],
    ["niko", /no one to strike/],
  ] as const) {
    const r = await engine.takeTurn({ type: "attack", target });
    assert.equal(r.ok, false);
    assert.match(r.error!, error);
  }
  place(db, "marta", 8, 2); // three tiles away
  const far = await engine.takeTurn({ type: "attack", target: "marta" });
  assert.equal(far.ok, false);
  assert.match(far.error!, /out of reach/);
  assert.equal(tickOf(db), before);
  assert.equal(events(db, "hit", "miss").length, 0);
});

test("the Ether Core takes the blow before HP does, and a guard softens it", async () => {
  const { engine, db } = create(dataWith(sure));
  duel(db);
  await engine.start();
  patchData(db, "marta", { ether: 10 });
  await engine.takeTurn({ type: "attack", target: "marta" });
  assert.equal(dataOf(db, "marta").hp, 12);
  assert.equal(dataOf(db, "marta").ether, 6);
  const [first] = events(db, "hit");
  assert.equal(first.data.absorbed, 2);

  patchData(db, "marta", { ether: 0, guard_until: 99 });
  await engine.takeTurn({ type: "attack", target: "marta" });
  assert.equal(dataOf(db, "marta").hp, 11); // 2 halved and rounded down is 1
  assert.equal(events(db, "hit")[1].data.guarded, true);
});

test("brace opens a guard window of guard_ticks", async () => {
  const { engine, db } = create(dataWith(sure));
  duel(db);
  await engine.start();
  patchData(db, "niko", { ether: 10 });
  const r = await engine.takeTurn({ type: "ability", id: "brace" });
  assert.equal(r.ok, true);
  assert.equal(dataOf(db, "niko").guard_until, 2); // used at tick 0, guard_ticks 2
  assert.equal(dataOf(db, "niko").ether, 9); // 10 minus the cost of 2, plus the tick's regeneration
});

test("a downed NPC stays out until downedTicks pass, then stands up with recoverHp", async () => {
  const asked: { id: string; tick: number }[] = [];
  const decider: NpcDecider = { async decide(c) { asked.push({ id: c.actor.id, tick: c.tick }); return null; } };
  const { engine, db } = create(dataWith(sure), { npcdecider: decider });
  duel(db);
  await engine.start();
  patchData(db, "marta", { hp: 1, hp_max: 12 });
  await engine.takeTurn({ type: "attack", target: "marta" });
  assert.equal(dataOf(db, "marta").hp, 0);
  assert.equal(dataOf(db, "marta").downed_until, 5);
  assert.equal(events(db, "down").length, 1);
  assert.equal(engine.state().npcs.find((n) => n.id === "marta")!.health, "down");

  const talk = await engine.takeTurn({ type: "talk", target: "marta" });
  assert.equal(talk.ok, false);
  assert.match(talk.error!, /down/);
  const again = await engine.takeTurn({ type: "attack", target: "marta" });
  assert.equal(again.ok, false);
  assert.match(again.error!, /already down/);

  while (tickOf(db) < 4) await engine.takeTurn({ type: "wait" });
  assert.equal(dataOf(db, "marta").hp, 0);
  assert.ok(asked.every((a) => a.tick < 1 || a.tick >= 5), JSON.stringify(asked)); // never while she was down

  await engine.takeTurn({ type: "wait" }); // tick 5
  assert.equal(dataOf(db, "marta").hp, 3);
  assert.equal(dataOf(db, "marta").downed_until, undefined);
  assert.equal(events(db, "recover").length, 1);
});

test("downing someone mid-conversation closes it without revealing the fact it carried", async () => {
  const { engine, db } = create(dataWith(sure));
  duel(db);
  await engine.start();
  // Marta is talking with Ivy, not with Niko, so nothing stops Niko from striking her.
  db.prepare(
    "INSERT INTO conversations (npc_id, goal_id, status, beat, started_tick, initiator_id, listener_id) VALUES ('marta', 'marta_warn', 'open', 1, 0, 'ivy', 'marta')",
  ).run();
  patchData(db, "marta", { hp: 1, hp_max: 12 });
  const r = await engine.takeTurn({ type: "attack", target: "marta" });
  assert.equal(r.ok, true);
  assert.equal((db.prepare("SELECT status FROM conversations").get() as { status: string }).status, "closed");
  assert.equal(events(db, "talked").length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM facts_known").get() as { c: number }).c, 0);
});

test("a downed Niko passes the turn, costs no interpreter call and stands up", async () => {
  let calls = 0;
  const offline = new OfflineInterpreter();
  const interpreter: Interpreter = { interpret: async (c) => { calls++; return offline.interpret(c); } };
  const { engine, db } = create(DATA, { interpreter });
  duel(db);
  await engine.start();
  patchData(db, "niko", { hp: 0, downed_until: 3 });

  const r = await engine.takeTurn({ type: "free", text: "look around" });
  assert.equal(r.ok, true);
  assert.equal(calls, 0);
  assert.equal(tickOf(db), 1);
  assert.equal(engine.state().niko.down, true);
  const last = engine.state().log.at(-1)!;
  assert.match(last.text, /Niko is down and cannot act/);

  await engine.takeTurn({ type: "move", dir: "N" });
  await engine.takeTurn({ type: "wait" }); // tick 3
  assert.equal(dataOf(db, "niko").hp, 3);
  assert.equal(engine.state().niko.down, false);

  await engine.takeTurn({ type: "free", text: "look around" });
  assert.equal(calls, 1);
});

test("an NPC hits back only at someone it saw strike it", async () => {
  const decider: NpcDecider = {
    async decide(c) { return c.actor.id === "marta" ? { effects: [{ kind: "attack", target: "niko" }] } : null; },
  };
  const { engine, db } = create(dataWith(sure), { npcdecider: decider });
  duel(db);
  await engine.start();
  patchData(db, "niko", { ether: 0, ether_regen: 0 });

  for (let i = 0; i < 7; i++) await engine.takeTurn({ type: "wait" });
  assert.equal(events(db, "hit", "miss").length, 0); // asked at ticks 3 and 6, refused both times
  assert.equal(dataOf(db, "niko").hp, 20);

  await engine.takeTurn({ type: "attack", target: "marta" });
  for (let i = 0; i < 6; i++) await engine.takeTurn({ type: "wait" });
  const back = events(db, "hit").filter((e) => e.actor_id === "marta");
  assert.ok(back.length > 0);
  assert.equal(back[0].data.target, "niko");
  assert.ok(dataOf(db, "niko").hp < 20);
});

test("the prompts see health words and never the raw numbers", async () => {
  const contexts: Context[] = [];
  const offline = new OfflineNarrator();
  const narrator: Narrator = { narrate: async (c) => { contexts.push(c); return offline.narrate(c); } };
  const seen: InterpretContext[] = [];
  const interp = new OfflineInterpreter();
  const interpreter: Interpreter = { interpret: async (c) => { seen.push(c); return interp.interpret(c); } };
  const { engine, db } = create(dataWith(sure), { narrator, interpreter });
  duel(db);
  await engine.start();
  await engine.takeTurn({ type: "attack", target: "marta" });
  await engine.takeTurn({ type: "free", text: "look around" });

  const last = contexts.at(-1)!;
  assert.equal(last.sheet.health, "unhurt");
  assert.equal(last.visible[0].health, "hurt");
  for (const c of [...contexts, ...seen]) {
    assert.doesNotMatch(JSON.stringify(c.sheet), /"hp"|"hp_max"|guard_until|downed_until/);
  }
  assert.equal(seen[0].visible[0].health, "hurt");
});

test("free text maps a strike to an attack the engine rolls", async () => {
  const { engine, db } = create();
  duel(db);
  await engine.start();
  const r = await engine.takeTurn({ type: "free", text: "punch Marta" });
  assert.equal(r.ok, true);
  assert.equal(events(db, "hit", "miss").length, 1);
  assert.deepEqual(sanitizeEffect({ kind: "attack", target: "marta" }), { kind: "attack", target: "marta" });
  assert.equal(sanitizeEffect({ kind: "attack" }), null);
  assert.match(interpreterPrompt(DEFAULT_RULES, "English"), /"kind":"attack"/);
});

test("the same seed and the same actions give the same fight", async () => {
  const run = async () => {
    const { engine, db } = create();
    duel(db);
    await engine.start();
    for (let i = 0; i < 6; i++) await engine.takeTurn({ type: "attack", target: "marta" });
    return {
      log: events(db, "hit", "miss", "down", "recover").map((e) => [e.tick, e.type, e.actor_id, e.data]),
      marta: dataOf(db, "marta"),
    };
  };
  const a = await run();
  const b = await run();
  assert.ok(a.log.length > 0);
  assert.deepEqual(a, b);
});

test("a save with no hp reads as full health and gains the keys on the first blow", async () => {
  const { engine, db } = create(dataWith(sure));
  duel(db);
  await engine.start();
  db.prepare("UPDATE entities SET data = json_remove(data, '$.hp', '$.hp_max') WHERE id IN ('niko', 'marta')").run();
  const s = engine.state();
  assert.equal(s.niko.hp, 20);
  assert.equal(s.niko.hp_max, 20);
  assert.equal(s.niko.health, "unhurt");
  assert.equal(dataOf(db, "marta").hp, undefined);
  await engine.takeTurn({ type: "attack", target: "marta" });
  assert.deepEqual([dataOf(db, "marta").hp, dataOf(db, "marta").hp_max], [10, 12]);
});

test("health regenerates slowly and never past the maximum", async () => {
  const { engine, db } = create(DATA);
  duel(db);
  await engine.start();
  patchData(db, "niko", { hp: 18, hp_max: 20 });
  while (tickOf(db) < 25) await engine.takeTurn({ type: "wait" });
  assert.equal(dataOf(db, "niko").hp, 20); // +1 at tick 10 and +1 at tick 20
  while (tickOf(db) < 40) await engine.takeTurn({ type: "wait" });
  assert.equal(dataOf(db, "niko").hp, 20);
});
