import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import { loadCast } from "../src/cast.js";
import { loadHomes, pickStart } from "../src/homes.js";
import { readItems } from "../src/items.js";
import { loadScene } from "../src/stakes.js";
import { DEFAULT_LOT, loadCity } from "../src/zones.js";
import { loadZone } from "../src/world.js";
import type { Db } from "../src/db.js";
import type { Action } from "../src/engine.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const cast = loadCast(DATA, loadZone(DATA), loadScene(DATA));
const roles = cast.slots.map((s) => s.role);
const homes = loadHomes(DATA, roles, "living_room");
const city = loadCity(DATA);
const lots = city.lots.map((l) => l.id);
const meta = (db: Db, key: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
const fall = (text: string): Action => ({ type: "fall", text });

test("the authored house comes first and four more homes follow, each one valid", () => {
  assert.equal(homes[0].zone.id, "house_001");
  assert.deepEqual(homes.slice(1).map((h) => h.zone.id), ["apartment_001", "farmhouse_001", "loft_001", "cottage_001"]);
  assert.equal(homes[0].spawns, undefined); // the authored house keeps the tiles of the cast slots
  for (const h of homes.slice(1)) {
    assert.ok(h.zone.rooms.some((r) => r.id === "living_room"), h.zone.id);
    assert.ok(h.zone.objects.some((o) => o.id === "table") && h.zone.objects.some((o) => o.id === "wardrobe"), h.zone.id);
    for (const role of roles) assert.ok((h.spawns?.[role]?.length ?? 0) >= 2, `${h.zone.id} spawns for ${role}`);
  }
  assert.equal(new Set(homes.map((h) => h.zone.name)).size, homes.length, "every home has its own name");
});

test("the start is a pure function of the seed, and every home and every lot comes up", () => {
  assert.deepEqual(pickStart(homes, lots, 99), pickStart(homes, lots, 99));
  assert.deepEqual(pickStart(homes, lots), { home: homes[0], lot: DEFAULT_LOT }); // no seed: the authored game
  const seenHomes = new Set<string>(), seenLots = new Set<string>();
  for (let seed = 1; seed <= 200; seed++) {
    const s = pickStart(homes, lots, seed);
    seenHomes.add(s.home.zone.id);
    seenLots.add(s.lot);
  }
  assert.equal(seenHomes.size, homes.length);
  assert.equal(seenLots.size, lots.length);
});

test("a malformed homes.json is rejected on load, naming the home", () => {
  const dir = mkdtempSync(join(tmpdir(), "niko-homes-"));
  cpSync(DATA, dir, { recursive: true });
  const base = JSON.parse(readFileSync(join(DATA, "homes.json"), "utf-8"));
  const write = (patch: (h: any[]) => void) => {
    const copy = JSON.parse(JSON.stringify(base));
    patch(copy);
    writeFileSync(join(dir, "homes.json"), JSON.stringify(copy));
  };
  const bad = (patch: (h: any[]) => void, re: RegExp) => { write(patch); assert.throws(() => loadHomes(dir, roles, "living_room"), re); };

  bad((h) => { h[0].spawns.warner[0] = { x: 0, y: 0 }; }, /apartment_001 spawn for warner is blocked/);
  bad((h) => { h[0].spawns.finder = [{ x: 2, y: 7 }]; }, /at least two spawns for finder/);
  bad((h) => { h[0].spawns.finder[0] = h[0].spawns.warner[0]; }, /repeats a tile/);
  bad((h) => { h[0].objects = h[0].objects.filter((o: any) => o.id !== "table"); }, /needs an object table/);
  bad((h) => { h[0].objects = h[0].objects.filter((o: any) => o.id !== "wardrobe"); }, /needs an object wardrobe/);
  bad((h) => { h[0].rooms = []; }, /needs the room living_room/);
  bad((h) => { h[0].map[10] = "############"; }, /exactly one door/);
  bad((h) => { h[0].map[10] = "D###########"; }, /outer wall/);
  bad((h) => { h[0].map[5] = "############"; }, /cannot be reached/); // the partition has no gap: the kitchen is sealed off
  bad((h) => { h[0].start = { x: 0, y: 0 }; }, /start tile/);
  bad((h) => { h[0].objects[0].x = 0; }, /not on a floor tile/);
  bad((h) => { h[1].id = "apartment_001"; }, /repeats a home id/);
  bad((h) => { h[0].id = "outdoor"; }, /city owns/);
  bad((h) => { h[0].id = "building_flat"; }, /city owns/);

  write(() => {});
  assert.equal(loadHomes(dir, roles, "living_room").length, 5);
  writeFileSync(join(dir, "homes.json"), "{}");
  assert.throws(() => loadHomes(dir, roles, "living_room"), /must be a list/);
});

// A seed whose start is neither the authored house nor the street, so the test proves the draw and not luck.
const seedOff = (() => {
  for (let seed = 1; seed < 500; seed++) {
    const s = pickStart(homes, lots, seed);
    if (s.home.zone.id !== "house_001" && s.lot !== DEFAULT_LOT && city.lots.find((l) => l.id === s.lot)!.district !== "outdoor") return seed;
  }
  throw new Error("no seed draws a home away from the street");
})();

test("a seeded reset opens in the drawn home on the drawn lot, with the cast, the letter and the key in it", async () => {
  const g = createGame(":memory:", DATA, 1337, () => offlineServices());
  await g.engine.start();
  assert.equal(meta(g.db, "home"), "house_001"); // the first boot is the authored game
  assert.equal(meta(g.db, "lot"), DEFAULT_LOT);

  await g.reset(undefined, { seed: seedOff });
  const start = pickStart(homes, lots, seedOff);
  const home = start.home.zone;
  assert.equal(meta(g.db, "home"), home.id);
  assert.equal(meta(g.db, "lot"), start.lot);
  assert.equal(g.engine.zone.id, home.id);
  assert.notEqual(g.engine.zone.id, "house_001");
  assert.equal(g.engine.zone.name, home.name);

  // Everyone starts inside the drawn home, on tiles that home lists for their role.
  const rows = g.db.prepare("SELECT id, zone_id, x, y, data FROM entities").all() as { id: string; zone_id: string; x: number; y: number; data: string }[];
  assert.ok(rows.every((r) => r.zone_id === home.id));
  for (const r of rows.filter((r) => r.id !== "niko")) {
    const role = JSON.parse(r.data).role as string;
    assert.ok(start.home.spawns![role].some((p) => p.x === r.x && p.y === r.y), `${r.id} spawns on a ${role} tile`);
  }

  // The letter lies on this home's table and the key hides in its wardrobe.
  const items = readItems(g.db);
  const table = home.objects.find((o) => o.id === "table")!, wardrobe = home.objects.find((o) => o.id === "wardrobe")!;
  const letter = items.find((i) => i.id === "letter")!, key = items.find((i) => i.id === "house_key")!;
  assert.deepEqual([letter.zone_id, letter.x, letter.y], [home.id, table.x, table.y]);
  assert.deepEqual([key.zone_id, key.x, key.y, key.hidden], [home.id, wardrobe.x, wardrobe.y, true]);

  // The drawn lot's door opens into this home, and the home's own door leads back to that lot's district.
  const lot = city.districts.flatMap((d) => d.lots.map((l) => ({ ...l, district: d.id }))).find((l) => l.id === start.lot)!;
  const district = (g.engine as any).zones.get(lot.district);
  assert.deepEqual(district.portals.find((p: any) => p.x === lot.door.x && p.y === lot.door.y)?.to, home.id);
  const zone = (g.engine as any).zones.get(home.id);
  assert.equal(zone.portals[0].to, lot.district);
  // The street's own lot is now a neighbour's house, generated like any building, not the home.
  const hubLot = city.districts[0].lots[0];
  const hubPortal = (g.engine as any).zones.get("outdoor").portals.find((p: any) => p.x === hubLot.door.x && p.y === hubLot.door.y);
  assert.equal(hubPortal.label, "a neighbour's house");
  assert.equal(hubPortal.to, "building_street_home");
  assert.equal(hubPortal.theme, "home");
});

test("the fall lands in the living room of the drawn home and its front door leads to the drawn lot", async () => {
  const g = createGame(":memory:", DATA, 1337, () => offlineServices());
  await g.engine.start();
  await g.reset(undefined, { seed: seedOff });
  for (const text of ["steer toward the house", "let go and fall", "steer"]) assert.equal((await g.engine.takeTurn(fall(text))).ok, true);
  const out = g.engine.state();
  assert.equal(out.phase, "play");
  assert.equal(g.engine.zone.id, pickStart(homes, lots, seedOff).home.zone.id);

  // Leave by the front door, from the tile just inside it.
  const zone = g.engine.zone;
  const door = zone.portals[0];
  const doorTile = zone.map.map((row, y) => [row.indexOf("D"), y]).find(([x]) => x >= 0)!;
  g.db.prepare("UPDATE entities SET x = ?, y = ? WHERE id = 'niko'").run(doorTile[0], doorTile[1] - 1);
  g.db.prepare("DELETE FROM entities WHERE type = 'npc'").run();
  assert.equal((await g.engine.takeTurn({ type: "move", dir: "S" })).ok, true);
  assert.equal(g.engine.zone.id, door.to);
  assert.equal(g.engine.zone.kind, "outdoor");
});

test("the same seed opens in the same place, and a restart reads the save back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niko-start-"));
  const path = join(dir, "game.db");
  const first = createGame(path, DATA, 1337, () => offlineServices());
  await first.engine.start();
  await first.reset(undefined, { seed: seedOff });
  const before = { home: meta(first.db, "home"), lot: meta(first.db, "lot"), zone: first.engine.zone.id, items: readItems(first.db).map((i) => [i.id, i.zone_id, i.x, i.y]) };
  first.db.close();

  const second = createGame(path, DATA, 1337, () => offlineServices());
  assert.equal(meta(second.db, "home"), before.home);
  assert.equal(meta(second.db, "lot"), before.lot);
  assert.equal(second.engine.zone.id, before.zone);
  assert.deepEqual(readItems(second.db).map((i) => [i.id, i.zone_id, i.x, i.y]), before.items);

  const again = createGame(":memory:", DATA, 1337, () => offlineServices());
  await again.engine.start();
  await again.reset(undefined, { seed: seedOff });
  assert.equal(meta(again.db, "home"), before.home);
  assert.equal(meta(again.db, "lot"), before.lot);
});

test("a reset without a seed goes back to the authored house on the street", async () => {
  const g = createGame(":memory:", DATA, 1337, () => offlineServices());
  await g.engine.start();
  await g.reset(undefined, { seed: seedOff });
  await g.reset();
  assert.equal(meta(g.db, "home"), "house_001");
  assert.equal(meta(g.db, "lot"), DEFAULT_LOT);
  assert.equal(g.engine.zone.id, "house_001");
  const letter = readItems(g.db).find((i) => i.id === "letter")!;
  assert.deepEqual([letter.zone_id, letter.x, letter.y], ["house_001", 6, 3]);
});
