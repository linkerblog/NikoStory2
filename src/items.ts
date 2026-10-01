import { readFileSync } from "node:fs";
import { getMeta, setMeta, type Db } from "./db.js";
import type { Scene } from "./stakes.js";
import type { Zone } from "./world.js";

// An item is in exactly one place: on a tile (`zone_id`, `x`, `y`) or held (`holder_id`). The table's
// CHECK enforces it, so a duplicated or lost item is a database error instead of a narration bug.
export interface ItemData {
  description?: string;
  portable?: boolean;
  text?: string;     // readable items
  reveals?: string;  // fact id Niko learns by reading
}

export interface Item {
  id: string;
  name: string;
  zone_id: string | null;
  x: number | null;
  y: number | null;
  holder_id: string | null;
  hidden: boolean;
  data: ItemData;
}

export interface ItemSeed {
  id: string;
  name: string;
  zone_id: string;
  x: number;
  y: number;
  hidden?: number;
  data: ItemData;
}

export function readItems(db: Db): Item[] {
  return (db.prepare("SELECT * FROM items ORDER BY rowid").all() as any[]).map((r) => ({
    id: r.id, name: r.name, zone_id: r.zone_id, x: r.x, y: r.y, holder_id: r.holder_id,
    hidden: r.hidden === 1, data: JSON.parse(r.data),
  }));
}

// A malformed items file is rejected, not trusted: an unknown zone, a tile outside its map, a `reveals`
// id the scene does not know or a duplicate id would each corrupt the world silently otherwise. An item with
// `on` follows the home the save drew: it moves to that object of the home, so the letter always lies on the
// table and the key stays in the wardrobe, whichever home the game opened in.
export function loadItems(dataDir: string, zoneOf: (id: string) => Zone | undefined, scene: Scene, home?: Zone): ItemSeed[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(`${dataDir}/items.json`, "utf-8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) throw new Error("items.json must be a list");
  const seen = new Set<string>();
  const factIds = new Set(scene.facts.map((f) => f.id));
  return raw.map((i: any) => {
    if (typeof i?.id !== "string" || !i.id) throw new Error("items.json item needs a non-empty id");
    if (seen.has(i.id)) throw new Error(`items.json has a duplicate id ${i.id}`);
    seen.add(i.id);
    if (typeof i.name !== "string" || !i.name) throw new Error(`items.json item ${i.id} needs a name`);
    if (i.on !== undefined && (typeof i.on !== "string" || !i.on)) throw new Error(`items.json item ${i.id} needs \`on\` to be an object id`);
    let zone: Zone | undefined;
    let { x, y } = i;
    if (i.on !== undefined && home && home.id !== i.zone_id) {
      // The save opened in another home, so the authored house of the file is not even in it.
      const spot = home.objects.find((o) => o.id === i.on);
      if (!spot) throw new Error(`items.json item ${i.id} wants the object ${i.on}, which home ${home.id} lacks`);
      zone = home; x = spot.x; y = spot.y;
    } else {
      zone = typeof i.zone_id === "string" ? zoneOf(i.zone_id) : undefined;
    }
    if (!zone) throw new Error(`items.json item ${i.id} is in unknown zone ${i.zone_id}`);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= zone.width || y >= zone.height) {
      throw new Error(`items.json item ${i.id} is outside zone ${zone.id}`);
    }
    const data: ItemData = i.data ?? {};
    if (data.reveals !== undefined && !factIds.has(data.reveals)) {
      throw new Error(`items.json item ${i.id} reveals unknown fact ${data.reveals}`);
    }
    if (data.reveals !== undefined && typeof data.text !== "string") {
      throw new Error(`items.json item ${i.id} reveals a fact but has no text to read`);
    }
    return { id: i.id, name: i.name, zone_id: zone.id, x, y, hidden: i.hidden ? 1 : 0, data };
  });
}

// Runs on every load. The `items_seeded` key makes it a one-time insert per save, so a v0.6.0 save
// gains its items once and a later `take` is never undone by a restart. `clearSave` wipes the key.
export function seedItems(db: Db, seeds: ItemSeed[]): void {
  if (getMeta(db, "items_seeded")) return;
  const ins = db.prepare(
    "INSERT OR IGNORE INTO items (id, name, zone_id, x, y, holder_id, hidden, data) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
  );
  db.transaction(() => {
    for (const s of seeds) ins.run(s.id, s.name, s.zone_id, s.x, s.y, s.hidden ? 1 : 0, JSON.stringify(s.data));
    setMeta(db, "items_seeded", "1");
  })();
}
