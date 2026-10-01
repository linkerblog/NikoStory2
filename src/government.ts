import { readFileSync } from "node:fs";
import { getMeta, setMeta, type Db } from "./db.js";
import { extractJson, type LlmClient } from "./llm.js";
import { rngFor } from "./rng.js";
import type { DeltaSink } from "./narrator.js";
import type { GovernmentLimits } from "./rules.js";
import type { WorldFacts } from "./world.js";

// The government of a new game: an invented city, the institutions that answer in it and the protocol
// they follow when something is reported. The `government` role writes it, the engine validates it and
// `data/government.json` is the fallback, so a missing or failing model never blocks a new game.
export interface Institution { id: string; name: string; title: string; tone: string }
export type StepWhen = "always" | "contacted" | "uncontacted";
export interface ProtocolStep {
  institution: string;
  // Ticks after the first report. The engine queues every step when the report arrives.
  after: number;
  when: StepWhen;
  // Tags the incident must carry for the step to fire (all of them).
  requires: string[];
  units: number;
  // What Niko can sense when the step fires, such as sirens.
  cue: string;
  // A sentence with the responder's name as `{name}`: what they came to do.
  want: string;
}
export interface Government {
  city: { name: string; summary: string };
  institutions: Institution[];
  protocol: ProtocolStep[];
}

export interface GovernmentData {
  tags: string[];
  cities: string[];
  surnames: string[];
  fallback: Government;
}

const WHEN: ReadonlySet<string> = new Set<StepWhen>(["always", "contacted", "uncontacted"]);
const ID = /^[a-z][a-z0-9_]{1,23}$/;
const TITLE = /^[A-Za-z][A-Za-z .'-]{1,23}$/;
const CITY = /^[\p{L}][\p{L}0-9 .'-]{1,39}$/u;

const oneLine = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length >= min && t.length <= max ? t : null;
};

// Tolerant of a bad entry, strict about the whole: an institution or step that breaks a bound is dropped,
// never repaired, and a government with no institution or no unconditional first response is rejected, so
// the first thing that happens after a report is always a plain dispatch. `dropped` counts what was lost.
export function sanitizeGovernment(
  raw: unknown, tags: readonly string[], limits: GovernmentLimits,
): { government: Government | null; dropped: number } {
  const r = raw as { city?: any; institutions?: unknown; protocol?: unknown } | null;
  let dropped = 0;
  const cityName = oneLine(r?.city?.name, 2, 40), summary = oneLine(r?.city?.summary, 10, 240);
  if (!cityName || !CITY.test(cityName) || !summary) return { government: null, dropped };

  const institutions: Institution[] = [];
  for (const i of Array.isArray(r?.institutions) ? r!.institutions as any[] : []) {
    const name = oneLine(i?.name, 3, 60), title = oneLine(i?.title, 2, 24), tone = oneLine(i?.tone, 5, 140);
    const ok = typeof i?.id === "string" && ID.test(i.id) && !institutions.some((x) => x.id === i.id) &&
      !!name && !!title && TITLE.test(title) && !!tone && institutions.length < limits.maxInstitutions;
    if (!ok) { dropped++; continue; }
    institutions.push({ id: i.id, name: name!, title: title!, tone: tone! });
  }
  if (!institutions.length) return { government: null, dropped };

  const protocol: ProtocolStep[] = [];
  for (const s of Array.isArray(r?.protocol) ? r!.protocol as any[] : []) {
    const cue = oneLine(s?.cue, 5, limits.maxText), want = oneLine(s?.want, 5, limits.maxText);
    const when = s?.when ?? "always";
    const requires = s?.requires ?? [];
    const units = s?.units ?? 1;
    const ok = institutions.some((x) => x.id === s?.institution) &&
      Number.isInteger(s?.after) && s.after >= limits.minAfter && s.after <= limits.maxAfter &&
      typeof when === "string" && WHEN.has(when) &&
      Array.isArray(requires) && requires.every((t: unknown) => typeof t === "string" && tags.includes(t)) &&
      Number.isInteger(units) && units >= 1 && units <= limits.maxUnits && !!cue && !!want &&
      protocol.length < limits.maxSteps;
    if (!ok) { dropped++; continue; }
    protocol.push({
      institution: s.institution, after: s.after, when: when as StepWhen,
      requires: [...new Set<string>(requires)], units, cue: cue!, want: want!,
    });
  }
  // Array.prototype.sort is stable, so equal delays keep the order the model gave them.
  protocol.sort((a, b) => a.after - b.after);
  const first = protocol[0];
  if (!first || first.when !== "always" || first.requires.length) return { government: null, dropped };
  return { government: { city: { name: cityName, summary }, institutions, protocol }, dropped };
}

const fillCity = <T>(value: T, city: string): T => JSON.parse(JSON.stringify(value).replaceAll("{city}", city));

// A malformed government file is rejected on load, like the other data files: the fallback has to pass
// the same validation as a model's draft, with nothing dropped, or a new game would fail only later.
export function loadGovernmentData(dataDir: string, limits: GovernmentLimits): GovernmentData {
  const raw = JSON.parse(readFileSync(`${dataDir}/government.json`, "utf-8")) as Partial<GovernmentData>;
  const list = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string" && x.trim() !== "")) {
      throw new Error(`government.json ${what} must be a non-empty list of strings`);
    }
    return v as string[];
  };
  const tags = list(raw.tags, "tags"), cities = list(raw.cities, "cities"), surnames = list(raw.surnames, "surnames");
  if (!cities.every((c) => CITY.test(c))) throw new Error("government.json cities must be plain names");
  const { government, dropped } = sanitizeGovernment(fillCity(raw.fallback, cities[0]), tags, limits);
  if (!government || dropped) throw new Error("government.json fallback is not a valid government");
  return { tags, cities, surnames, fallback: raw.fallback! };
}

// Pure function of (data, seed): the same seed always brings the same city, so a save replays.
export function generateGovernment(data: GovernmentData, seed: number): Government {
  const rng = rngFor(seed, 0, "government");
  const city = data.cities[Math.floor(rng() * data.cities.length)];
  return fillCity(data.fallback, city);
}

export function plantGovernment(db: Db, government: Government): void {
  setMeta(db, "government", JSON.stringify(government));
}

// A save with no government (a legacy one) raises no incident. The stored text is trusted: it was
// validated before it was planted.
export function readGovernment(db: Db): Government | null {
  const text = getMeta(db, "government");
  if (!text) return null;
  try {
    const g = JSON.parse(text) as Government;
    return Array.isArray(g?.protocol) && Array.isArray(g?.institutions) ? g : null;
  } catch {
    return null;
  }
}

// The `government` role. Asked once at a seeded reset, like `cast`: it only proposes, and whatever fails
// `sanitizeGovernment` leaves the deterministic government in place.
export interface GovernmentRequest { world?: WorldFacts; tags: string[]; limits: GovernmentLimits }
export interface GovernmentWriter {
  write(req: GovernmentRequest, onDelta?: DeltaSink): Promise<Government | null>;
}

export const governmentPrompt = (req: GovernmentRequest) =>
  `You write the government of an invented city for a turn-based role-playing game. Always write in English.
A stranger has just fallen out of the sky into this city. Write the city, the institutions that answer and the protocol they follow once somebody reports it.
Rules:
- The city is invented: never use the name of a real city, state or institution. It must fit the world facts you are given, including the year, the country and who holds power.
- "institutions": 2 to ${req.limits.maxInstitutions}. Each has "id" (lowercase letters, digits and underscores, starting with a letter), "name" (at most 60 characters), "title" (what its field staff are called, such as "Officer" or "Agent", at most 24 characters, letters only) and "tone" (one sentence, at most 140 characters, on how its people carry themselves and speak).
- "protocol": 1 to ${req.limits.maxSteps} steps, each one a response sent to the scene. A step has "institution" (an id above), "after" (whole number of ticks after the first report, from ${req.limits.minAfter} to ${req.limits.maxAfter}; a tick is one beat of play, so the first response is quick and the escalations take tens of ticks), "when" ("always", "contacted" or "uncontacted": whether a responder has already spoken with the stranger), "requires" (a list of tags from ${JSON.stringify(req.tags)}; the step only fires when the incident carries all of them), "units" (1 to ${req.limits.maxUnits} responders), "cue" (what the stranger can hear or see when it is sent, at most ${req.limits.maxText} characters, no numbers) and "want" (one sentence, at most ${req.limits.maxText} characters, about what the responder came to do, using {name} for the responder).
- Tags: "sky_fall" is always present; "ether" means an Ether discharge was detected; "unregistered" means a responder found out the stranger has no papers or record.
- The earliest step must have "when": "always" and an empty "requires", so some response always comes.
- Make the response plausible for the world: first the local authority, then whoever has a reason to take an interest. Do not name individual people, do not decide the outcome and do not give the stranger any ability.
Respond ONLY with JSON: {"city":{"name":string,"summary":string},"institutions":[{"id":string,"name":string,"title":string,"tone":string}],"protocol":[{"institution":string,"after":number,"when":string,"requires":[string],"units":number,"cue":string,"want":string}]}.`;

// Tolerant of fences and prose; the shape is checked by `sanitizeGovernment`.
export function parseGovernmentDraft(content: string, tags: readonly string[], limits: GovernmentLimits): Government | null {
  const json = extractJson(content);
  return json ? sanitizeGovernment(json, tags, limits).government : null;
}

export class OpenRouterGovernor implements GovernmentWriter {
  constructor(private llm: LlmClient) {}

  async write(req: GovernmentRequest, onDelta?: DeltaSink): Promise<Government | null> {
    if (this.llm.overBudget()) return null;
    const messages = [
      { role: "system", content: governmentPrompt(req) },
      { role: "user", content: JSON.stringify({ world: req.world ?? null }) },
    ];
    const res = await this.llm.chatRetry("government", messages, {
      json: true, maxTokens: 6000, temperature: 0.9, tick: 0,
      onReasoning: (t) => onDelta?.({ kind: "reasoning", text: t }),
    }, 2);
    return parseGovernmentDraft(res.content, req.tags, req.limits);
  }
}
