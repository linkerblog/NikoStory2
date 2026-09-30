import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db.js";
import { OpenRouterNarrator, parseNarration, type Context } from "../src/narrator.js";

const ctx: Context = {
  tick: 0,
  sheet: {},
  place: { name: "Room", description: "" },
  visible: [],
  events: ["Something happens."],
  actions: [{ id: "wait", label: "Wait" }],
};

test("parseNarration reads narration and options", () => {
  const n = parseNarration('{"narration":"Hello","options":[{"id":"wait","text":"Wait"}]}');
  assert.equal(n.text, "Hello");
  assert.deepEqual(n.options, [{ id: "wait", text: "Wait" }]);
});

test("parseNarration accepts JSON wrapped in prose or code fences", () => {
  const n = parseNarration('Here it is:\n```json\n{"narration":"Hi","options":[]}\n```');
  assert.equal(n.text, "Hi");
  assert.deepEqual(n.options, []);
});

test("parseNarration names an empty or object-less response", () => {
  assert.throws(() => parseNarration(""), /has no JSON object/);
  assert.throws(() => parseNarration("I cannot help with that."), /has no JSON object/);
});

test("parseNarration blames truncation at max_tokens", () => {
  assert.throws(() => parseNarration('{"narration":"cut off', "length"), /truncated at max_tokens/);
});

test("parseNarration rejects malformed JSON without leaking the raw parse error", () => {
  assert.throws(() => parseNarration('{"narration":"x","options":[}'), /not valid JSON/);
});

test("parseNarration drops options with a bad shape", () => {
  const n = parseNarration('{"narration":"x","options":[{"id":"wait","text":"Wait"},{"id":1},{"text":"No id"}]}');
  assert.deepEqual(n.options, [{ id: "wait", text: "Wait" }]);
});

test("the LLM narrator falls back to offline when the response has no content", async () => {
  const db = { prepare: () => ({ get: () => ({ t: 0 }), run: () => {} }) } as unknown as Db;
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: {} }), {
      status: 200,
    });
  try {
    const narrator = new OpenRouterNarrator(db, {
      apiKey: "test", model: "test", language: "English", spendCapUsd: 0.5,
    });
    const out = await narrator.narrate(ctx);
    assert.equal(out.text, "Something happens.");
    assert.deepEqual(out.options, [{ id: "wait", text: "Wait" }]);
  } finally {
    (globalThis as { fetch: unknown }).fetch = original;
  }
});
