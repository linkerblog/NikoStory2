import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import { openDb } from "../src/db.js";
import { LlmClient, LLM_ROLES, type LlmRole, type RoleConfig } from "../src/llm.js";
import { loadOverrides, parseCatalog, parseModelsPatch, resolveRoles, saveOverrides } from "../src/models.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const tmpDb = () => openDb(join(mkdtempSync(join(tmpdir(), "niko-models-")), "game.db"));

test("roles inherit the narrator's model, and the tab beats .env", () => {
  const env = { NARRATOR_MODEL: "a/narrator", MEMORY_MODEL: "a/memory" };
  const base = resolveRoles(env, {});
  assert.equal(base.narrator.model, "a/narrator");
  assert.equal(base.narrator.modelSource, "env");
  assert.equal(base.interpreter.model, "a/narrator");
  assert.equal(base.interpreter.modelSource, "narrator");
  assert.equal(base.memory.model, "a/memory");
  assert.equal(base.memory.modelSource, "env");

  // Changing only the narrator in the tab moves every role that inherits it.
  const tab = resolveRoles(env, { narrator: { model: "b/new", reasoning: null }, memory: { model: "c/mem", reasoning: null } });
  assert.equal(tab.narrator.model, "b/new");
  assert.equal(tab.narrator.modelSource, "ui");
  assert.equal(tab.interpreter.model, "b/new");
  assert.equal(tab.memory.model, "c/mem");
  assert.equal(tab.memory.modelSource, "ui");
});

test("without a narrator model no role has one, so the game stays offline", () => {
  const r = resolveRoles({}, {});
  for (const role of LLM_ROLES) {
    assert.equal(r[role].model, "");
    assert.equal(r[role].modelSource, "none");
  }
  assert.equal(resolveRoles({}, { narrator: { model: "x/y", reasoning: null } }).cast.model, "x/y");
});

test("reasoning: the tab beats .env, which beats the role default; idle follows the effective flag", () => {
  const env = { NARRATOR_MODEL: "a/n", NPC_REASONING: "0", INTERPRETER_IDLE_MS: "5000" };
  const r = resolveRoles(env, { narrator: { model: null, reasoning: true }, interpreter: { model: null, reasoning: false } });
  assert.deepEqual([r.narrator.reasoning, r.narrator.reasoningSource, r.narrator.idleMs], [true, "ui", 120_000]);
  assert.deepEqual([r.npc.reasoning, r.npc.reasoningSource], [false, "env"]);
  assert.deepEqual([r.architect.reasoning, r.architect.reasoningSource], [true, "default"]);
  assert.deepEqual([r.interpreter.reasoning, r.interpreter.idleMs], [false, 5000]);
});

test("the patch validator accepts ids and nulls and rejects the rest", () => {
  const ok = parseModelsPatch({ roles: {
    narrator: { model: " anthropic/claude-sonnet-4.5 ", reasoning: false },
    cast: { model: "", reasoning: null },
    npc: { model: "meta-llama/llama-3.3-70b-instruct:free" },
  } });
  assert.deepEqual(ok, { patch: {
    narrator: { model: "anthropic/claude-sonnet-4.5", reasoning: false },
    cast: { model: null, reasoning: null },
    npc: { model: "meta-llama/llama-3.3-70b-instruct:free", reasoning: null },
  } });
  for (const bad of [
    null, { roles: [] }, { roles: { wizard: { model: "a/b" } } }, { roles: { narrator: { model: 5 } } },
    { roles: { narrator: { model: "no-slash" } } }, { roles: { narrator: { model: "a/b c" } } },
    { roles: { narrator: { model: "a/" + "x".repeat(130) } } }, { roles: { narrator: { reasoning: "yes" } } },
  ]) {
    assert.ok("error" in parseModelsPatch(bad), JSON.stringify(bad));
  }
});

test("choices persist, a cleared role is deleted, and a new game keeps them", async () => {
  const db = tmpDb();
  saveOverrides(db, { narrator: { model: "a/b", reasoning: false }, cast: { model: null, reasoning: true } });
  assert.deepEqual(loadOverrides(db), { narrator: { model: "a/b", reasoning: false }, cast: { model: null, reasoning: true } });
  saveOverrides(db, { cast: { model: null, reasoning: null } });
  assert.deepEqual(Object.keys(loadOverrides(db)), ["narrator"]);
  db.close();

  const path = join(mkdtempSync(join(tmpdir(), "niko-models-reset-")), "game.db");
  const g = createGame(path, DATA, 1337, () => offlineServices());
  await g.engine.start();
  saveOverrides(g.db, { interpreter: { model: "x/y", reasoning: null } });
  await g.reset(undefined, { seed: 99 });
  assert.deepEqual(loadOverrides(g.db), { interpreter: { model: "x/y", reasoning: null } });
  g.db.close();
});

test("the client swaps its role table between calls", () => {
  const role = (model: string): RoleConfig => ({ model, reasoning: false, idleMs: 1000 });
  const table = (m: string) => Object.fromEntries(LLM_ROLES.map((r) => [r, role(m)])) as Record<LlmRole, RoleConfig>;
  const llm = new LlmClient(tmpDb(), { apiKey: "k", language: "English", spendCapUsd: 1, roles: table("a/one") });
  assert.equal(llm.role("npc").model, "a/one");
  llm.configure(table("b/two"));
  assert.equal(llm.role("npc").model, "b/two");
  assert.equal(llm.spendCapUsd, 1);
});

test("the catalog keeps usable models, prices per million tokens, sorted by id", () => {
  const models = parseCatalog({ data: [
    { id: "z/last", name: "Last", context_length: 8000, pricing: { prompt: "0.000003", completion: "0.000015" } },
    { id: "a/first", pricing: { prompt: "-1" } },
    { name: "no id" }, null,
  ] });
  assert.deepEqual(models, [
    { id: "a/first", name: "a/first", context: null, promptUsd: null, completionUsd: null },
    { id: "z/last", name: "Last", context: 8000, promptUsd: 3, completionUsd: 15 },
  ]);
  assert.deepEqual(parseCatalog({ nope: 1 }), []);
});
