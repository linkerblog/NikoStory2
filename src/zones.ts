import { readFileSync } from "node:fs";
import { getMeta, type Db } from "./db.js";
import { rngFor } from "./rng.js";
import type { Home } from "./homes.js";
import type { Obj, Portal, Room, Zone } from "./world.js";

// The city is data (`data/city.json`): outdoor districts laid out on fixed grids (1 tile = 1 metre), each with
// its buildings, its lots for a home, its exits to the next district and its scenery. The layout is stable;
// only the interiors are generated, by the LLM when one is available and by `generateBuilding` otherwise.
// The street keeps the id `outdoor`, so a save from before the city grew still finds its way around.
export const OUTDOOR_ID = "outdoor";
export const DEFAULT_LOT = "street_home";

export interface Rect { x: number; y: number; w: number; h: number }
export interface Point2 { x: number; y: number }
export interface BuildingPlan extends Rect { id: string; name: string; door: Point2; theme?: string }
export interface LotPlan extends Rect { id: string; door: Point2 }
export interface ExitPlan { x: number; y: number; to: string; label: string }
export interface SceneryPlan { kind: string; name: string; points: [number, number][] }
export interface DistrictPlan {
  id: string; name: string; description: string; width: number; height: number;
  buildings: BuildingPlan[]; lots: LotPlan[]; exits: ExitPlan[]; scenery: SceneryPlan[]; rooms: Room[];
}
export interface City {
  themes: Record<string, string[]>;
  districts: DistrictPlan[];
  // Every lot where a home can stand, with the district that holds it.
  lots: { id: string; district: string }[];
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isInt = (v: unknown): v is number => Number.isInteger(v);

// Where the tile in front of a door is: the door sits on the perimeter of its rectangle, never on a corner.
function outsideOf(r: Rect, d: Point2): Point2 | null {
  const onX = d.x >= r.x && d.x < r.x + r.w, onY = d.y >= r.y && d.y < r.y + r.h;
  if (!onX || !onY) return null;
  const left = d.x === r.x, right = d.x === r.x + r.w - 1, top = d.y === r.y, bottom = d.y === r.y + r.h - 1;
  if ((left || right) && (top || bottom)) return null;
  if (top) return { x: d.x, y: d.y - 1 };
  if (bottom) return { x: d.x, y: d.y + 1 };
  if (left) return { x: d.x - 1, y: d.y };
  if (right) return { x: d.x + 1, y: d.y };
  return null;
}

// A malformed city is rejected on load, like the other data files: an overlapping building, a door that
// opens into a wall or an exit nobody can reach would otherwise trap Niko only after he walked there.
export function loadCity(dataDir: string): City {
  const raw = JSON.parse(readFileSync(`${dataDir}/city.json`, "utf-8")) as { themes?: unknown; districts?: unknown };
  const themes: Record<string, string[]> = {};
  for (const [name, list] of Object.entries((raw.themes ?? {}) as Record<string, unknown>)) {
    if (!Array.isArray(list) || !list.length || !list.every(isText)) throw new Error(`city.json theme ${name} needs a list of names`);
    themes[name] = list;
  }
  if (!Array.isArray(raw.districts) || !raw.districts.length) throw new Error("city.json needs at least one district");
  const districts = raw.districts as DistrictPlan[];
  const ids = new Set(districts.map((d) => d?.id));
  if (districts[0].id !== OUTDOOR_ID) throw new Error(`city.json must start with the district ${OUTDOOR_ID}`);
  if (ids.size !== districts.length || [...ids].some((i) => !isText(i))) throw new Error("city.json district ids must be distinct text");

  const seen = new Set<string>();
  const claim = (id: unknown, what: string) => {
    if (!isText(id)) throw new Error(`city.json ${what} needs an id`);
    if (seen.has(id)) throw new Error(`city.json has a duplicate id ${id}`);
    seen.add(id);
  };
  const lots: City["lots"] = [];

  for (const d of districts) {
    const at = `city.json district ${d.id}`;
    if (!isText(d.name) || !isText(d.description)) throw new Error(`${at} needs a name and a description`);
    if (!isInt(d.width) || !isInt(d.height) || d.width < 16 || d.height < 16 || d.width > 80 || d.height > 80) {
      throw new Error(`${at} needs a size between 16 and 80`);
    }
    d.buildings = d.buildings ?? []; d.lots = d.lots ?? []; d.exits = d.exits ?? []; d.scenery = d.scenery ?? []; d.rooms = d.rooms ?? [];
    if (!d.exits.length) throw new Error(`${at} needs an exit`);
    const taken = new Set<string>();
    const key = (x: number, y: number) => `${x},${y}`;
    const inside = (x: number, y: number) => x >= 1 && y >= 1 && x <= d.width - 2 && y <= d.height - 2;
    const doorsOut: Point2[] = [];
    for (const [kind, rect] of [...d.buildings.map((b) => ["building", b] as const), ...d.lots.map((l) => ["lot", l] as const)]) {
      claim(rect.id, `${kind} of ${d.id}`);
      if (kind === "building" && (!isText((rect as BuildingPlan).name) || ((rect as BuildingPlan).theme !== undefined && !themes[(rect as BuildingPlan).theme!]))) {
        throw new Error(`${at} building ${rect.id} needs a name and a known theme`);
      }
      if (![rect.x, rect.y, rect.w, rect.h].every(isInt) || rect.w < 3 || rect.h < 3 || !inside(rect.x, rect.y) || !inside(rect.x + rect.w - 1, rect.y + rect.h - 1)) {
        throw new Error(`${at} ${kind} ${rect.id} is outside the map`);
      }
      for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (taken.has(key(x, y))) throw new Error(`${at} ${kind} ${rect.id} overlaps another`);
        taken.add(key(x, y));
      }
      const out = outsideOf(rect, rect.door);
      if (!out) throw new Error(`${at} ${kind} ${rect.id} needs its door on a wall, not on a corner`);
      doorsOut.push(out);
      if (kind === "lot") lots.push({ id: rect.id, district: d.id });
    }
    const scenery = new Set<string>();
    for (const g of d.scenery) {
      if (!isText(g.kind) || !isText(g.name) || !Array.isArray(g.points)) throw new Error(`${at} scenery needs a kind, a name and points`);
      for (const [x, y] of g.points) {
        if (!isInt(x) || !isInt(y) || !inside(x, y) || taken.has(key(x, y)) || scenery.has(key(x, y))) {
          throw new Error(`${at} scenery ${g.kind} has a bad point (${x},${y})`);
        }
        scenery.add(key(x, y));
      }
    }
    const entries: Point2[] = [];
    for (const ex of d.exits) {
      const corner = (ex.x === 0 || ex.x === d.width - 1) && (ex.y === 0 || ex.y === d.height - 1);
      const edge = ex.x === 0 || ex.y === 0 || ex.x === d.width - 1 || ex.y === d.height - 1;
      if (!isInt(ex.x) || !isInt(ex.y) || !edge || corner || !isText(ex.to) || !isText(ex.label) || !ids.has(ex.to) || ex.to === d.id) {
        throw new Error(`${at} has a bad exit (${ex.x},${ex.y})`);
      }
      const inner = { x: ex.x === 0 ? 1 : ex.x === d.width - 1 ? ex.x - 1 : ex.x, y: ex.y === 0 ? 1 : ex.y === d.height - 1 ? ex.y - 1 : ex.y };
      if (taken.has(key(inner.x, inner.y)) || scenery.has(key(inner.x, inner.y))) throw new Error(`${at} exit (${ex.x},${ex.y}) opens into an obstacle`);
      entries.push(inner);
    }
    for (const o of doorsOut) {
      if (!inside(o.x, o.y) || taken.has(key(o.x, o.y)) || scenery.has(key(o.x, o.y))) throw new Error(`${at} has a door that opens into an obstacle at (${o.x},${o.y})`);
    }
    // Every door and exit must be reachable from the first exit, across what is neither built nor scenery.
    const open = (x: number, y: number) => inside(x, y) && !taken.has(key(x, y)) && !scenery.has(key(x, y));
    const reach = new Set<string>([key(entries[0].x, entries[0].y)]);
    const queue = [entries[0]];
    while (queue.length) {
      const c = queue.pop()!;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nx = c.x + dx, ny = c.y + dy;
        if (open(nx, ny) && !reach.has(key(nx, ny))) { reach.add(key(nx, ny)); queue.push({ x: nx, y: ny }); }
      }
    }
    for (const p of [...doorsOut, ...entries]) {
      if (!reach.has(key(p.x, p.y))) throw new Error(`${at} has a door or exit nobody can reach at (${p.x},${p.y})`);
    }
    for (const r of d.rooms) {
      if (!isText(r.id) || !isText(r.name) || ![r.x, r.y, r.w, r.h].every(isInt) || r.w <= 0 || r.h <= 0 || r.x < 0 || r.y < 0 || r.x + r.w > d.width || r.y + r.h > d.height) {
        throw new Error(`${at} has a bad room`);
      }
    }
  }
  for (const d of districts) {
    for (const ex of d.exits) {
      if (!districts.find((o) => o.id === ex.to)!.exits.some((back) => back.to === d.id)) {
        throw new Error(`city.json district ${d.id} leads to ${ex.to}, which has no way back`);
      }
    }
  }
  if (!lots.some((l) => l.id === DEFAULT_LOT && l.district === OUTDOOR_ID)) throw new Error(`city.json needs the lot ${DEFAULT_LOT} on the street`);
  return { themes, districts, lots };
}

const setChar = (row: string, x: number, ch: string) => row.slice(0, x) + ch + row.slice(x + 1);
const fillRect = (map: string[], r: Rect, ch: string) => {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) map[y] = setChar(map[y], x, ch);
};

// The home stands on one lot of the city; the other lots are neighbours' houses, generated like any building.
export interface HomeSite { lot: string; homeId: string }

export function generateDistrict(plan: DistrictPlan, site: HomeSite): Zone {
  const map: string[] = [];
  for (let y = 0; y < plan.height; y++) {
    let row = "";
    for (let x = 0; x < plan.width; x++) row += (x === 0 || y === 0 || x === plan.width - 1 || y === plan.height - 1) ? "#" : ".";
    map.push(row);
  }
  for (const l of plan.lots) fillRect(map, l, "#");
  for (const b of plan.buildings) fillRect(map, b, "#");
  for (const l of plan.lots) map[l.door.y] = setChar(map[l.door.y], l.door.x, "D");
  for (const b of plan.buildings) map[b.door.y] = setChar(map[b.door.y], b.door.x, "D");
  for (const e of plan.exits) map[e.y] = setChar(map[e.y], e.x, "D");
  const objects: Obj[] = plan.scenery.flatMap((g) =>
    g.points.map(([x, y], i): Obj => ({ id: `${g.kind}_${i}`, type: "scenery", name: g.name, x, y, blocks: true })));
  const portals: Portal[] = [
    ...plan.lots.map((l): Portal => l.id === site.lot
      ? { x: l.door.x, y: l.door.y, to: site.homeId, label: "the front door" }
      : { x: l.door.x, y: l.door.y, to: `building_${l.id}`, label: "a neighbour's house", theme: "home" }),
    ...plan.buildings.map((b): Portal => ({ x: b.door.x, y: b.door.y, to: b.id, label: b.name, ...(b.theme ? { theme: b.theme } : {}) })),
    ...plan.exits.map((e): Portal => ({ x: e.x, y: e.y, to: e.to, label: e.label })),
  ];
  return {
    id: plan.id, name: plan.name, description: plan.description,
    width: plan.width, height: plan.height, map, objects, rooms: plan.rooms, portals, kind: "outdoor",
  };
}

// A generated building interior: a rectangular room, one optional partition with a gap, the exit
// door on the south wall and a few furniture objects. Deterministic from the zone id and seed.
export interface ZoneSpec {
  id: string; name: string; width: number; height: number; door: { x: number; y: number }; entry: { x: number; y: number };
  // The zone the door leads back to: the district that holds the building, with its own name.
  parent: string; parentLabel: string;
  furniture?: string[];
}
const FURNITURE = ["a table", "a shelf", "a crate", "a workbench", "a barrel"];

export function buildingSpec(portal: Portal, parent: Zone, furniture?: string[]): ZoneSpec {
  const width = 11, height = 9;
  return {
    id: portal.to, name: portal.label || "a building", width, height,
    door: { x: Math.floor(width / 2), y: height - 1 },
    entry: { x: Math.floor(width / 2), y: height - 2 },
    parent: parent.id, parentLabel: parent.name, furniture,
  };
}

export function generateBuilding(seedValue: number, spec: ZoneSpec): Zone {
  const rng = rngFor(seedValue, 0, `zone:${spec.id}`);
  const pool = spec.furniture?.length ? spec.furniture : FURNITURE;
  const map: string[] = [];
  for (let y = 0; y < spec.height; y++) {
    let row = "";
    for (let x = 0; x < spec.width; x++) row += (x === 0 || y === 0 || x === spec.width - 1 || y === spec.height - 1) ? "#" : ".";
    map.push(row);
  }
  const midY = Math.floor(spec.height / 2);
  if (rng() < 0.6) {
    for (let x = 1; x < spec.width - 1; x++) {
      if (x === spec.entry.x || x === spec.entry.x + 1) continue; // keep the way to the door open
      map[midY] = setChar(map[midY], x, "#");
    }
  }
  const objects: Obj[] = [];
  const spots: [number, number][] = [[2, 2], [spec.width - 3, 2], [2, spec.height - 3], [spec.width - 3, spec.height - 3]];
  spots.forEach(([x, y], i) => {
    if (map[y][x] === ".") objects.push({ id: `${spec.id}_obj_${i}`, type: "furniture", name: pool[Math.floor(rng() * pool.length)], x, y, blocks: true });
  });
  map[spec.door.y] = setChar(map[spec.door.y], spec.door.x, "D");
  return {
    id: spec.id, name: spec.name, description: `Inside ${spec.name}.`,
    width: spec.width, height: spec.height, map, objects, rooms: [],
    portals: [{ x: spec.door.x, y: spec.door.y, to: spec.parent, label: spec.parentLabel }],
    kind: "building",
  };
}

// The engine never trusts a model: a draft is accepted only if it matches the requested size, has a
// solid border, keeps the entry tile walkable and is mostly floor. Anything else is discarded.
export function validateZoneDraft(draft: unknown, spec: ZoneSpec): Zone | null {
  const d = draft as { name?: unknown; description?: unknown; map?: unknown; objects?: unknown; rooms?: unknown };
  if (!d || !Array.isArray(d.map) || d.map.length !== spec.height) return null;
  if (!d.map.every((row) => typeof row === "string" && row.length === spec.width)) return null;
  let map = (d.map as string[]).map((row) => row.split("").map((c) => (c === "#" || c === "." ? c : ".")).join(""));
  const solid = (row: string) => /^#+$/.test(row);
  if (!solid(map[0]) || !solid(map[spec.height - 1])) return null;
  if (map.some((row) => row[0] !== "#" || row[spec.width - 1] !== "#")) return null;
  if (map[spec.entry.y][spec.entry.x] !== ".") return null;
  map[spec.door.y] = setChar(map[spec.door.y], spec.door.x, "D");
  const floor = map.reduce((n, row) => n + [...row].filter((c) => c === ".").length, 0);
  if (floor < Math.floor(spec.width * spec.height * 0.3)) return null;
  const objects = sanitizeObjects(d.objects, spec, map);
  const rooms = sanitizeRooms(d.rooms, spec);
  return {
    id: spec.id,
    name: typeof d.name === "string" && d.name.trim() ? d.name.trim() : spec.name,
    description: typeof d.description === "string" && d.description.trim() ? d.description.trim() : `Inside ${spec.name}.`,
    width: spec.width, height: spec.height, map, objects, rooms,
    portals: [{ x: spec.door.x, y: spec.door.y, to: spec.parent, label: spec.parentLabel }],
    kind: "building",
  };
}

function sanitizeObjects(input: unknown, spec: ZoneSpec, map: string[]): Obj[] {
  if (!Array.isArray(input)) return [];
  const out: Obj[] = [];
  const taken = new Set<string>([`${spec.door.x},${spec.door.y}`, `${spec.entry.x},${spec.entry.y}`]);
  for (const o of input as any[]) {
    const x = Number(o?.x), y = Number(o?.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (x < 1 || y < 1 || x >= spec.width - 1 || y >= spec.height - 1) continue;
    if (map[y][x] !== "." || taken.has(`${x},${y}`)) continue;
    taken.add(`${x},${y}`);
    out.push({ id: typeof o.id === "string" && o.id ? o.id : `${spec.id}_obj_${out.length}`, type: typeof o.type === "string" ? o.type : "furniture", name: typeof o.name === "string" && o.name ? o.name : "an object", x, y, blocks: o.blocks !== false });
  }
  return out;
}

function sanitizeRooms(input: unknown, spec: ZoneSpec): Room[] {
  if (!Array.isArray(input)) return [];
  const out: Room[] = [];
  for (const r of input as any[]) {
    const x = Number(r?.x), y = Number(r?.y), w = Number(r?.w), h = Number(r?.h);
    if (![x, y, w, h].every(Number.isInteger) || w <= 0 || h <= 0) continue;
    if (x < 1 || y < 1 || x + w > spec.width - 1 || y + h > spec.height - 1) continue;
    out.push({ id: typeof r.id === "string" && r.id ? r.id : `room_${out.length}`, name: typeof r.name === "string" && r.name ? r.name : "a room", x, y, w, h });
  }
  return out;
}

// Persists zones so generated buildings survive a restart. The home and the districts are inserted on
// first load or on a legacy save; generated interiors are added as they are entered.
export class ZoneStore {
  private cache = new Map<string, Zone>();
  // The furniture each building theme draws from, set when the city loads; the engine reads it per building.
  themes: Record<string, string[]> = {};
  constructor(private db: Db) {}

  get(id: string): Zone | undefined {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const row = this.db.prepare("SELECT * FROM zones WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    const zone: Zone = {
      id: row.id, name: row.name, description: row.description,
      width: row.width, height: row.height,
      map: JSON.parse(row.map), objects: JSON.parse(row.objects),
      rooms: JSON.parse(row.rooms), portals: JSON.parse(row.portals), kind: row.kind,
    };
    this.cache.set(id, zone);
    return zone;
  }

  put(zone: Zone): void {
    this.db.prepare(
      `INSERT INTO zones (id, name, description, width, height, map, objects, rooms, portals, kind, created_tick)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
         width=excluded.width, height=excluded.height, map=excluded.map, objects=excluded.objects,
         rooms=excluded.rooms, portals=excluded.portals, kind=excluded.kind`,
    ).run(
      zone.id, zone.name, zone.description, zone.width, zone.height, JSON.stringify(zone.map),
      JSON.stringify(zone.objects), JSON.stringify(zone.rooms), JSON.stringify(zone.portals), zone.kind,
      Number(getMeta(this.db, "tick") ?? "0"),
    );
    this.cache.set(zone.id, zone);
  }

  ensure(zone: Zone): void {
    if (!this.get(zone.id)) this.put(zone);
  }

  clear(): void { this.cache.clear(); }
}

// A district already in the store keeps everything it has, and gains only the exits it lacks: a save made
// when the city was one street walks out of its edges into the districts that grew around it.
function ensureDistrict(store: ZoneStore, plan: DistrictPlan, site: HomeSite): void {
  const have = store.get(plan.id);
  if (!have) { store.put(generateDistrict(plan, site)); return; }
  let changed = false;
  for (const e of plan.exits) {
    if (have.portals.some((p) => p.to === e.to)) continue;
    have.portals.push({ x: e.x, y: e.y, to: e.to, label: e.label });
    if (have.map[e.y]?.[e.x] === "#") have.map[e.y] = setChar(have.map[e.y], e.x, "D");
    changed = true;
  }
  if (changed) store.put(have);
}

// Loads the chosen home and every district into the store, coordinating their doors. Idempotent: an
// existing row is never overwritten, so generated buildings and edits persist. The home and its lot are the
// ones the save drew (`home`, `lot`); a legacy save has neither and reads as the authored house on the street.
export function ensureWorld(db: Db, city: City, homes: Home[], store = new ZoneStore(db)): { home: Zone } {
  store.themes = city.themes;
  const home = homes.find((h) => h.zone.id === getMeta(db, "home")) ?? homes[0];
  const lot = city.lots.find((l) => l.id === getMeta(db, "lot")) ?? city.lots.find((l) => l.id === DEFAULT_LOT)!;
  const door = findDoor(home.zone);
  const homeZone: Zone = {
    ...home.zone, kind: "house", map: [...home.zone.map], objects: home.zone.objects.map((o) => ({ ...o })),
    rooms: home.zone.rooms.map((r) => ({ ...r })),
    portals: [{ x: door.x, y: door.y, to: lot.district, label: "the front door" }],
  };
  store.ensure(homeZone);
  for (const plan of city.districts) ensureDistrict(store, plan, { lot: lot.id, homeId: home.zone.id });
  return { home: homeZone };
}

function findDoor(zone: Zone): { x: number; y: number } {
  for (let y = 0; y < zone.height; y++) {
    const x = zone.map[y].indexOf("D");
    if (x >= 0) return { x, y };
  }
  throw new Error(`Zone ${zone.id} has no door`);
}
