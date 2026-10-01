import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import type { Action } from "../src/engine.js";
import type { Db } from "../src/db.js";
import type { Effect, Interpreter } from "../src/interpreter.js";
import { loadItems } from "../src/items.js";
import { loadScene } from "../src/stakes.js";
import { DEFAULT_RULES, loadRules } from "../src/rules.js";
import type { Zone } from "../src/world.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));

// The letter lies on the kitchen table (6,3) and the key is hidden in the wardrobe (8,8). Niko is
// moved next to one of them; the opening is skipped the way the other suites skip it.
const create = (data = DATA, interpreter?: Interpreter) => {
  const g = createGame(":memory:", data, 1337, () => ({ ...offlineServices(), ...(interpreter ? { interpreter } : {}) }));
  g.db.prepare("UPDATE settings SET value = 'play' WHERE key = 'phase'").run();
  return g;
};
const place = (db: Db, x: number, y: number) => db.prepare("UPDATE entities SET x = ?, y = ? WHERE id = 'niko'").run(x, y);
const item = (db: Db, id: string) => db.prepare("SELECT * FROM items WHERE id = ?").get(id) as
  { zone_id: string | null; x: number | null; y: number | null; holder_id: string | null; hidden: number };
const count = (db: Db, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { c: number }).c;
const act = (a: Action) => a;
const take = (target: string) => act({ type: "item", verb: "take", target });
const stub = (effects: Effect[]): Interpreter => ({ async interpret() { return { effects, keywords: [] }; } });

test("taking an adjacent item holds it, clears its tile and records a witnessed event", async () => {
  const { engine, db } = create();
  place(db, 6, 4); // right under the table
  await engine.start();
  const tick = engine.state().tick;
  const r = await engine.takeTurn(take("letter"));
  assert.equal(r.ok, true);
  const held = item(db, "letter");
  assert.deepEqual([held.holder_id, held.zone_id, held.x, held.y], ["niko", null, null, null]);
  assert.equal(engine.state().tick, tick + 1);
  assert.deepEqual(engine.state().inventory, [{ id: "letter", name: "a letter addressed to Niko" }]);
  assert.ok(!engine.state().items.some((i) => i.id === "letter"));
  const ev = db.prepare("SELECT id, actor_id FROM events WHERE type = 'take'").all() as { id: number; actor_id: string }[];
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor_id, "niko");
  const witnesses = (db.prepare("SELECT character_id FROM witnesses WHERE event_id = ?").all(ev[0].id) as { character_id: string }[])
    .map((w) => w.character_id);
  assert.ok(witnesses.includes("niko"));
  const memory = db.prepare("SELECT text FROM memories WHERE event_id = ? AND character_id = 'niko'").get(ev[0].id) as { text: string };
  assert.equal(memory.text, "Niko took a letter addressed to Niko.");
});

test("a rejected item verb spends no tick and writes no event", async () => {
  const { engine, db } = create();
  await engine.start();
  const before = () => [engine.state().tick, count(db, "SELECT COUNT(*) c FROM events WHERE type != 'narration'")];
  const rejected = async (a: Action, reason: RegExp) => {
    const snapshot = before();
    const r = await engine.takeTurn(a);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", reason);
    assert.deepEqual(before(), snapshot);
  };

  place(db, 6, 5); // two tiles from the letter
  await rejected(take("letter"), /out of reach/);
  assert.equal(item(db, "letter").holder_id, null);

  place(db, 7, 8); // next to the wardrobe, but the key is still hidden
  await rejected(take("house_key"), /no such item/);
  await rejected(take("nonexistent"), /no such item/);

  place(db, 6, 4);
  for (let i = 0; i < DEFAULT_RULES.inventorySlots; i++) {
    db.prepare("INSERT INTO items (id, name, holder_id, data) VALUES (?, ?, 'niko', '{\"portable\":true}')").run(`filler${i}`, `filler ${i}`);
  }
  await rejected(take("letter"), /cannot carry any more/);
  assert.equal(item(db, "letter").holder_id, null);
});

test("the inventory limit comes from rules.json", () => {
  assert.equal(loadRules(DATA).inventorySlots, 8);
  const dir = mkdtempSync(join(tmpdir(), "niko-rules-"));
  cpSync(DATA, dir, { recursive: true });
  const rules = JSON.parse(readFileSync(join(dir, "rules.json"), "utf-8"));
  rules.inventorySlots = 0;
  writeFileSync(join(dir, "rules.json"), JSON.stringify(rules));
  assert.throws(() => loadRules(dir), /inventorySlots/);
  delete rules.inventorySlots;
  writeFileSync(join(dir, "rules.json"), JSON.stringify(rules));
  assert.equal(loadRules(dir).inventorySlots, 8);
});

test("an item that is not portable cannot be taken", async () => {
  const { engine, db } = create();
  place(db, 6, 4);
  db.prepare("UPDATE items SET data = '{\"portable\":false}' WHERE id = 'letter'").run();
  await engine.start();
  const r = await engine.takeTurn(take("letter"));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /cannot be carried/);
});

test("dropping puts the item on Niko's tile and only a held item can be dropped", async () => {
  const { engine, db } = create();
  place(db, 6, 4);
  await engine.start();
  const notHeld = await engine.takeTurn(act({ type: "item", verb: "drop", target: "letter" }));
  assert.equal(notHeld.ok, false);
  await engine.takeTurn(take("letter"));
  place(db, 3, 4);
  const r = await engine.takeTurn(act({ type: "item", verb: "drop", target: "letter" }));
  assert.equal(r.ok, true);
  const dropped = item(db, "letter");
  assert.deepEqual([dropped.zone_id, dropped.x, dropped.y, dropped.holder_id], ["house_001", 3, 4, null]);
  assert.deepEqual(engine.state().items.find((i) => i.id === "letter"), { id: "letter", name: "a letter addressed to Niko", x: 3, y: 4 });
  assert.equal(engine.state().inventory.length, 0);
});

test("searching the wardrobe reveals the key, and only then can it be taken", async () => {
  const { engine, db } = create();
  place(db, 7, 8);
  await engine.start();
  assert.ok(!engine.state().items.some((i) => i.id === "house_key")); // hidden items never reach the client
  assert.equal((await engine.takeTurn(take("house_key"))).ok, false);

  const r = await engine.takeTurn(act({ type: "item", verb: "search", target: "wardrobe" }));
  assert.equal(r.ok, true);
  assert.equal(item(db, "house_key").hidden, 0);
  const ev = db.prepare("SELECT data FROM events WHERE type = 'search'").get() as { data: string };
  assert.deepEqual(JSON.parse(ev.data), { target: "wardrobe", found: ["house_key"] });
  assert.ok(engine.state().items.some((i) => i.id === "house_key"));

  assert.equal((await engine.takeTurn(take("house_key"))).ok, true);
  // Searching again finds nothing and still succeeds.
  const again = await engine.takeTurn(act({ type: "item", verb: "search", target: "wardrobe" }));
  assert.equal(again.ok, true);
  assert.deepEqual(JSON.parse((db.prepare("SELECT data FROM events WHERE type = 'search' ORDER BY id DESC").get() as { data: string }).data).found, []);
});

test("searching needs an object within reach", async () => {
  const { engine, db } = create();
  place(db, 4, 4);
  await engine.start();
  assert.equal((await engine.takeTurn(act({ type: "item", verb: "search", target: "wardrobe" }))).ok, false);
  assert.equal((await engine.takeTurn(act({ type: "item", verb: "search", target: "no_such_object" }))).ok, false);
});

test("reading teaches Niko the fact and nobody who watched", async () => {
  const { engine, db } = create();
  place(db, 5, 2); // next to Marta, who watches
  await engine.start();
  assert.equal((await engine.takeTurn(act({ type: "item", verb: "read", target: "letter" }))).ok, true); // from the floor, in reach
  const known = (db.prepare("SELECT character_id FROM facts_known WHERE fact_id = 'fact_letter_text'").all() as { character_id: string }[])
    .map((r) => r.character_id);
  assert.deepEqual(known, ["niko"]);
  const ev = db.prepare("SELECT id, data FROM events WHERE type = 'read'").get() as { id: number; data: string };
  assert.deepEqual(JSON.parse(ev.data), { target: "letter", fact_id: "fact_letter_text" });
  const watchers = (db.prepare("SELECT character_id FROM witnesses WHERE event_id = ?").all(ev.id) as { character_id: string }[])
    .map((w) => w.character_id);
  assert.ok(watchers.includes("marta")); // she saw him read, but learned nothing from it
  assert.ok(!db.prepare("SELECT 1 FROM memories WHERE character_id = 'marta' AND text LIKE '%authored%'").get());
});

test("reading needs an item in reach with text on it", async () => {
  const { engine, db } = create();
  place(db, 4, 6);
  await engine.start();
  const far = await engine.takeTurn(act({ type: "item", verb: "read", target: "letter" }));
  assert.equal(far.ok, false);
  place(db, 7, 8);
  await engine.takeTurn(act({ type: "item", verb: "search", target: "wardrobe" }));
  const blank = await engine.takeTurn(act({ type: "item", verb: "read", target: "house_key" }));
  assert.equal(blank.ok, false);
  assert.match(blank.error ?? "", /nothing to read/);
  assert.equal(count(db, "SELECT COUNT(*) c FROM facts_known WHERE character_id = 'niko'"), 0);
});

test("an unknown interact verb is rejected with a reason, not turned into an examine", async () => {
  const { engine, db } = create(DATA, stub([{ kind: "interact", target: "table", verb: "eat" }]));
  place(db, 6, 4);
  await engine.start();
  const r = await engine.takeTurn({ type: "free", text: "eat the table" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "Niko cannot do that with it.");
  assert.equal(count(db, "SELECT COUNT(*) c FROM events WHERE type = 'examine'"), 0);
  assert.equal(engine.state().tick, 0);
});

test("examining an item shows its description", async () => {
  const { engine, db } = create();
  place(db, 6, 4);
  await engine.start();
  const r = await engine.takeTurn({ type: "free", text: "examine the letter" });
  assert.equal(r.ok, true);
  assert.match(engine.state().log.at(-1)!.text, /folded sheet/);
});

test("free text drives the whole item loop through the offline parser", async () => {
  const { engine, db } = create();
  place(db, 6, 4);
  await engine.start();
  assert.equal((await engine.takeTurn({ type: "free", text: "pick up the letter" })).ok, true);
  assert.equal(item(db, "letter").holder_id, "niko");
  assert.equal((await engine.takeTurn({ type: "free", text: "read the letter" })).ok, true);
  assert.equal(count(db, "SELECT COUNT(*) c FROM facts_known WHERE fact_id = 'fact_letter_text'"), 1);
  assert.equal((await engine.takeTurn({ type: "free", text: "drop the letter" })).ok, true);
  assert.equal(item(db, "letter").holder_id, null);
});

test("the CHECK refuses an item with both owners or none", () => {
  const { db } = create();
  const ins = db.prepare("INSERT INTO items (id, name, zone_id, x, y, holder_id) VALUES (?, 'x', ?, ?, ?, ?)");
  assert.throws(() => ins.run("both", "house_001", 1, 1, "niko"), /CHECK/);
  assert.throws(() => ins.run("neither", null, null, null, null), /CHECK/);
  assert.throws(() => db.prepare("UPDATE items SET holder_id = 'niko' WHERE id = 'letter'").run(), /CHECK/);
});

// ---- The scene goal ----
const resolvedEvents = (db: Db) => count(db, "SELECT COUNT(*) c FROM events WHERE type = 'scene_resolved'");
const talkToMarta = async (engine: ReturnType<typeof create>["engine"]) => {
  assert.equal((await engine.takeTurn({ type: "talk", target: "marta" })).ok, true);
  for (let i = 0; i < 4; i++) assert.equal((await engine.takeTurn({ type: "reply", target: "marta", choice: "ask" })).ok, true);
};

test("the scene resolves once, on the turn the last fact is learned: conversation first, then reading", async () => {
  const { engine, db } = create();
  place(db, 5, 2); // next to Marta and, diagonally, the letter
  await engine.start();
  await talkToMarta(engine);
  assert.equal(resolvedEvents(db), 0);
  assert.equal(engine.state().scene.resolved, false);
  assert.equal(engine.state().scene.goal?.text, null); // the answer is not sent before it is known
  const tick = engine.state().tick;
  await engine.takeTurn(act({ type: "item", verb: "read", target: "letter" }));
  assert.equal(resolvedEvents(db), 1);
  assert.equal(engine.state().scene.resolved, true);
  assert.equal(engine.state().scene.goal?.text, "<authored by the user>");
  const mark = db.prepare("SELECT value FROM settings WHERE key = 'scene_resolved'").get() as { value: string };
  assert.equal(mark.value, String(tick + 1));
  await engine.takeTurn(act({ type: "item", verb: "read", target: "letter" }));
  await engine.takeTurn({ type: "wait" });
  assert.equal(resolvedEvents(db), 1);
});

test("the scene resolves once: reading first, then the conversation closes it", async () => {
  const { engine, db } = create();
  place(db, 5, 2);
  await engine.start();
  await engine.takeTurn(act({ type: "item", verb: "read", target: "letter" }));
  assert.equal(resolvedEvents(db), 0);
  await engine.takeTurn(act({ type: "talk", target: "marta" }));
  for (let i = 0; i < 3; i++) await engine.takeTurn({ type: "reply", target: "marta", choice: "ask" });
  assert.equal(resolvedEvents(db), 0); // the fact arrives with the closing beat
  await engine.takeTurn({ type: "reply", target: "marta", choice: "ask" });
  assert.equal(resolvedEvents(db), 1);
  const ev = db.prepare("SELECT id, actor_id FROM events WHERE type = 'scene_resolved'").get() as { id: number; actor_id: string };
  assert.equal(ev.actor_id, "niko");
  const m = db.prepare("SELECT text, importance FROM memories WHERE event_id = ? AND character_id = 'niko'").get(ev.id) as { text: string; importance: number };
  assert.equal(m.text, "Niko understood why he fell.");
  assert.equal(m.importance, 9);
  await engine.takeTurn({ type: "wait" });
  assert.equal(resolvedEvents(db), 1);
});

test("the narrator is told when the scene resolves, and only on that turn", async () => {
  const seen: { resolved?: boolean; justResolved?: boolean; goal?: string }[] = [];
  const g = createGame(":memory:", DATA, 1337, () => ({
    ...offlineServices(),
    narrator: {
      async narrate(c) { seen.push({ ...c.scene }); return { text: c.events.join(" ") }; },
    },
  }));
  g.db.prepare("UPDATE settings SET value = 'play' WHERE key = 'phase'").run();
  place(g.db, 5, 2);
  await g.engine.start();
  await talkToMarta(g.engine);
  seen.length = 0;
  await g.engine.takeTurn(act({ type: "item", verb: "read", target: "letter" }));
  await g.engine.takeTurn(act({ type: "item", verb: "read", target: "letter" })); // a waiting turn is not narrated
  assert.equal(seen[0].justResolved, true);
  assert.equal(seen[0].goal, "<authored by the user>");
  assert.equal(seen[1].resolved, true);
  assert.equal(seen[1].justResolved, false);
});

test("a scene with no goal never resolves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niko-nogoal-"));
  cpSync(DATA, dir, { recursive: true });
  const scene = JSON.parse(readFileSync(join(dir, "scene.json"), "utf-8"));
  delete scene.goal;
  writeFileSync(join(dir, "scene.json"), JSON.stringify(scene));
  const { engine, db } = create(dir);
  place(db, 5, 2);
  await engine.start();
  await talkToMarta(engine);
  await engine.takeTurn(act({ type: "item", verb: "read", target: "letter" }));
  assert.equal(count(db, "SELECT COUNT(*) c FROM facts_known WHERE character_id = 'niko'"), 2);
  assert.equal(resolvedEvents(db), 0);
  assert.equal(engine.state().scene.goal, null);
  assert.equal(engine.state().scene.resolved, false);
});

// ---- Data validation ----
const house = (): Zone => ({
  id: "house_001", name: "House", description: "", width: 10, height: 15, map: [], objects: [], rooms: [], portals: [], kind: "house",
});
const scene = () => loadScene(DATA);
const write = (items: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "niko-items-"));
  writeFileSync(join(dir, "items.json"), JSON.stringify(items));
  return dir;
};
const known = (id: string) => (id === "house_001" ? house() : undefined);
const base = { id: "a", name: "an a", zone_id: "house_001", x: 1, y: 1, data: {} };

test("a malformed items file is rejected on load", () => {
  assert.equal(loadItems(DATA, known, scene()).length, 2);
  assert.throws(() => loadItems(write([{ ...base, zone_id: "mars" }]), known, scene()), /unknown zone/);
  assert.throws(() => loadItems(write([{ ...base, x: 10 }]), known, scene()), /outside/);
  assert.throws(() => loadItems(write([{ ...base, y: -1 }]), known, scene()), /outside/);
  assert.throws(() => loadItems(write([base, base]), known, scene()), /duplicate/);
  assert.throws(() => loadItems(write([{ ...base, data: { text: "t", reveals: "fact_nope" } }]), known, scene()), /unknown fact/);
  assert.throws(() => loadItems(write([{ ...base, data: { reveals: "fact_letter_text" } }]), known, scene()), /no text/);
  assert.throws(() => loadItems(write({}), known, scene()), /list/);
});

test("a goal that requires an unknown fact is rejected on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "niko-goal-"));
  cpSync(DATA, dir, { recursive: true });
  const s = JSON.parse(readFileSync(join(dir, "scene.json"), "utf-8"));
  s.goal.requires = ["fact_marta_warning", "fact_missing"];
  writeFileSync(join(dir, "scene.json"), JSON.stringify(s));
  assert.throws(() => loadScene(dir), /unknown fact/);
});
