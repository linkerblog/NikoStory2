import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import { parseFreeAction } from "../src/engine.js";
import { DEFAULT_RULES } from "../src/rules.js";
import { OfflineInterpreter, interpreterPrompt, parseInterpretation, type Effect, type InterpretContext, type Interpreter } from "../src/interpreter.js";
import type { Ent, Zone } from "../src/world.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));

const zone: Zone = {
  id: "z", name: "the room", description: "", width: 5, height: 5,
  map: ["#####", "#...#", "#...#", "#...#", "#####"],
  objects: [{ id: "crate", type: "furniture", name: "the crate", x: 1, y: 1, blocks: true }],
  rooms: [], portals: [], kind: "house",
};
const niko: Ent = { id: "niko", type: "player", name: "Niko", zone_id: "z", x: 2, y: 2, data: {} };
const marta: Ent = { id: "marta", type: "npc", name: "Marta", zone_id: "z", x: 3, y: 2, data: {} };
const ctx = (text: string, conversation: InterpretContext["conversation"] = null): InterpretContext => ({
  text, tick: 0, sheet: {}, ether: 3, etherMax: 100, rules: DEFAULT_RULES,
  zone, ents: [niko, marta], visible: [], items: [], conversation, memories: [], summary: null, recentNarrations: [],
});

test("OfflineInterpreter returns what parseFreeAction returned, as effects", async () => {
  const interp = new OfflineInterpreter();
  const effects = async (text: string, convo: InterpretContext["conversation"] = null): Promise<Effect[]> =>
    (await interp.interpret(ctx(text, convo))).effects;

  // The deterministic parser is still the single source of truth for the offline path.
  assert.deepEqual(parseFreeAction("go north", zone, [niko, marta], undefined), { type: "move", dir: "N" });
  assert.deepEqual(await effects("go north"), [{ kind: "move", path: ["N"] }]);
  assert.deepEqual(await effects("wait"), [{ kind: "wait" }]);
  assert.deepEqual(await effects("talk to Marta"), [{ kind: "speak", to: "marta", text: "" }]);
  assert.deepEqual(await effects("examine the crate"), [{ kind: "interact", target: "crate", verb: "examine" }]);
  // An unmapped line is a monologue, exactly the engine's old `say` fallback.
  assert.deepEqual(await effects("do a backflip"), [{ kind: "speak", to: null, text: "do a backflip" }]);
  // An open conversation turns any answer into a reply, with the tone from the text.
  assert.deepEqual(
    await effects("reassure her", { npc_id: "marta", npc: "Marta", beat: 1, want: "" }),
    [{ kind: "speak", to: "marta", text: "", tone: "reassure" }],
  );
});

test("parseInterpretation is tolerant of fences and strict about shape", () => {
  assert.deepEqual(parseInterpretation('{"effects":[{"kind":"wait"}],"keywords":["crate"]}'),
    { effects: [{ kind: "wait" }], keywords: ["crate"] });
  assert.deepEqual(
    parseInterpretation('```json\n{"effects":[{"kind":"move","path":["N","X","E"]}]}\n```').effects,
    [{ kind: "move", path: ["N", "E"] }],
  );
  assert.throws(() => parseInterpretation('{"effects":[]}'), /no usable effects/);
  const imp = parseInterpretation('{"effects":[],"impossible":{"reason":"Niko cannot fly."},"keywords":[]}');
  assert.equal(imp.impossible?.reason, "Niko cannot fly.");
});

// A game whose interpreter is a stub, so the engine's validation can be exercised without a model.
const create = (interpreter: Interpreter) => {
  const g = createGame(":memory:", DATA, 1337, () => ({ ...offlineServices(), interpreter }));
  g.db.prepare("UPDATE settings SET value = 'play' WHERE key = 'phase'").run();
  return g;
};
const stub = (effects: Effect[], impossible?: { reason: string }): Interpreter => ({
  async interpret() { return { effects, keywords: [], impossible }; },
});

test("a move effect walks its path in one tick and stops at nothing else", async () => {
  const { engine } = create(stub([{ kind: "move", path: ["N", "N"] }]));
  await engine.start();
  const before = engine.state();
  const r = await engine.takeTurn({ type: "free", text: "walk north" });
  assert.equal(r.ok, true);
  assert.equal(engine.state().niko.y, before.niko.y - 2);
  assert.equal(engine.state().tick, before.tick + 1); // one effect = one tick
});

test("a path through a wall is rejected with a reason and moves nothing", async () => {
  const { engine } = create(stub([{ kind: "move", path: ["W", "W", "W", "W"] }]));
  await engine.start();
  const before = engine.state().niko;
  const r = await engine.takeTurn({ type: "free", text: "walk west" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /blocks/);
  assert.deepEqual(engine.state().niko, before);
  assert.equal(engine.state().tick, 0);
});

test("an unknown object id is rejected with a reason", async () => {
  const { engine } = create(stub([{ kind: "interact", target: "ghost", verb: "open" }]));
  await engine.start();
  const r = await engine.takeTurn({ type: "free", text: "open the ghost" });
  assert.equal(r.ok, false);
  assert.equal(engine.state().tick, 0);
});

test("too many effects are rejected with a reason", async () => {
  const wait = (): Effect => ({ kind: "wait" });
  const { engine } = create(stub([wait(), wait(), wait(), wait(), wait()]));
  await engine.start();
  const r = await engine.takeTurn({ type: "free", text: "wait a lot" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /too much/);
  assert.equal(engine.state().tick, 0);
});

test("an impossible interpretation is narrated and changes nothing", async () => {
  const { engine } = create(stub([], { reason: "Niko cannot fly." }));
  await engine.start();
  const r = await engine.takeTurn({ type: "free", text: "fly to the roof" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /cannot fly/);
  assert.equal(engine.state().tick, 0);
});

test("a risky ability rolls through rngFor and stores the result in the event", async () => {
  const { engine, db } = create(stub([{ kind: "ability", id: "brace" }]));
  await engine.start();
  const r = await engine.takeTurn({ type: "free", text: "brace" });
  assert.equal(r.ok, true);
  const row = db.prepare("SELECT data FROM events WHERE type = 'ability' ORDER BY id DESC LIMIT 1").get() as
    { data: string } | undefined;
  assert.ok(row);
  const data = JSON.parse(row!.data) as { id: string; roll: number };
  assert.equal(data.id, "brace");
  assert.equal(typeof data.roll, "number");
});

test("an unknown ability is rejected with a reason", async () => {
  const { engine } = create(stub([{ kind: "ability", id: "fly" }]));
  await engine.start();
  const r = await engine.takeTurn({ type: "free", text: "fly" });
  assert.equal(r.ok, false);
  assert.equal(engine.state().tick, 0);
});

test("a chain stops at the first rejected effect but keeps what resolved", async () => {
  const { engine } = create(stub([{ kind: "move", path: ["N"] }, { kind: "interact", target: "ghost", verb: "open" }]));
  await engine.start();
  const before = engine.state();
  const r = await engine.takeTurn({ type: "free", text: "walk north and open the ghost" });
  assert.equal(r.ok, true); // the move happened; the rejection only stops the chain
  assert.equal(engine.state().niko.y, before.niko.y - 1);
  assert.equal(engine.state().tick, before.tick + 1);
});

test("the offline parser maps take, drop, search and read onto item actions", () => {
  const items = [
    { id: "letter", name: "a letter addressed to Niko", where: "here" as const },
    { id: "coin", name: "a silver coin", where: "held" as const },
  ];
  const parse = (t: string) => parseFreeAction(t, zone, [niko, marta], undefined, items);
  assert.deepEqual(parse("take the letter"), { type: "item", verb: "take", target: "letter" });
  assert.deepEqual(parse("pick up the letter"), { type: "item", verb: "take", target: "letter" });
  assert.deepEqual(parse("grab letter!"), { type: "item", verb: "take", target: "letter" });
  assert.deepEqual(parse("get the letter"), { type: "item", verb: "take", target: "letter" });
  assert.deepEqual(parse("drop the coin"), { type: "item", verb: "drop", target: "coin" });
  assert.deepEqual(parse("put down the coin"), { type: "item", verb: "drop", target: "coin" });
  assert.deepEqual(parse("read the letter"), { type: "item", verb: "read", target: "letter" });
  assert.deepEqual(parse("read the coin"), { type: "item", verb: "read", target: "coin" });
  assert.deepEqual(parse("search the crate"), { type: "item", verb: "search", target: "crate" });
  assert.deepEqual(parse("open the crate"), { type: "item", verb: "search", target: "crate" });
  // Examine stays an examine, on objects first and then on items.
  assert.deepEqual(parse("examine the crate"), { type: "examine", target: "crate" });
  assert.deepEqual(parse("look at the letter"), { type: "examine", target: "letter" });
  // Only held items can be dropped and only items on the floor can be taken.
  assert.equal(parse("drop the letter"), null);
  assert.equal(parse("take the coin"), null);
  assert.equal(parse("open the ghost"), null);
  assert.equal(parse("take"), null);
});

test("an item action becomes an interact effect with its verb", async () => {
  const items = [{ id: "letter", name: "a letter", where: "here" as const }];
  const out = await new OfflineInterpreter().interpret({ ...ctx("take the letter"), items });
  assert.deepEqual(out.effects, [{ kind: "interact", target: "letter", verb: "take" }]);
});

test("sanitizeEffect maps open to search and grab to take and keeps unknown verbs for the engine", () => {
  const verb = (v: unknown) =>
    (parseInterpretation(JSON.stringify({ effects: [{ kind: "interact", target: "x", verb: v }] })).effects[0] as
      { verb: string }).verb;
  assert.equal(verb("open"), "search");
  assert.equal(verb("Open"), "search");
  assert.equal(verb("grab"), "take");
  assert.equal(verb("pick up"), "take");
  assert.equal(verb("read"), "read");
  assert.equal(verb("EXAMINE"), "examine");
  assert.equal(verb(undefined), "examine");
  assert.equal(verb("eat"), "eat"); // the engine rejects it with a reason
});

test("the interpreter context lists held and visible items and never a hidden one", async () => {
  const box: { seen?: InterpretContext } = {};
  const spy: Interpreter = { async interpret(c) { box.seen = c; return { effects: [{ kind: "wait" }], keywords: [] }; } };
  const { engine, db } = create(spy);
  db.prepare("UPDATE entities SET x = 7, y = 4 WHERE id = 'niko'").run(); // in the living room, in sight of the letter
  await engine.start();
  await engine.takeTurn({ type: "free", text: "look around" });
  assert.deepEqual(box.seen!.items, [{ id: "letter", name: "a letter addressed to Niko", where: "here" }]);
  assert.ok(!JSON.stringify(box.seen!.items).includes("house_key"));

  // The wall between the rooms hides the letter, and the key is hidden until it is searched.
  db.prepare("UPDATE entities SET x = 7, y = 8 WHERE id = 'niko'").run();
  await engine.takeTurn({ type: "free", text: "look around" });
  assert.equal(box.seen!.items.length, 0);

  await engine.takeTurn({ type: "item", verb: "search", target: "wardrobe" });
  await engine.takeTurn({ type: "item", verb: "take", target: "house_key" });
  // The letter is out of sight from here, so only the held key is listed.
  await engine.takeTurn({ type: "free", text: "look around again" });
  assert.deepEqual(box.seen!.items.map((i) => [i.id, i.where]), [["house_key", "held"]]);
});

test("the interpreter prompt closes the verb list", () => {
  assert.match(interpreterPrompt(DEFAULT_RULES, "English"), /examine\|search\|take\|drop\|read/);
});
