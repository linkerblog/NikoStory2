import { getMeta, type Db } from "./db.js";
import { rngFor } from "./rng.js";
import { loadZone, type Obj, type Portal, type Room, type Zone } from "./world.js";

// One outdoor zone, generated deterministically, holds the house and its neighbours. Buildings are
// placed on a fixed 40x40 grid (1 tile = 1 metre) so the layout is stable; only the interiors are
// generated, by the LLM when one is available and by `generateBuilding` otherwise.
export const OUTDOOR_ID = "outdoor";
const OUT_W = 40;
const OUT_H = 40;

// The house footprint on the outdoor map and its front door on the south wall. Niko appears on the
// tile just outside it when he leaves the house; `entryTile` finds it from the reciprocal portal.
const HOUSE_FOOT = { x: 16, y: 28, w: 8, h: 8 };
const HOUSE_DOOR = { x: 20, y: 35 };
export const HOUSE_ENTRY = { x: 5, y: 13 }; // the house floor tile inside its own south door

interface BuildingPlan { id: string; name: string; x: number; y: number; w: number; h: number; door: { x: number; y: number } }
const BUILDINGS: BuildingPlan[] = [
  { id: "building_bakery", name: "the bakery", x: 3, y: 3, w: 7, h: 6, door: { x: 6, y: 8 } },
  { id: "building_store", name: "the general store", x: 15, y: 4, w: 8, h: 5, door: { x: 18, y: 8 } },
  { id: "building_workshop", name: "the workshop", x: 28, y: 4, w: 8, h: 6, door: { x: 31, y: 9 } },
  { id: "building_chapel", name: "the chapel", x: 32, y: 16, w: 7, h: 8, door: { x: 32, y: 20 } },
  { id: "building_clinic", name: "the clinic", x: 4, y: 28, w: 7, h: 7, door: { x: 7, y: 28 } },
  { id: "building_inn", name: "the inn", x: 30, y: 28, w: 7, h: 6, door: { x: 33, y: 28 } },
];
const TREES: [number, number][] = [[12, 12], [27, 12], [12, 26], [27, 24], [20, 20], [24, 30]];
const OUT_ROOMS: Room[] = [
  { id: "north_lane", name: "the northern lane", x: 12, y: 2, w: 14, h: 10 },
  { id: "crossroads", name: "the crossroads", x: 14, y: 14, w: 12, h: 12 },
  { id: "south_yard", name: "the south yard", x: 12, y: 26, w: 14, h: 12 },
];

const setChar = (row: string, x: number, ch: string) => row.slice(0, x) + ch + row.slice(x + 1);
const fillRect = (map: string[], r: { x: number; y: number; w: number; h: number }, ch: string) => {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) map[y] = setChar(map[y], x, ch);
};

// The starting outdoor zone: the house block plus six buildings with doors on the street side.
export function generateOverland(seedValue: number, houseId: string): Zone {
  const map: string[] = [];
  for (let y = 0; y < OUT_H; y++) {
    let row = "";
    for (let x = 0; x < OUT_W; x++) row += (x === 0 || y === 0 || x === OUT_W - 1 || y === OUT_H - 1) ? "#" : ".";
    map.push(row);
  }
  fillRect(map, HOUSE_FOOT, "#");
  for (const b of BUILDINGS) fillRect(map, { x: b.x, y: b.y, w: b.w, h: b.h }, "#");
  map[HOUSE_DOOR.y] = setChar(map[HOUSE_DOOR.y], HOUSE_DOOR.x, "D");
  for (const b of BUILDINGS) map[b.door.y] = setChar(map[b.door.y], b.door.x, "D");
  const objects: Obj[] = TREES.map(([x, y], i) => ({ id: `tree_${i}`, type: "scenery", name: "a tree", x, y, blocks: true }));
  const portals: Portal[] = [
    { x: HOUSE_DOOR.x, y: HOUSE_DOOR.y, to: houseId, label: "the front door" },
    ...BUILDINGS.map((b) => ({ x: b.door.x, y: b.door.y, to: b.id, label: b.name })),
  ];
  void seedValue; // the layout is fixed; the seed is kept for future variation
  return {
    id: OUTDOOR_ID, name: "the street", description: "An open street between the houses.",
    width: OUT_W, height: OUT_H, map, objects, rooms: OUT_ROOMS, portals, kind: "outdoor",
  };
}

// A generated building interior: a rectangular room, one optional partition with a gap, the exit
// door on the south wall and a few furniture objects. Deterministic from the zone id and seed.
export interface ZoneSpec { id: string; name: string; width: number; height: number; door: { x: number; y: number }; entry: { x: number; y: number }; parent: string }
const FURNITURE = ["a table", "a shelf", "a crate", "a workbench", "a barrel"];

export function buildingSpec(portal: Portal): ZoneSpec {
  const width = 11, height = 9;
  return {
    id: portal.to, name: portal.label || "a building", width, height,
    door: { x: Math.floor(width / 2), y: height - 1 },
    entry: { x: Math.floor(width / 2), y: height - 2 },
    parent: OUTDOOR_ID,
  };
}

export function generateBuilding(seedValue: number, spec: ZoneSpec): Zone {
  const rng = rngFor(seedValue, 0, `zone:${spec.id}`);
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
    if (map[y][x] === ".") objects.push({ id: `${spec.id}_obj_${i}`, type: "furniture", name: FURNITURE[Math.floor(rng() * FURNITURE.length)], x, y, blocks: true });
  });
  map[spec.door.y] = setChar(map[spec.door.y], spec.door.x, "D");
  return {
    id: spec.id, name: spec.name, description: `Inside ${spec.name}.`,
    width: spec.width, height: spec.height, map, objects, rooms: [],
    portals: [{ x: spec.door.x, y: spec.door.y, to: spec.parent, label: "the street" }],
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
    portals: [{ x: spec.door.x, y: spec.door.y, to: spec.parent, label: "the street" }],
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

// Persists zones so generated buildings survive a restart. The hand-made house and the outdoor zone
// are inserted on first load or on a legacy save; generated interiors are added as they are entered.
export class ZoneStore {
  private cache = new Map<string, Zone>();
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

// Loads the hand-made house and the generated outdoor zone into the store, coordinating their doors.
// Idempotent: an existing row is never overwritten, so generated buildings and edits persist.
export function ensureWorld(db: Db, dataDir: string, seedValue: number, store = new ZoneStore(db)): { house: Zone; outdoor: Zone } {
  const rawHouse = loadZone(dataDir);
  const outdoor = generateOverland(seedValue, rawHouse.id);
  const door = findDoor(rawHouse);
  const house: Zone = {
    ...rawHouse, kind: "house",
    portals: [{ x: door.x, y: door.y, to: OUTDOOR_ID, label: "the front door" }],
  };
  store.ensure(house);
  store.ensure(outdoor);
  return { house, outdoor };
}

function findDoor(zone: Zone): { x: number; y: number } {
  for (let y = 0; y < zone.height; y++) {
    const x = zone.map[y].indexOf("D");
    if (x >= 0) return { x, y };
  }
  throw new Error(`Zone ${zone.id} has no door`);
}
