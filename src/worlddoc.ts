import { readFileSync } from "node:fs";
import type { Db } from "./db.js";
import type { WorldFacts } from "./world.js";

// The worldbuilding of the game as the author writes it: one section per heading of the author's own
// template. `data/world.json` is the default; the World tab saves an edit in `world_doc`, an install
// preference like the Models tab, so a new game keeps it. The engine compiles it into the `WorldFacts`
// every prompt receives, so an edit applies to the next call with no restart.
export interface WorldDoc {
  year: number;
  country: string;
  init: string;          // [Init]: how Niko came to this world
  personality: string;   // [Personality]: who Niko is
  history: string;       // [Initial history]: what Niko is
  tags: string[];        // [Tags]: the genre of the story
  world: string[];       // [WorldBuilding]: one fact per entry
  daily_life: string[];  // [Daily life]: how an ordinary day goes here, one detail per entry
  biology: string[];     // [Biology]: one fact per entry
  format: string;        // [Format]: the voice and shape of the narration
}

// Bounds for what a prompt can carry: the whole document rides along with every narration.
export const WORLD_LIMITS = {
  country: 60, init: 800, personality: 300, history: 1500, format: 500,
  tag: 40, tags: 20, line: 240, lines: 30,
};

const clean = (v: unknown): string | null =>
  typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim() : null;

// Free text keeps its line breaks; a single-line field collapses them.
function text(v: unknown, max: number, label: string, oneLine: boolean): string | { error: string } {
  const t = clean(v);
  if (t === null) return { error: `${label} must be text.` };
  const out = oneLine ? t.replace(/\s+/g, " ") : t;
  return out.length > max ? { error: `${label} is too long (${out.length} of ${max} characters).` } : out;
}

function list(v: unknown, label: string, maxLines: number, maxLine: number): string[] | { error: string } {
  if (!Array.isArray(v)) return { error: `${label} must be a list.` };
  const out: string[] = [];
  for (const item of v) {
    const t = clean(item);
    if (t === null) return { error: `${label} must be a list of text.` };
    const line = t.replace(/\s+/g, " ");
    if (!line) continue; // blank lines are how a textarea ends, not content
    if (line.length > maxLine) return { error: `A line of ${label} is too long (${line.length} of ${maxLine} characters).` };
    out.push(line);
  }
  return out.length > maxLines ? { error: `${label} has too many lines (${out.length} of ${maxLines}).` } : out;
}

// The one gate for a document, from the file and from the tab alike: nothing unvalidated reaches a prompt.
export function parseWorldDoc(raw: unknown): { doc: WorldDoc } | { error: string } {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return { error: "The world must be an object." };
  const year = r.year;
  if (!Number.isInteger(year) || (year as number) < 1 || (year as number) > 9999) return { error: "The year must be a whole number." };
  const L = WORLD_LIMITS;
  const country = text(r.country, L.country, "The country", true);
  const init = text(r.init ?? "", L.init, "[Init]", false);
  const personality = text(r.personality ?? "", L.personality, "[Personality]", true);
  const history = text(r.history ?? "", L.history, "[Initial history]", false);
  const format = text(r.format ?? "", L.format, "[Format]", false);
  const tags = list(r.tags ?? [], "[Tags]", L.tags, L.tag);
  const world = list(r.world ?? [], "[WorldBuilding]", L.lines, L.line);
  // Optional so a document saved before this section existed still validates.
  const daily_life = list(r.daily_life ?? [], "[Daily life]", L.lines, L.line);
  const biology = list(r.biology ?? [], "[Biology]", L.lines, L.line);
  for (const f of [country, init, personality, history, format, tags, world, daily_life, biology]) {
    if (typeof f === "object" && !Array.isArray(f)) return { error: f.error };
  }
  if (!country) return { error: "The country cannot be empty." };
  return { doc: {
    year: year as number, country: country as string, init: init as string, personality: personality as string,
    history: history as string, tags: tags as string[], world: world as string[], daily_life: daily_life as string[],
    biology: biology as string[], format: format as string,
  } };
}

// A malformed default is rejected on load, like every other data file.
export function loadWorldDoc(dataDir: string): WorldDoc {
  const parsed = parseWorldDoc(JSON.parse(readFileSync(`${dataDir}/world.json`, "utf-8")));
  if ("error" in parsed) throw new Error(`world.json: ${parsed.error}`);
  return parsed.doc;
}

// What the prompts receive. The biology facts are facts of the world like any other. Daily life stays
// apart from the facts: it is texture to draw on, not something the continuity check can contradict.
export function compileWorld(doc: WorldDoc): WorldFacts {
  return {
    year: doc.year, country: doc.country, facts: [...doc.world, ...doc.biology], style: doc.format,
    premise: doc.init, protagonist: { personality: doc.personality, history: doc.history }, tags: doc.tags,
    life: doc.daily_life,
  };
}

// Niko's origin and nature are his own: the roles that stand for other people (the cast writer, the
// government, the architect, the NPC decider and the interpreter) get the world as anyone in it would
// know it. The narrator and the continuity check get all of it.
export function publicWorld(w: WorldFacts): WorldFacts {
  const { premise: _premise, protagonist: _protagonist, ...open } = w;
  return open;
}

export function readWorldDoc(db: Db): WorldDoc | null {
  const row = db.prepare("SELECT doc FROM world_doc WHERE id = 1").get() as { doc: string } | undefined;
  if (!row) return null;
  try {
    const parsed = parseWorldDoc(JSON.parse(row.doc));
    return "doc" in parsed ? parsed.doc : null;
  } catch {
    return null;
  }
}

export function saveWorldDoc(db: Db, doc: WorldDoc): void {
  db.prepare("INSERT INTO world_doc (id, doc) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc")
    .run(JSON.stringify(doc));
}

export function clearWorldDoc(db: Db): void {
  db.prepare("DELETE FROM world_doc WHERE id = 1").run();
}

// Where the worldbuilding goes. The World tab shows this list, so the answer to "what reads it" is in the
// app and not only in the code. `full` is the whole document; `open` leaves out Niko's own origin.
export const WORLD_USERS: { role: string; gets: "full" | "open" | "none"; how: string }[] = [
  { role: "narrator", gets: "full", how: "Every narration: premise for the fall and landing, who Niko is, the facts, the tags and the format." },
  { role: "continuity", gets: "full", how: "Checks each narration against the facts and flags a contradiction." },
  { role: "interpreter", gets: "open", how: "The facts, daily life and tags, to judge what is plausible in this world." },
  { role: "npc", gets: "open", how: "The facts, daily life and tags, so characters act as people of this world. They do not know where Niko comes from." },
  { role: "architect", gets: "open", how: "When a building is designed, so interiors fit the world." },
  { role: "cast", gets: "open", how: "When a new game writes each character's personality, voice, traits and past." },
  { role: "government", gets: "open", how: "When a new game writes the city, its institutions and how they answer." },
  { role: "memory", gets: "none", how: "Not used: memories are written from events only." },
];

export function worldPayload(db: Db, defaults: WorldDoc) {
  const saved = readWorldDoc(db);
  const doc = saved ?? defaults;
  return { ok: true, doc, defaults, custom: saved !== null, limits: WORLD_LIMITS, users: WORLD_USERS, compiled: compileWorld(doc) };
}

// POST /api/world: `{ doc }` saves an edit, `{ reset: true }` returns to the file's default.
export function applyWorldPatch(db: Db, body: unknown): { ok: true } | { ok: false; error: string } {
  const b = body as { doc?: unknown; reset?: unknown } | null;
  if (b?.reset === true) { clearWorldDoc(db); return { ok: true }; }
  if (!b || b.doc === undefined) return { ok: false, error: "Send { doc } to save or { reset: true } to restore." };
  const parsed = parseWorldDoc(b.doc);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  saveWorldDoc(db, parsed.doc);
  return { ok: true };
}
