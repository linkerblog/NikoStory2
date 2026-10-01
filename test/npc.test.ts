import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import type { EngineServices } from "../src/engine.js";
import {
  OfflineNpcDecider, OpenRouterNpcDecider, npcPrompt, parseNpcDecision,
  type NpcContext, type NpcDecider,
} from "../src/npc.js";
import { LlmClient, LLM_ROLES, type LlmRole, type RoleConfig } from "../src/llm.js";
import { DEFAULT_RULES } from "../src/rules.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));

// Skips the opening the same way the other suites do; the fall is covered by `opening.test.ts`.
const create = (overrides: Partial<EngineServices> = {}) => {
  const g = createGame(":memory:", DATA, 1337, () => ({ ...offlineServices(), ...overrides }));
  g.db.prepare("UPDATE settings SET value = 'play' WHERE key = 'phase'").run();
  return g;
};

const place = (db: import("../src/db.js").Db, id: string, x: number, y: number) =>
  db.prepare("UPDATE entities SET x = ?, y = ? WHERE id = ?").run(x, y, id);

const moveCount = (db: import("../src/db.js").Db, id: string) =>
  (db.prepare("SELECT COUNT(*) c FROM events WHERE type = 'move' AND actor_id = ?").get(id) as { c: number }).c;

test("the offline decider leaves the deterministic agenda unchanged", async () => {
  const a = create();
  const b = create({ npcdecider: new OfflineNpcDecider() });
  for (const g of [a, b]) {
    await g.engine.start();
    for (let i = 0; i < 30; i++) await g.engine.takeTurn({ type: "wait" });
  }
  assert.deepEqual(a.engine.positions(), b.engine.positions());
  assert.deepEqual(
    a.db.prepare("SELECT character_id, status FROM agenda_state ORDER BY character_id").all(),
    b.db.prepare("SELECT character_id, status FROM agenda_state ORDER BY character_id").all(),
  );
});

test("the decider is asked only for visible NPCs and only on the cadence", async () => {
  const seen: { id: string; tick: number }[] = [];
  const decider: NpcDecider = {
    async decide(c) { seen.push({ id: c.actor.id, tick: c.tick }); return null; },
  };
  const { engine, db } = create({ npcdecider: decider });
  place(db, "niko", 5, 2); // next to Marta at (6,2); Ivy moved out of sight
  place(db, "ivy", 1, 13);
  await engine.start();
  for (let i = 0; i < 7; i++) await engine.takeTurn({ type: "wait" });

  assert.ok(seen.length > 0);
  assert.ok(seen.every((s) => s.tick % 3 === 0), JSON.stringify(seen));
  assert.ok(seen.every((s) => s.id === "marta"), JSON.stringify(seen));
  const keys = seen.map((s) => `${s.tick}:${s.id}`);
  assert.equal(new Set(keys).size, keys.length); // never twice in one tick
});

test("an NPC proposal moves the actor through the shared tile checks", async () => {
  const decider: NpcDecider = {
    async decide(c) {
      return c.actor.id === "marta" ? { effects: [{ kind: "move", path: ["E"] }] } : null;
    },
  };
  const { engine, db } = create({ npcdecider: decider });
  place(db, "niko", 6, 1); // adjacent to Marta at (6,2); (7,2) is free
  place(db, "ivy", 1, 13);
  await engine.start();
  for (let i = 0; i < 3; i++) await engine.takeTurn({ type: "wait" });

  assert.deepEqual(engine.positions().marta, [7, 2]);
  const last = db.prepare(
    "SELECT actor_id, data FROM events WHERE type = 'move' AND actor_id = 'marta' ORDER BY id DESC LIMIT 1",
  ).get() as { actor_id: string; data: string };
  assert.equal(JSON.parse(last.data).dir, "E");
});

test("a proposal into a blocked tile is rejected and records no move", async () => {
  const decider: NpcDecider = {
    async decide() { return { effects: [{ kind: "move", path: ["S"] }] }; }, // the kitchen table blocks S
  };
  const { engine, db } = create({ npcdecider: decider });
  place(db, "niko", 6, 1);
  place(db, "ivy", 1, 13);
  await engine.start();
  for (let i = 0; i < 3; i++) await engine.takeTurn({ type: "wait" });

  assert.deepEqual(engine.positions().marta, [6, 2]);
  assert.equal(moveCount(db, "marta"), 0);
});

test("two NPCs hold a capped conversation the engine closes, writing no fact", async () => {
  const decider: NpcDecider = {
    async decide(c) {
      const to = c.conversation?.partner ?? c.visible.find((v) => v.id !== "niko")?.id;
      if (!to) return null;
      return { effects: [{ kind: "speak", to, text: `${c.actor.name} says something.` }] };
    },
  };
  const { engine, db } = create({ npcdecider: decider });
  place(db, "niko", 5, 2); // sees Marta at (6,2) and Ivy at (7,2)
  // Ivy stays put: no agenda, and a wander chance of zero.
  const ivy = JSON.parse((db.prepare("SELECT data FROM entities WHERE id = 'ivy'").get() as { data: string }).data);
  delete ivy.agenda;
  ivy.routine = { type: "wander", prob: 0 };
  db.prepare("UPDATE entities SET x = 7, y = 2, data = ? WHERE id = 'ivy'").run(JSON.stringify(ivy));
  await engine.start();
  for (let i = 0; i < 15; i++) await engine.takeTurn({ type: "wait" });

  const closed = db.prepare(
    "SELECT COUNT(*) c FROM conversations WHERE initiator_id = 'marta' AND listener_id = 'ivy' AND status = 'closed'",
  ).get() as { c: number };
  assert.ok(closed.c >= 1);
  const facts = (db.prepare("SELECT COUNT(*) c FROM facts_known").get() as { c: number }).c;
  assert.equal(facts, 0); // an NPC-to-NPC exchange reveals nothing to Niko

  const talk = db.prepare("SELECT id FROM events WHERE type = 'talk' AND actor_id = 'marta' ORDER BY id LIMIT 1").get() as
    { id: number } | undefined;
  assert.ok(talk);
  const witnesses = (db.prepare("SELECT character_id FROM witnesses WHERE event_id = ?").all(talk.id) as
    { character_id: string }[]).map((r) => r.character_id);
  assert.ok(witnesses.includes("niko")); // Niko was watching; only witnesses are stored
});

test("the decider gets the actor's own ranked memories and who the character is", async () => {
  const seen: NpcContext[] = [];
  const decider: NpcDecider = { async decide(c) { seen.push(c); return null; } };
  const { engine, db } = create({ npcdecider: decider });
  place(db, "niko", 5, 2); // next to Marta, who sees every turn
  place(db, "ivy", 1, 13);
  await engine.start();
  for (let i = 0; i < 7; i++) await engine.takeTurn({ type: "wait" });

  const marta = seen.filter((c) => c.actor.id === "marta");
  assert.ok(marta.length > 1);
  const last = marta.at(-1)!;
  assert.ok(last.memories.length > 0);
  assert.ok(last.memories.every((m) => /^t\d+: /.test(m)));
  assert.ok(last.memories.some((m) => /Niko waited/.test(m)), last.memories.join(" | "));

  // Only what Marta herself witnessed: every line is one of her own rows.
  const own = new Set((db.prepare("SELECT text FROM memories WHERE character_id = 'marta'").all() as { text: string }[]).map((r) => r.text));
  for (const line of last.memories) assert.ok(own.has(line.replace(/^t\d+: /, "")), line);

  // The depth the data file wrote reaches the prompt as plain fields.
  assert.deepEqual(last.actor.traits, ["serious", "direct", "responsible"]);
  assert.match(last.actor.quirk!, /Squares the edge/);
  assert.match(last.actor.fear!, /warning/);
  assert.match(last.actor.backstory!, /dispatcher/);
});

test("the prompt tells who the character is, what they remember and what daily life is for", () => {
  const base: NpcContext = {
    tick: 3, actor: { id: "marta", name: "Marta", personality: "serious", voice: "Blunt." }, agenda: null,
    place: { id: "house_001", name: "House", room: "Living Room" },
    visible: [], objects: [], ether: 0, conversation: null, recentEvents: [], memories: [], rules: DEFAULT_RULES,
  };
  const bare = npcPrompt(base);
  assert.match(bare, /Character: Marta, serious\. Blunt\./);
  assert.doesNotMatch(bare, /Traits:|Quirk:|Fear:|Background:/); // a legacy character has no depth lines
  assert.match(bare, /"memories" is what this character remembers/);
  assert.match(bare, /world\.life/);

  const deep = npcPrompt({ ...base, actor: { ...base.actor, traits: ["wary", "guarded"], quirk: "Taps the table.", fear: "Being cheated.", backstory: "Ran a stall." } });
  assert.match(deep, /Traits: wary, guarded\./);
  assert.match(deep, /Quirk: Taps the table\./);
  assert.match(deep, /Fear: Being cheated\./);
  assert.match(deep, /Background: Ran a stall\./);
});

test("the OpenRouter decider sends the memories with the situation", async () => {
  const { db } = create();
  const original = globalThis.fetch;
  const bodies: any[] = [];
  (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"effects":[{"kind":"wait"}]}' } }], usage: { prompt_tokens: 5, completion_tokens: 7, cost: 0.001 } }), { status: 200 });
  };
  try {
    const roles = Object.fromEntries(LLM_ROLES.map((r) => [r, { model: "m", reasoning: false, idleMs: 5000 }])) as Record<LlmRole, RoleConfig>;
    const llm = new LlmClient(db, { apiKey: "t", language: "English", spendCapUsd: 0.5, roles });
    const ctx: NpcContext = {
      tick: 3, actor: { id: "marta", name: "Marta", personality: "serious", quirk: "Taps the table." }, agenda: null,
      place: { id: "house_001", name: "House", room: "Living Room" },
      visible: [], objects: [], ether: 0, conversation: null, recentEvents: [],
      memories: ["t1: Niko came into view."], rules: DEFAULT_RULES,
    };
    assert.deepEqual(await new OpenRouterNpcDecider(llm).decide(ctx), { effects: [{ kind: "wait" }] });
    assert.equal(bodies.length, 1);
    assert.match(bodies[0].messages[0].content, /Quirk: Taps the table\./);
    const user = JSON.parse(bodies[0].messages[1].content);
    assert.deepEqual(user.memories, ["t1: Niko came into view."]);
    assert.equal(user.character.quirk, "Taps the table.");
  } finally { (globalThis as { fetch: unknown }).fetch = original; }
});

test("the OpenRouter decider returns null over budget without a call", async () => {
  const { db } = create();
  db.prepare(
    `INSERT INTO llm_calls (tick, role, model, tokens_input, tokens_output, cost, request, response)
     VALUES (0, 'npc', 'test', 0, 0, 1, '{}', '')`,
  ).run();
  const roles = Object.fromEntries(
    LLM_ROLES.map((r) => [r, { model: "test", reasoning: false, idleMs: 1000 }]),
  ) as Record<LlmRole, RoleConfig>;
  const llm = new LlmClient(db, { apiKey: "test", language: "English", spendCapUsd: 0.5, roles });
  const ctx: NpcContext = {
    tick: 3,
    actor: { id: "marta", name: "Marta", personality: "serious" },
    agenda: null,
    place: { id: "house_001", name: "House", room: "Living Room" },
    visible: [], objects: [], ether: 0, conversation: null, recentEvents: [], memories: [], rules: DEFAULT_RULES,
  };
  assert.equal(await new OpenRouterNpcDecider(llm).decide(ctx), null);
});

test("parseNpcDecision keeps valid effects and drops malformed ones", () => {
  const parsed = parseNpcDecision('{"effects":[{"kind":"move","path":["N","X"]},{"kind":"nope"},{"kind":"wait"}]}');
  assert.deepEqual(parsed, { effects: [{ kind: "move", path: ["N"] }, { kind: "wait" }] });
  assert.equal(parseNpcDecision("no json here"), null);
  assert.equal(parseNpcDecision('{"effects":[]}'), null);
});
