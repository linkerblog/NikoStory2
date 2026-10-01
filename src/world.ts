import { readFileSync } from "node:fs";
import { getMeta, setMeta, type Db } from "./db.js";
import type { GeneratedCast, NpcSeed, Personality } from "./cast.js";

export interface Obj { id: string; type: string; name: string; x: number; y: number; blocks: boolean }
export interface Room { id: string; name: string; x: number; y: number; w: number; h: number }
// A door: `(x, y)` is a 'D' tile in this zone and `to` is the zone it leads to. The entry tile in
// the target is resolved from the target's own portal back to this zone, so no coordinates are
// duplicated and two zones can never disagree about where the door puts you.
export interface Portal { x: number; y: number; to: string; label: string }
export type ZoneKind = "house" | "outdoor" | "building";
export interface Zone {
  id: string; name: string; description: string;
  width: number; height: number;
  map: string[]; // '#' wall, '.' floor, 'D' door to another zone
  objects: Obj[];
  rooms: Room[];
  portals: Portal[];
  kind: ZoneKind;
}
export interface Ent {
  id: string; type: "player" | "npc"; name: string; zone_id: string;
  x: number; y: number; data: Record<string, any>;
}

// The setting the narrator must not contradict. Authored in `data/world.json`.
export interface WorldFacts { year: number; country: string; facts: string[]; style: string }

// The scripted fall that opens a new game. Authored in `data/opening.json`. `brace_ability` is the
// id of an ability in `data/rules.json`: the opening references it, the engine resolves its cost.
export interface OpeningBeat { altitude: string }
export interface Opening {
  beats: OpeningBeat[];
  braceAbility: string;
  landing: { steer_room: string };
}

export const DEFAULT_WORLD: WorldFacts = { year: 2030, country: "United States", facts: [], style: "" };

export const DEFAULT_OPENING: Opening = {
  beats: [{ altitude: "high above the clouds" }, { altitude: "through the clouds" }, { altitude: "above the rooftops" }],
  braceAbility: "brace",
  landing: { steer_room: "living_room" },
};

const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf-8")) as T;

export function loadWorld(dataDir: string): WorldFacts {
  const w = read<WorldFacts>(`${dataDir}/world.json`);
  if (!Array.isArray(w.facts)) throw new Error("world.json has no facts list");
  return { year: w.year, country: w.country, facts: w.facts, style: w.style ?? "" };
}

// A malformed opening is rejected, not trusted: at least one beat, a brace ability id and, when a
// zone is given, a room id that exists in that zone. The ability's cost lives in `data/rules.json`.
export function loadOpening(dataDir: string, zone?: Zone): Opening {
  const o = read<Opening>(`${dataDir}/opening.json`);
  if (!Array.isArray(o.beats) || o.beats.length === 0 || o.beats.some((b) => typeof b?.altitude !== "string" || !b.altitude)) {
    throw new Error("opening.json needs at least one beat with a non-empty altitude");
  }
  const braceAbility = (o as { brace_ability?: unknown }).brace_ability;
  if (typeof braceAbility !== "string" || !braceAbility) throw new Error("opening.json needs a brace ability id");
  const room = o.landing?.steer_room;
  if (typeof room !== "string" || !room) throw new Error("opening.json needs a steer room id");
  if (zone && !zone.rooms.some((r) => r.id === room)) throw new Error(`opening.json steer room ${room} is not in zone ${zone.id}`);
  return {
    beats: o.beats.map((b) => ({ altitude: b.altitude })),
    braceAbility,
    landing: { steer_room: room },
  };
}

export function loadZone(dataDir: string): Zone {
  const z = read<Zone>(`${dataDir}/house_zone.json`);
  // The engine does not trust the data: a malformed map is rejected on load.
  if (z.map.length !== z.height || z.map.some((row) => row.length !== z.width)) {
    throw new Error(`Zone ${z.id} does not match its declared width/height`);
  }
  z.rooms = z.rooms ?? [];
  z.portals = z.portals ?? [];
  z.kind = z.kind ?? "house";
  return z;
}

export function roomAt(zone: Zone, x: number, y: number): string {
  const r = (zone.rooms ?? []).find((room) => x >= room.x && y >= room.y && x < room.x + room.w && y < room.y + room.h);
  return r?.name ?? zone.name;
}

// Replaces the personality and voice of seeded NPCs with what the `cast` role wrote. It runs right after
// `seed`, before the first narration, so no prompt ever sees the pool temperament it replaces. An id
// that is not an NPC of this save is ignored.
export function applyPersonalities(db: Db, picks: Record<string, Personality>): void {
  const row = db.prepare("SELECT data FROM entities WHERE id = ? AND type = 'npc'");
  const upd = db.prepare("UPDATE entities SET data = ? WHERE id = ?");
  db.transaction(() => {
    for (const [id, p] of Object.entries(picks)) {
      const r = row.get(id) as { data: string } | undefined;
      if (r) upd.run(JSON.stringify({ ...JSON.parse(r.data), personality: p.personality, voice: p.voice }), id);
    }
  })();
}

// Without a cast the authored NPCs of `data/npcs.json` are planted; with one, the generated people take
// their place and the facts that name them are reworded (see `Engine.knownFacts`).
export function seed(db: Db, dataDir: string, seedValue: number, cast?: GeneratedCast): void {
  if (getMeta(db, "seeded")) return;
  const niko = read<any>(`${dataDir}/niko.json`);
  const npcs = cast?.npcs ?? read<NpcSeed[]>(`${dataDir}/npcs.json`);
  const ins = db.prepare(
    "INSERT INTO entities (id, type, name, zone_id, x, y, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    ins.run("niko", "player", niko.name, niko.start_zone, niko.x, niko.y, JSON.stringify(niko.data));
    for (const n of npcs) ins.run(n.id, "npc", n.name, niko.start_zone, n.x, n.y, JSON.stringify(n.data));
    setMeta(db, "seed", String(seedValue));
    setMeta(db, "fact_texts", JSON.stringify(cast?.factTexts ?? {}));
    setMeta(db, "tick", "0");
    setMeta(db, "visible", "[]");
    setMeta(db, "phase", "fall");
    setMeta(db, "fall_beat", "0");
    setMeta(db, "fall_log", "[]");
    setMeta(db, "fall_brace", "0");
    setMeta(db, "seeded", "1");
  })();
}
