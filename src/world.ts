import { readFileSync } from "node:fs";
import { getMeta, setMeta, type Db } from "./db.js";

export interface Obj { id: string; type: string; name: string; x: number; y: number; blocks: boolean }
export interface Zone {
  id: string; name: string; description: string;
  width: number; height: number;
  map: string[]; // '#' wall, '.' floor, 'D' exit to a zone not yet generated
  objects: Obj[];
}
export interface Ent {
  id: string; type: "player" | "npc"; name: string;
  x: number; y: number; data: Record<string, any>;
}

const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf-8")) as T;

export function loadZone(dataDir: string): Zone {
  const z = read<Zone>(`${dataDir}/house_zone.json`);
  // The engine does not trust the data: a malformed map is rejected on load.
  if (z.map.length !== z.height || z.map.some((row) => row.length !== z.width)) {
    throw new Error(`Zone ${z.id} does not match its declared width/height`);
  }
  return z;
}

export function seed(db: Db, dataDir: string, seedValue: number): void {
  if (getMeta(db, "seeded")) return;
  const niko = read<any>(`${dataDir}/niko.json`);
  const npcs = read<any[]>(`${dataDir}/npcs.json`);
  const ins = db.prepare(
    "INSERT INTO entities (id, type, name, zone_id, x, y, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    ins.run("niko", "player", niko.name, niko.start_zone, niko.x, niko.y, JSON.stringify(niko.data));
    for (const n of npcs) ins.run(n.id, "npc", n.name, niko.start_zone, n.x, n.y, JSON.stringify(n.data));
    setMeta(db, "seed", String(seedValue));
    setMeta(db, "tick", "0");
    setMeta(db, "visible", "[]");
    setMeta(db, "seeded", "1");
  })();
}
