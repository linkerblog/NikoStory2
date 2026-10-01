import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import { clearSave, openDb, type Db } from "../src/db.js";
import { LLM_ROLES } from "../src/llm.js";
import { systemPrompt } from "../src/narrator.js";
import type { Context, ZoneRequest } from "../src/narrator.js";
import type { InterpretContext } from "../src/interpreter.js";
import type { NpcContext } from "../src/npc.js";
import type { GovernmentRequest } from "../src/government.js";
import type { Action, Engine } from "../src/engine.js";
import type { WorldFacts } from "../src/world.js";
import {
  applyWorldPatch, clearWorldDoc, compileWorld, loadWorldDoc, parseWorldDoc, publicWorld, readWorldDoc,
  saveWorldDoc, worldPayload, WORLD_LIMITS, WORLD_USERS, type WorldDoc,
} from "../src/worlddoc.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const defaults = loadWorldDoc(DATA);
const tmpDb = () => openDb(join(mkdtempSync(join(tmpdir(), "niko-world-")), "game.db"));
const edited = (over: Partial<WorldDoc> = {}): WorldDoc => ({ ...defaults, ...over });

test("the default world is the author's start, section by section", () => {
  assert.equal(defaults.year, 2030);
  assert.equal(defaults.country, "United States");
  assert.match(defaults.init, /Giant Abyssal creature/);
  assert.match(defaults.personality, /Never talks/);
  assert.match(defaults.history, /Ether Core/);
  assert.ok(defaults.tags.includes("Role reversal") && defaults.tags.includes("Technological gap"));
  assert.ok(defaults.world.some((l) => /10 females for every 1 male/.test(l)));
  assert.ok(defaults.world.some((l) => /Heroes and Villains/.test(l)));
  assert.ok(defaults.biology.some((l) => /vagina/.test(l)));
  assert.match(defaults.format, /Short sentences/);
});

test("compiling the world gives every role the same facts, and the open view hides Niko's own story", () => {
  const w = compileWorld(defaults);
  assert.deepEqual(w.facts, [...defaults.world, ...defaults.biology]);
  assert.equal(w.style, defaults.format);
  assert.equal(w.premise, defaults.init);
  assert.deepEqual(w.protagonist, { personality: defaults.personality, history: defaults.history });
  assert.deepEqual(w.tags, defaults.tags);

  const open = publicWorld(w);
  assert.equal("premise" in open, false);
  assert.equal("protagonist" in open, false);
  assert.deepEqual(open.facts, w.facts);
});

test("a document is validated: text is cleaned, blank lines go, and a bound is an error", () => {
  const ok = parseWorldDoc({ ...defaults, world: ["  A fact \r\n", "", "   ", "Another\u0007 one"], tags: [" a ", ""] });
  assert.ok("doc" in ok);
  if ("doc" in ok) {
    assert.deepEqual(ok.doc.world, ["A fact", "Another one"]);
    assert.deepEqual(ok.doc.tags, ["a"]);
  }
  // A single-line field collapses its line breaks; free text keeps them.
  const lines = parseWorldDoc({ ...defaults, personality: "calm\n\nand quiet", format: "one\ntwo" });
  assert.ok("doc" in lines && lines.doc.personality === "calm and quiet" && lines.doc.format === "one\ntwo");

  const bad = (over: object, re: RegExp) => {
    const r = parseWorldDoc({ ...defaults, ...over });
    assert.ok("error" in r, JSON.stringify(over));
    if ("error" in r) assert.match(r.error, re);
  };
  bad({ year: "2030" }, /year/);
  bad({ year: 0 }, /year/);
  bad({ year: 2030.5 }, /year/);
  bad({ country: "  " }, /country/);
  bad({ init: "x".repeat(WORLD_LIMITS.init + 1) }, /\[Init\] is too long/);
  bad({ history: 7 }, /\[Initial history\] must be text/);
  bad({ world: "not a list" }, /\[WorldBuilding\] must be a list/);
  bad({ world: [3] }, /list of text/);
  bad({ world: ["x".repeat(WORLD_LIMITS.line + 1)] }, /too long/);
  bad({ biology: Array.from({ length: WORLD_LIMITS.lines + 1 }, (_, i) => `fact ${i}`) }, /too many lines/);
  bad({ tags: Array.from({ length: WORLD_LIMITS.tags + 1 }, (_, i) => `t${i}`) }, /too many lines/);
  assert.ok("error" in parseWorldDoc(null));
  assert.ok("error" in parseWorldDoc([]));

  // The sections may be left empty: the author can clear a heading.
  const empty = parseWorldDoc({ year: 2030, country: "United States" });
  assert.ok("doc" in empty && empty.doc.world.length === 0 && empty.doc.init === "");
});

test("daily life is a public, bounded section that compiles apart from the facts", () => {
  assert.ok(defaults.daily_life.length > 0);
  const w = compileWorld(defaults);
  assert.deepEqual(w.life, defaults.daily_life);
  assert.equal(w.facts.some((f) => defaults.daily_life.includes(f)), false); // texture, not a fact to contradict
  assert.deepEqual(publicWorld(w).life, defaults.daily_life); // anyone in the world knows how a day goes

  const ok = parseWorldDoc({ ...defaults, daily_life: ["  Buses run late. ", "", "Bread is cheap\u0007."] });
  assert.ok("doc" in ok && ok.doc.daily_life.join("|") === "Buses run late.|Bread is cheap.");
  const long = parseWorldDoc({ ...defaults, daily_life: ["x".repeat(WORLD_LIMITS.line + 1)] });
  assert.ok("error" in long && /\[Daily life\]/.test(long.error));
  const many = parseWorldDoc({ ...defaults, daily_life: Array.from({ length: WORLD_LIMITS.lines + 1 }, (_, i) => `d${i}`) });
  assert.ok("error" in many && /too many lines/.test(many.error));
  assert.ok("error" in parseWorldDoc({ ...defaults, daily_life: "no" }));

  // A document saved before the section existed still validates, with no daily life.
  const { daily_life: _gone, ...old } = defaults;
  const legacy = parseWorldDoc(old);
  assert.ok("doc" in legacy && legacy.doc.daily_life.length === 0);
});

test("a malformed world.json is rejected on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "niko-world-data-"));
  cpSync(DATA, dir, { recursive: true });
  const base = JSON.parse(readFileSync(join(DATA, "world.json"), "utf-8"));
  const write = (o: unknown) => writeFileSync(join(dir, "world.json"), JSON.stringify(o));
  write({ ...base, world: "no" });
  assert.throws(() => loadWorldDoc(dir), /world\.json: .*WorldBuilding/);
  write({ ...base, year: "later" });
  assert.throws(() => loadWorldDoc(dir), /year/);
  write(base);
  assert.equal(loadWorldDoc(dir).year, 2030);
});

test("an edit is saved, read back, and survives a new game; clearing it restores the default", () => {
  const db = tmpDb();
  assert.equal(readWorldDoc(db), null);
  saveWorldDoc(db, edited({ country: "Canada", world: ["Only one fact."] }));
  assert.equal(readWorldDoc(db)?.country, "Canada");
  assert.deepEqual(readWorldDoc(db)?.world, ["Only one fact."]);

  clearSave(db); // "Start new game": the save goes, the author's world stays
  assert.equal(readWorldDoc(db)?.country, "Canada");

  clearWorldDoc(db);
  assert.equal(readWorldDoc(db), null);

  // A damaged row never reaches a prompt: it reads as no edit at all.
  db.prepare("INSERT INTO world_doc (id, doc) VALUES (1, ?)").run("{not json");
  assert.equal(readWorldDoc(db), null);
  db.prepare("UPDATE world_doc SET doc = ? WHERE id = 1").run(JSON.stringify({ year: -4, country: "x" }));
  assert.equal(readWorldDoc(db), null);
});

test("the API logic saves a valid edit, rejects an invalid one without touching the saved one, and restores", () => {
  const db = tmpDb();
  assert.deepEqual(applyWorldPatch(db, { doc: edited({ country: "Canada" }) }), { ok: true });
  assert.equal(readWorldDoc(db)?.country, "Canada");

  const refused = applyWorldPatch(db, { doc: { ...defaults, year: "soon" } });
  assert.equal(refused.ok, false);
  assert.equal(readWorldDoc(db)?.country, "Canada"); // unchanged

  assert.equal(applyWorldPatch(db, {}).ok, false);
  assert.equal(applyWorldPatch(db, null).ok, false);
  assert.deepEqual(applyWorldPatch(db, { reset: true }), { ok: true });
  assert.equal(readWorldDoc(db), null);
});

test("the payload names the source, the limits, who reads the world and what they receive", () => {
  const db = tmpDb();
  const fresh = worldPayload(db, defaults);
  assert.equal(fresh.custom, false);
  assert.deepEqual(fresh.doc, defaults);
  assert.deepEqual(fresh.compiled, compileWorld(defaults));

  saveWorldDoc(db, edited({ country: "Canada" }));
  const custom = worldPayload(db, defaults);
  assert.equal(custom.custom, true);
  assert.equal(custom.doc.country, "Canada");
  assert.equal(custom.compiled.country, "Canada");
  assert.equal(custom.defaults.country, "United States");

  // A role added later cannot be forgotten: every role is on the list, once.
  assert.deepEqual(WORLD_USERS.map((u) => u.role).sort(), [...LLM_ROLES].sort());
  assert.deepEqual(WORLD_USERS.filter((u) => u.gets === "full").map((u) => u.role), ["narrator", "continuity"]);
});

test("the narrator is told to follow the format and to keep Niko's story as background", () => {
  const p = systemPrompt("English");
  assert.match(p, /world\.style/);
  assert.match(p, /world\.premise/);
  assert.match(p, /world\.protagonist/);
  assert.match(p, /world\.life is how ordinary days go/);
});

// --- the edit reaching the roles --------------------------------------------------------------

const fall = (text: string): Action => ({ type: "fall", text });
async function land(engine: Engine): Promise<void> {
  await engine.start();
  for (const t of ["steer toward the houses", "let go and fall", "steer"]) await engine.takeTurn(fall(t));
}
const open = (w: WorldFacts | undefined) => {
  assert.ok(w);
  assert.equal("premise" in w!, false, "the premise stays with the narrator");
  assert.equal("protagonist" in w!, false, "Niko's story stays with the narrator");
};

test("an edit reaches the narrator on the next call, with no restart, and Niko's sheet takes the new personality", async () => {
  const seen: Context[] = [];
  const spy = { narrate: async (c: Context) => { seen.push(c); return { text: "Time passes." }; } };
  const g = createGame(":memory:", DATA, 1337, () => ({ ...offlineServices(), narrator: spy }));
  await land(g.engine);
  const before = seen.at(-1)!;
  assert.equal(before.world?.premise, defaults.init);
  assert.equal(before.sheet.personality, defaults.personality);
  assert.deepEqual(before.world?.facts.slice(0, 1), defaults.world.slice(0, 1));

  saveWorldDoc(g.db, edited({ personality: "Loud and bold.", init: "A new premise.", world: ["Only this is true."], format: "Greentext only." }));
  await g.engine.takeTurn({ type: "free", text: "wait" }); // a free-text turn always narrates
  const after = seen.at(-1)!;
  assert.equal(after.sheet.personality, "Loud and bold.");
  assert.equal(after.world?.premise, "A new premise.");
  assert.equal(after.world?.facts[0], "Only this is true.");
  assert.equal(after.world?.style, "Greentext only.");
  assert.equal(after.world?.protagonist?.history, defaults.history);

  clearWorldDoc(g.db);
  await g.engine.takeTurn({ type: "free", text: "wait" });
  assert.equal(seen.at(-1)!.world?.premise, defaults.init);
});

test("an emptied personality leaves the sheet as the data file wrote it", async () => {
  const seen: Context[] = [];
  const spy = { narrate: async (c: Context) => { seen.push(c); return { text: "Time passes." }; } };
  const g = createGame(":memory:", DATA, 1337, () => ({ ...offlineServices(), narrator: spy }));
  saveWorldDoc(g.db, edited({ personality: "" }));
  await land(g.engine);
  assert.equal(seen.at(-1)!.sheet.personality, undefined);
  assert.equal(seen.at(-1)!.sheet.class, "Mythos (Eldritch)");
});

test("the interpreter and the NPC decider get the world as anyone in it would know it", async () => {
  const interpreted: InterpretContext[] = [];
  const decided: NpcContext[] = [];
  const g = createGame(":memory:", DATA, 1337, () => ({
    ...offlineServices(),
    interpreter: { interpret: async (c: InterpretContext) => { interpreted.push(c); return { effects: [{ kind: "wait" as const }], keywords: [] }; } },
    npcdecider: { decide: async (c: NpcContext) => { decided.push(c); return null; } },
  }));
  saveWorldDoc(g.db, edited({ world: ["People here keep bees."] }));
  await land(g.engine);
  assert.equal((await g.engine.takeTurn({ type: "free", text: "wait" })).ok, true);
  for (let i = 0; i < 12 && !decided.length; i++) await g.engine.takeTurn({ type: "wait" });

  assert.equal(interpreted.length, 1);
  open(interpreted[0].world);
  assert.ok(interpreted[0].world!.facts.includes("People here keep bees."));
  assert.equal(interpreted[0].sheet.personality, defaults.personality);

  assert.ok(decided.length > 0, "an NPC was asked what to do");
  open(decided[0].world);
  assert.ok(decided[0].world!.facts.includes("People here keep bees."));
});

test("daily life reaches the NPC decider and the cast writer, and an edit applies on the next call", async () => {
  const decided: NpcContext[] = [];
  const cast: { world?: WorldFacts }[] = [];
  const g = createGame(":memory:", DATA, 1337, () => ({
    ...offlineServices(),
    npcdecider: { decide: async (c: NpcContext) => { decided.push(c); return null; } },
    castwriter: { write: async (req: { world?: WorldFacts }) => { cast.push(req); return null; } },
  }));
  saveWorldDoc(g.db, edited({ daily_life: ["Everyone waves at the bus."] }));
  await g.reset(undefined, { seed: 7 });
  assert.deepEqual(cast[0].world?.life, ["Everyone waves at the bus."]);

  await land(g.engine);
  for (let i = 0; i < 12 && !decided.length; i++) await g.engine.takeTurn({ type: "wait" });
  assert.ok(decided.length > 0, "an NPC was asked what to do");
  assert.deepEqual(decided.at(-1)!.world?.life, ["Everyone waves at the bus."]);

  saveWorldDoc(g.db, edited({ daily_life: ["Bread is cheap."] }));
  const before = decided.length;
  for (let i = 0; i < 12 && decided.length === before; i++) await g.engine.takeTurn({ type: "wait" });
  assert.ok(decided.length > before);
  assert.deepEqual(decided.at(-1)!.world?.life, ["Bread is cheap."]);
});

test("the architect, the cast writer and the government writer never see where Niko comes from", async () => {
  const zones: ZoneRequest[] = [];
  const governed: GovernmentRequest[] = [];
  const cast: { world?: WorldFacts }[] = [];
  const narrator = {
    narrate: async () => ({ text: "Time passes." }),
    generateZone: async (req: ZoneRequest) => { zones.push(req); return null; },
  };
  const g = createGame(":memory:", DATA, 1337, () => ({
    ...offlineServices(), narrator,
    governor: { write: async (req: GovernmentRequest) => { governed.push(req); return null; } },
    castwriter: { write: async (req: { world?: WorldFacts }) => { cast.push(req); return null; } },
  }));
  saveWorldDoc(g.db, edited({ country: "Canada" }));
  await g.reset(undefined, { seed: 7 });
  assert.equal(governed.length, 1);
  assert.equal(governed[0].world?.country, "Canada"); // the edit made before the reset is the one it read
  open(governed[0].world);
  assert.equal(cast.length, 1);
  open(cast[0].world);

  await land(g.engine);
  g.db.prepare("UPDATE entities SET zone_id = 'outdoor', x = 6, y = 9 WHERE id = 'niko'").run();
  assert.equal((await g.engine.takeTurn({ type: "move", dir: "N" })).ok, true);
  assert.equal(zones.length, 1, "entering a building asks the architect");
  assert.equal(zones[0].world?.country, "Canada");
  open(zones[0].world);
});

test("starting a new game keeps the author's world", async () => {
  const g = createGame(":memory:", DATA, 1337, () => offlineServices());
  saveWorldDoc(g.db, edited({ country: "Canada" }));
  await g.reset(undefined, { seed: 7 });
  assert.equal(readWorldDoc(g.db as Db)?.country, "Canada");
});
