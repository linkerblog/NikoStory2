import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import {
  generateGovernment, loadGovernmentData, OpenRouterGovernor, parseGovernmentDraft, sanitizeGovernment,
  type Government,
} from "../src/government.js";
import { LlmClient, LLM_ROLES, type LlmRole, type RoleConfig } from "../src/llm.js";
import { DEFAULT_INCIDENTS } from "../src/rules.js";
import type { Db } from "../src/db.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const LIMITS = DEFAULT_INCIDENTS.government;
const data = loadGovernmentData(DATA, LIMITS);

const step = (over: object = {}) => ({
  institution: "city_police", after: 10, when: "always", requires: [], units: 1,
  cue: "Sirens rise in the distance.", want: "{name} came to check a report.", ...over,
});
const draft = (over: { city?: object; institutions?: object[]; protocol?: object[] } = {}) => ({
  city: { name: "Marrow Harbor", summary: "A rainy harbor city where the ferries never quite run on time." },
  institutions: [
    { id: "city_police", name: "Marrow Harbor Constabulary", title: "Constable", tone: "Slow, polite and tired." },
    { id: "ministry", name: "Ministry of Weather", title: "Inspector", tone: "Precise and unfriendly." },
  ],
  protocol: [step(), step({ institution: "ministry", after: 50, when: "contacted", requires: ["ether"] })],
  ...over,
});

test("the fallback government is a pure function of the seed and passes the same validation as a draft", () => {
  assert.deepEqual(generateGovernment(data, 99), generateGovernment(data, 99));
  const cities = new Set<string>();
  for (let seed = 1; seed <= 60; seed++) {
    const g = generateGovernment(data, seed);
    assert.ok(data.cities.includes(g.city.name));
    assert.ok(g.institutions.every((i) => !i.name.includes("{city}")));
    assert.equal(sanitizeGovernment(g, data.tags, LIMITS).dropped, 0);
    cities.add(g.city.name);
  }
  assert.ok(cities.size > 3, "different seeds bring different cities");
});

test("a malformed government.json is rejected on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "niko-gov-"));
  cpSync(DATA, dir, { recursive: true });
  const base = JSON.parse(readFileSync(join(DATA, "government.json"), "utf-8"));
  const write = (g: unknown) => writeFileSync(join(dir, "government.json"), JSON.stringify(g));

  write({ ...base, cities: [] });
  assert.throws(() => loadGovernmentData(dir, LIMITS), /cities/);
  write({ ...base, surnames: [""] });
  assert.throws(() => loadGovernmentData(dir, LIMITS), /surnames/);
  write({ ...base, tags: [] });
  assert.throws(() => loadGovernmentData(dir, LIMITS), /tags/);
  write({ ...base, fallback: { ...base.fallback, protocol: [{ ...base.fallback.protocol[0], institution: "nobody" }] } });
  assert.throws(() => loadGovernmentData(dir, LIMITS), /not a valid government/);
  // A step the bounds would drop is a fault in the data, not something to shrug off.
  write({ ...base, fallback: { ...base.fallback, protocol: [...base.fallback.protocol, { ...base.fallback.protocol[0], after: 9999 }] } });
  assert.throws(() => loadGovernmentData(dir, LIMITS), /not a valid government/);

  write(base);
  assert.equal(loadGovernmentData(dir, LIMITS).fallback.protocol.length, base.fallback.protocol.length);
});

test("a valid draft is kept as written and steps are ordered by their delay", () => {
  const out = sanitizeGovernment(draft({ protocol: [step({ after: 80, when: "contacted" }), step({ after: 5 })] }), data.tags, LIMITS);
  assert.equal(out.dropped, 0);
  assert.deepEqual(out.government!.protocol.map((s) => s.after), [5, 80]);
  assert.equal(out.government!.city.name, "Marrow Harbor");
});

test("a step that breaks a bound is dropped, never repaired", () => {
  const out = sanitizeGovernment(draft({ protocol: [
    step(),
    step({ institution: "ghost" }),                 // no such institution
    step({ after: 0 }),                             // below minAfter
    step({ after: LIMITS.maxAfter + 1 }),           // above maxAfter
    step({ when: "sometimes" }),                    // unknown condition
    step({ requires: ["telepathy"] }),              // tag outside the vocabulary
    step({ units: LIMITS.maxUnits + 1 }),           // too many responders
    step({ cue: "" }),                              // no cue
    step({ want: "x".repeat(LIMITS.maxText + 1) }), // too long
    step({ after: 2.5 }),                           // not a whole number
  ] }), data.tags, LIMITS);
  assert.equal(out.government!.protocol.length, 1);
  assert.equal(out.dropped, 9);
});

test("institutions are bounded, unique and plainly named", () => {
  const many = Array.from({ length: LIMITS.maxInstitutions + 2 }, (_, n) => ({ id: `inst_${n}`, name: `Office ${n}`, title: "Clerk", tone: "Dry and brief." }));
  const out = sanitizeGovernment(draft({ institutions: many, protocol: [step({ institution: "inst_0" })] }), data.tags, LIMITS);
  assert.equal(out.government!.institutions.length, LIMITS.maxInstitutions);

  const mixed = sanitizeGovernment(draft({ institutions: [
    { id: "city_police", name: "Harbor Police", title: "Officer", tone: "Dry and brief." },
    { id: "city_police", name: "Again", title: "Officer", tone: "Dry and brief." },      // duplicate id
    { id: "Bad Id", name: "Office", title: "Officer", tone: "Dry and brief." },          // not a slug
    { id: "numbers", name: "Office", title: "Officer 9", tone: "Dry and brief." },       // digits in a title
  ], protocol: [step()] }), data.tags, LIMITS);
  assert.deepEqual(mixed.government!.institutions.map((i) => i.id), ["city_police"]);
  assert.equal(mixed.dropped, 3);
});

test("a draft with no usable city, institution or unconditional first response is rejected whole", () => {
  const rejected = (g: unknown) => assert.equal(sanitizeGovernment(g, data.tags, LIMITS).government, null);
  rejected(null);
  rejected(draft({ city: { name: "", summary: "A city." } }));
  rejected(draft({ city: { name: "R3al <City>", summary: "A rainy harbor city with a long history." } }));
  rejected(draft({ institutions: [] }));
  rejected(draft({ protocol: [] }));
  // The earliest step decides: if it waits for contact or for a tag, nothing would ever begin.
  rejected(draft({ protocol: [step({ after: 5, when: "contacted" }), step({ after: 30 })] }));
  rejected(draft({ protocol: [step({ after: 5, requires: ["ether"] }), step({ after: 30 })] }));
});

test("the draft parser tolerates fences and prose, and returns null for junk", () => {
  const ok = parseGovernmentDraft("Here you go:\n```json\n" + JSON.stringify(draft()) + "\n```", data.tags, LIMITS);
  assert.equal(ok?.city.name, "Marrow Harbor");
  assert.equal(parseGovernmentDraft("no json at all", data.tags, LIMITS), null);
  assert.equal(parseGovernmentDraft('{"city":{}}', data.tags, LIMITS), null);
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
const request = { tags: data.tags, limits: LIMITS, world: { year: 2030, country: "United States", facts: ["Hybrids are common."], style: "" } };

test("the OpenRouter governor logs its own role, sends the world and the bounds, and returns a valid government", async () => {
  const { db } = createGame(":memory:", DATA, 1337, () => offlineServices());
  const stub = stubFetch(JSON.stringify(draft()));
  try {
    const gov = await new OpenRouterGovernor(llmFor(db)).write(request);
    assert.equal(gov?.city.name, "Marrow Harbor");
    assert.equal(stub.bodies.length, 1);
    assert.match(stub.bodies[0].messages[0].content, /never use the name of a real city/);
    assert.deepEqual(JSON.parse(stub.bodies[0].messages[1].content).world, request.world);
    assert.equal((db.prepare("SELECT role FROM llm_calls").get() as { role: string }).role, "government");
  } finally { stub.restore(); }
});

test("the governor makes no call over budget and returns null when nothing is usable", async () => {
  const { db } = createGame(":memory:", DATA, 1337, () => offlineServices());
  const stub = stubFetch("not json");
  try {
    assert.equal(await new OpenRouterGovernor(llmFor(db)).write(request), null);
    assert.equal(stub.bodies.length, 1);
    db.prepare("INSERT INTO llm_calls (tick, role, model, cost, request, response) VALUES (0, 'government', 'm', 1, '{}', '')").run();
    assert.equal(await new OpenRouterGovernor(llmFor(db)).write(request), null);
    assert.equal(stub.bodies.length, 1); // no second call
  } finally { stub.restore(); }
});

test("the government type is what the engine stores", () => {
  const g: Government = generateGovernment(data, 1);
  assert.equal(typeof g.city.name, "string");
  assert.ok(g.protocol.every((s) => g.institutions.some((i) => i.id === s.institution)));
});
