import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { openDb, setMeta, type Db } from "../src/db.js";
import { loadMemoryRules } from "../src/memory.js";
import { LlmClient, type LlmConfig, type RoleConfig } from "../src/llm.js";
import {
  OfflineNarrator, OpenRouterNarrator, parseContinuity, parseNarration, partialNarration, hasTileCount,
  jaccard, narrationRejected, type Context, type Delta,
} from "../src/narrator.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));

const role = (over: Partial<RoleConfig> = {}): RoleConfig => ({ model: "m", reasoning: false, idleMs: 5000, ...over });
const cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  apiKey: "t", language: "English", spendCapUsd: 0.5,
  roles: { interpreter: role(), narrator: role(), architect: role(), continuity: role(), memory: role(), npc: role(), cast: role(), government: role() },
  ...over,
});
const stubDb = () => ({ prepare: () => ({ get: () => ({ t: 0 }), run: () => {} }) }) as unknown as Db;
const narratorFor = (db: Db, over: Partial<LlmConfig> = {}, rules = loadMemoryRules(DATA)) =>
  new OpenRouterNarrator(new LlmClient(db, cfg(over)), rules);

const ctx: Context = {
  tick: 0,
  sheet: {},
  place: { name: "Room", description: "" },
  visible: [],
  events: ["Something happens."],
};

// A fetch stub that answers each call with the next queued content, and counts the calls.
function stubFetch(contents: string[]) {
  const original = globalThis.fetch;
  let calls = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    const content = contents[Math.min(calls, contents.length - 1)];
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), { status: 200 });
  };
  return { restore: () => { (globalThis as { fetch: unknown }).fetch = original; }, calls: () => calls };
}

test("parseNarration reads the narration and no longer requires options", () => {
  const n = parseNarration('{"narration":"Hello"}');
  assert.equal(n.text, "Hello");
  assert.ok(!("options" in n));
});

test("parseNarration tolerates prose, fences and old option-bearing events", () => {
  assert.equal(parseNarration('Here it is:\n```json\n{"narration":"Hi"}\n```').text, "Hi");
  // A narration event stored by an older version still loads; its options are simply ignored.
  assert.equal(parseNarration('{"narration":"Old","options":[{"id":"wait","text":"Wait"}]}').text, "Old");
});

test("parseNarration names an empty or object-less response", () => {
  assert.throws(() => parseNarration(""), /has no JSON object/);
  assert.throws(() => parseNarration("I cannot help with that."), /has no JSON object/);
});

test("parseNarration blames truncation at max_tokens", () => {
  assert.throws(() => parseNarration('{"narration":"cut off', "length"), /truncated at max_tokens/);
});

test("parseNarration rejects malformed JSON without leaking the raw parse error", () => {
  assert.throws(() => parseNarration('{"narration":"x",]}'), /not valid JSON/);
});

test("parseContinuity reads the verdict and drops bad problems", () => {
  assert.deepEqual(parseContinuity('{"ok":true,"problems":[]}'), { ok: true, problems: [] });
  assert.deepEqual(parseContinuity('{"ok":false,"problems":["inv",3,"real"]}'), { ok: false, problems: ["inv", "real"] });
  assert.throws(() => parseContinuity("no json"));
});

test("the LLM narrator falls back to offline, and is marked degraded", async () => {
  const s = stubFetch(['{"narration":"cut']);
  try {
    const out = await narratorFor(stubDb()).narrate(ctx);
    assert.equal(out.text, "Something happens."); // the offline narrator echoes the events
    assert.equal(out.degraded, true);
  } finally {
    s.restore();
  }
});

test("the OpenRouter prompt carries Niko's memories inside the prompt budget", async () => {
  const db = openDb(":memory:");
  const addEvent = db.prepare("INSERT INTO events (tick, zone_id, type, data) VALUES (?, ?, ?, ?)");
  const addMemory = db.prepare(
    `INSERT INTO memories (character_id, event_id, tick, zone_id, text, importance, participants)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 20; i++) {
    const eventId = Number(addEvent.run(i, "house_001", "wait", "{}").lastInsertRowid);
    addMemory.run("niko", eventId, i, "house_001", `Niko remembered step ${i}. ${"x".repeat(180)}`, 5, "[]");
  }

  const rules = loadMemoryRules(DATA);
  let captured: { messages: { content: string }[] } | undefined;
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"narration":"ok"}' } }], usage: {} }), { status: 200 });
  };
  try {
    await narratorFor(db, {}, rules).narrate({
      ...ctx, tick: 20, memory: { characterId: "niko", tick: 20, zoneId: "house_001", presentCharacters: [] },
    });
  } finally {
    (globalThis as { fetch: unknown }).fetch = original;
  }

  const user = JSON.parse(captured!.messages[1].content) as { niko_memories: string[] };
  const lines = user.niko_memories;
  assert.ok(Array.isArray(lines) && lines.length > 0);
  assert.ok(lines.length <= rules.recall.promptMaxItems);
  assert.ok(lines.reduce((n, l) => n + l.length, 0) <= rules.recall.promptMaxChars);
  assert.match(lines[0], /^t\d+: /);
  const ticks = lines.map((l) => Number(l.slice(1, l.indexOf(":"))));
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b)); // chronological
});

test("the memory block is empty when the character has no memories", async () => {
  const db = openDb(":memory:");
  let captured: { messages: { content: string }[] } | undefined;
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"narration":"ok"}' } }], usage: {} }), { status: 200 });
  };
  try {
    await narratorFor(db).narrate({
      ...ctx, memory: { characterId: "niko", tick: 0, zoneId: "house_001", presentCharacters: [] },
    });
  } finally {
    (globalThis as { fetch: unknown }).fetch = original;
  }
  const user = JSON.parse(captured!.messages[1].content) as { niko_memories: string[] };
  assert.deepEqual(user.niko_memories, []);
});

test("partialNarration reads the narration field while it streams", () => {
  assert.equal(partialNarration('{"narration":"Niko la'), "Niko la");
  assert.equal(partialNarration('{"narration":"a\\"b\\n'), 'a"b\n');
  assert.equal(partialNarration('{"options":[]'), null);
  assert.equal(partialNarration('{"narration":"Done"}'), "Done");
});

test("the LLM narrator streams reasoning and narration deltas and logs its role", async () => {
  const enc = new TextEncoder();
  const sse = (objs: unknown[]) => new Response(new ReadableStream({
    start(c) { for (const o of objs) c.enqueue(enc.encode(`data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`)); c.close(); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () => sse([
    { choices: [{ delta: { reasoning: "think " } }] },
    { choices: [{ delta: { content: '{"narration":"Niko ' } }] },
    { choices: [{ delta: { content: 'lands."' } }] },
    { choices: [{ delta: { content: '}' } }] },
    { usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.01 } },
    "[DONE]",
  ]);
  try {
    const db = openDb(":memory:");
    const deltas: Delta[] = [];
    const out = await narratorFor(db).narrate(ctx, (d) => deltas.push(d));
    assert.equal(out.text, "Niko lands.");
    assert.deepEqual(deltas, [
      { kind: "reasoning", text: "think " },
      { kind: "text", text: "Niko " },
      { kind: "text", text: "lands." },
    ]);
    const row = db.prepare("SELECT role, tokens_input, tokens_output, cost FROM llm_calls").get();
    assert.deepEqual(row, { role: "narrator", tokens_input: 3, tokens_output: 2, cost: 0.01 });
  } finally {
    (globalThis as { fetch: unknown }).fetch = original;
  }
});

test("a saved system prompt override is sent instead of the default", async () => {
  let captured: { messages: { role: string; content: string }[] } | undefined;
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"narration":"ok"}' } }], usage: {} }), { status: 200 });
  };
  try {
    const db = openDb(":memory:");
    setMeta(db, "prompt_system", "CUSTOM SYSTEM");
    await narratorFor(db).narrate(ctx);
    assert.equal(captured!.messages[0].content, "CUSTOM SYSTEM");
  } finally {
    (globalThis as { fetch: unknown }).fetch = original;
  }
});

test("narrationRejected flags tile counts and too-similar narrations", () => {
  assert.equal(hasTileCount("Marta is seven tiles north."), true);
  assert.equal(hasTileCount("Marta is 3 m away."), true);
  assert.equal(hasTileCount("Marta stands beside Niko."), false);
  assert.ok(jaccard("Niko waits in the room", "Niko waits in the room") >= 0.99);
  assert.equal(narrationRejected("Marta is two tiles east.", [], 0.6), true);
  assert.equal(narrationRejected("Marta speaks quickly.", ["Marta speaks quickly and firmly."], 0.6), true);
  assert.equal(narrationRejected("Ivy opens the door.", ["Marta speaks quickly."], 0.6), false);
});

test("a rejected narration is retried once and the retry is used", async () => {
  const s = stubFetch([
    '{"narration":"Marta is seven tiles north."}',
    '{"narration":"Marta stands beside Niko."}',
  ]);
  try {
    const out = await narratorFor(stubDb()).narrate(ctx);
    assert.equal(out.text, "Marta stands beside Niko.");
    assert.equal(s.calls(), 2);
  } finally {
    s.restore();
  }
});

test("a second rejection accepts the offline narration as degraded", async () => {
  const s = stubFetch(['{"narration":"Marta is seven tiles north."}']);
  try {
    const out = await narratorFor(stubDb()).narrate(ctx);
    assert.equal(out.text, "Something happens."); // the offline narrator echoes the events
    assert.equal(out.degraded, true);
    assert.equal(s.calls(), 2);
  } finally {
    s.restore();
  }
});

test("the prompt carries room, last move, past narrations and only the known facts", async () => {
  let captured: { messages: { content: string }[] } | undefined;
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"narration":"ok"}' } }], usage: {} }), { status: 200 });
  };
  try {
    await narratorFor(openDb(":memory:")).narrate({
      ...ctx, tick: 5,
      place: { name: "House", description: "", room: "Bedroom" },
      lastMove: "north",
      recentNarrations: ["Marta looked at Niko.", "Niko stood still."],
      scene: { question: "Why is Niko here?", knownFacts: ["Niko found a letter."] },
    });
  } finally {
    (globalThis as { fetch: unknown }).fetch = original;
  }
  const payload = JSON.parse(captured!.messages[1].content) as {
    place: { room: string };
    last_move: string;
    previous_narrations: string[];
    scene: { question: string; knownFacts: string[] };
  };
  assert.equal(payload.place.room, "Bedroom");
  assert.equal(payload.last_move, "north");
  assert.deepEqual(payload.previous_narrations, ["Marta looked at Niko.", "Niko stood still."]);
  assert.deepEqual(payload.scene.knownFacts, ["Niko found a letter."]);
  assert.ok(!JSON.stringify(payload).includes("a secret Niko does not know"));
});

test("the continuity check keeps a narration it accepts", async () => {
  const s = stubFetch(['{"narration":"Niko waits by the door."}', '{"ok":true,"problems":[]}']);
  try {
    const deltas: Delta[] = [];
    const out = await narratorFor(openDb(":memory:")).narrate(
      { ...ctx, effects: { resolved: ["wait"], rejected: [] } },
      (d) => deltas.push(d),
    );
    assert.equal(out.text, "Niko waits by the door.");
    assert.equal(s.calls(), 2); // one narration, one continuity check
    assert.ok(deltas.some((d) => d.kind === "stage" && d.text === "checking"));
  } finally {
    s.restore();
  }
});

test("the continuity check rewrites a flagged narration once and accepts the rewrite", async () => {
  const s = stubFetch([
    '{"narration":"Niko teleports to the roof."}',
    '{"ok":false,"problems":["Niko cannot fly."]}',
    '{"narration":"Niko stands still; the roof is out of reach."}',
  ]);
  try {
    const out = await narratorFor(openDb(":memory:")).narrate({ ...ctx, effects: { resolved: ["wait"], rejected: [] } });
    assert.equal(out.text, "Niko stands still; the roof is out of reach.");
    assert.equal(s.calls(), 3);
  } finally {
    s.restore();
  }
});

test("the offline narrator plays a conversation with no options", async () => {
  const narrator = new OpenRouterNarrator(new LlmClient(stubDb(), cfg({ spendCapUsd: 0 })));
  const out = await narrator.narrate({
    ...ctx, conversation: { npc: "Marta", beat: 0, maxBeats: 4, want: "Marta has a warning." },
  });
  assert.match(out.text, /Marta/);
  assert.ok(!("options" in out));
  assert.equal(out.degraded, true); // the spend cap sent it offline
});

test("the offline narrator has a line for every fall beat and both impacts", async () => {
  const narrator = new OfflineNarrator();
  for (const altitude of ["high above the clouds", "through the clouds", "above the rooftops"]) {
    const out = await narrator.narrate({ ...ctx, arrival: { phase: "fall", altitude, beat: 0, beats: 3 } });
    assert.ok(out.text.length > 0);
    assert.equal(hasTileCount(out.text), false);
  }
  for (const impact of ["soft", "hard"] as const) {
    const out = await narrator.narrate({
      ...ctx, arrival: { phase: "play", altitude: "above the rooftops", beat: 3, beats: 3, impact, choices: ["steer"] },
    });
    assert.ok(out.text.length > 0);
    assert.equal(hasTileCount(out.text), false);
  }
});

test("the LLM payload carries the world facts and the arrival block", async () => {
  let captured: { messages: { content: string }[] } | undefined;
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"narration":"ok"}' } }], usage: {} }), { status: 200 });
  };
  try {
    await narratorFor(openDb(":memory:")).narrate({
      ...ctx,
      world: { year: 2030, country: "United States", facts: ["Hybrids are common."], style: "short" },
      arrival: { phase: "fall", altitude: "through the clouds", beat: 1, beats: 3 },
    });
  } finally {
    (globalThis as { fetch: unknown }).fetch = original;
  }
  const payload = JSON.parse(captured!.messages[1].content) as {
    world: { country: string; facts: string[] };
    arrival: { altitude: string; beat: number };
  };
  assert.equal(payload.world.country, "United States");
  assert.deepEqual(payload.world.facts, ["Hybrids are common."]);
  assert.equal(payload.arrival.altitude, "through the clouds");
  assert.equal(payload.arrival.beat, 1);
});
