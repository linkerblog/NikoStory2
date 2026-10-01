import { readFileSync } from "node:fs";
import { rngFor } from "./rng.js";
import type { Point } from "./agenda.js";
import { loadZone, type Zone } from "./world.js";
import { DEFAULT_LOT } from "./zones.js";

// Where a new game opens. The authored house of `data/house_zone.json` is the first home and the one the
// authored game keeps; `data/homes.json` adds the others. A seeded new game draws one home and one lot of the
// city to stand it on, so the fall does not end in the same place twice.
//
// A home is a contract the rest of the game leans on: the opening steers to its `steer` room, the scene's letter
// lies on its `table` and the key in its `wardrobe`, and the cast spawns on the tiles it lists per role.
export interface Home {
  zone: Zone;
  start: Point;                              // where Niko stands before the fall ends
  spawns?: Record<string, Point[]>;          // per cast role; absent for the authored house, whose slots carry their own
}
export interface Start { home: Home; lot: string }

const DIRS: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];

function check(home: Home, roles: readonly string[], steerRoom: string): void {
  const z = home.zone;
  const at = `home ${z.id}`;
  if (!Array.isArray(z.map) || z.map.length !== z.height || z.map.some((r) => typeof r !== "string" || r.length !== z.width)) {
    throw new Error(`${at} does not match its declared width/height`);
  }
  if (z.map.some((r) => /[^#.D]/.test(r))) throw new Error(`${at} map may only use # . and D`);
  const doors: Point[] = [];
  z.map.forEach((row, y) => [...row].forEach((c, x) => { if (c === "D") doors.push({ x, y }); }));
  if (doors.length !== 1) throw new Error(`${at} needs exactly one door`);
  const door = doors[0];
  const edge = door.x === 0 || door.y === 0 || door.x === z.width - 1 || door.y === z.height - 1;
  const corner = (door.x === 0 || door.x === z.width - 1) && (door.y === 0 || door.y === z.height - 1);
  if (!edge || corner) throw new Error(`${at} needs its door on an outer wall`);
  const inner = { x: door.x === 0 ? 1 : door.x === z.width - 1 ? door.x - 1 : door.x, y: door.y === 0 ? 1 : door.y === z.height - 1 ? door.y - 1 : door.y };

  const blocked = new Set<string>();
  const ids = new Set<string>();
  for (const o of z.objects) {
    if (typeof o.id !== "string" || !o.id || ids.has(o.id)) throw new Error(`${at} has a bad or duplicate object id ${o.id}`);
    ids.add(o.id);
    if (!Number.isInteger(o.x) || !Number.isInteger(o.y) || z.map[o.y]?.[o.x] !== ".") throw new Error(`${at} object ${o.id} is not on a floor tile`);
    if (blocked.has(`${o.x},${o.y}`)) throw new Error(`${at} object ${o.id} shares a tile`);
    if (o.blocks) blocked.add(`${o.x},${o.y}`);
  }
  for (const needed of ["table", "wardrobe"]) {
    if (!ids.has(needed)) throw new Error(`${at} needs an object ${needed}`);
  }
  if (!z.rooms.some((r) => r.id === steerRoom)) throw new Error(`${at} needs the room ${steerRoom}`);

  const open = (p: Point) => z.map[p.y]?.[p.x] === "." && !blocked.has(`${p.x},${p.y}`);
  const reach = new Set<string>();
  if (open(inner)) {
    reach.add(`${inner.x},${inner.y}`);
    const queue = [inner];
    while (queue.length) {
      const c = queue.pop()!;
      for (const [dx, dy] of DIRS) {
        const n = { x: c.x + dx, y: c.y + dy };
        if (open(n) && !reach.has(`${n.x},${n.y}`)) { reach.add(`${n.x},${n.y}`); queue.push(n); }
      }
    }
  }
  const reachable = (p: Point) => open(p) && reach.has(`${p.x},${p.y}`);
  if (!reachable(home.start)) throw new Error(`${at} start tile is blocked or cut off from the door`);
  const table = z.objects.find((o) => o.id === "table")!;
  if (!DIRS.some(([dx, dy]) => reachable({ x: table.x + dx, y: table.y + dy }))) throw new Error(`${at} table cannot be reached`);

  if (!home.spawns) return;
  const used = new Set<string>([`${home.start.x},${home.start.y}`]);
  for (const role of roles) {
    const list = home.spawns[role];
    if (!Array.isArray(list) || list.length < 2) throw new Error(`${at} needs at least two spawns for ${role}`);
    for (const p of list) {
      if (!Number.isInteger(p?.x) || !Number.isInteger(p?.y) || !reachable(p)) throw new Error(`${at} spawn for ${role} is blocked or cut off (${p?.x},${p?.y})`);
      if (used.has(`${p.x},${p.y}`)) throw new Error(`${at} spawn for ${role} repeats a tile (${p.x},${p.y})`);
      used.add(`${p.x},${p.y}`);
    }
  }
}

// A malformed home is rejected on load, like the other data files: a spawn inside a wall or a letter table the
// cast cannot reach would otherwise break a new game only after the player pressed Start.
export function loadHomes(dataDir: string, roles: readonly string[], steerRoom: string): Home[] {
  const authored = loadZone(dataDir);
  authored.kind = "house";
  const niko = JSON.parse(readFileSync(`${dataDir}/niko.json`, "utf-8")) as { x: number; y: number };
  const homes: Home[] = [{ zone: authored, start: { x: niko.x, y: niko.y } }];
  let extra: unknown = [];
  try {
    extra = JSON.parse(readFileSync(`${dataDir}/homes.json`, "utf-8"));
  } catch { /* no extra homes: every game opens in the authored house */ }
  if (!Array.isArray(extra)) throw new Error("homes.json must be a list");
  for (const raw of extra as (Zone & { start: Point; spawns: Record<string, Point[]> })[]) {
    if (typeof raw?.id !== "string" || !raw.id || typeof raw.name !== "string" || !raw.name) throw new Error("homes.json home needs an id and a name");
    const { start, spawns, ...zone } = raw;
    homes.push({ zone: { ...zone, description: zone.description ?? "", objects: zone.objects ?? [], rooms: zone.rooms ?? [], portals: [], kind: "house" }, start, spawns });
  }
  if (new Set(homes.map((h) => h.zone.id)).size !== homes.length) throw new Error("homes.json repeats a home id");
  for (const h of homes) {
    if (h.zone.id === "outdoor" || h.zone.id.startsWith("building_")) throw new Error(`home ${h.zone.id} uses an id the city owns`);
    check(h, h.spawns ? roles : [], steerRoom);
  }
  return homes;
}

// A pure function of the seed: the same seed always opens in the same place, so a saved game replays. With no
// seed the authored game starts as it always did, in the authored house on the street.
export function pickStart(homes: Home[], lots: readonly string[], seed?: number): Start {
  if (seed === undefined) return { home: homes[0], lot: DEFAULT_LOT };
  const rng = rngFor(seed, 0, "start");
  const home = homes[Math.floor(rng() * homes.length)];
  const lot = lots[Math.floor(rng() * lots.length)];
  return { home, lot };
}
