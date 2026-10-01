import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGame, offlineServices } from "../src/game.js";
import { DEFAULT_LOT, loadCity, OUTDOOR_ID, type DistrictPlan } from "../src/zones.js";

const DATA = fileURLToPath(new URL("../data", import.meta.url));
const city = loadCity(DATA);

// A game past the fall, in the authored start, so a test can put Niko on a tile and walk.
const create = (path = ":memory:") => {
  const g = createGame(path, DATA, 1337, () => offlineServices());
  g.db.prepare("UPDATE settings SET value = 'play' WHERE key = 'phase'").run();
  return g;
};
const place = (g: ReturnType<typeof create>, zone: string, x: number, y: number) => {
  g.db.prepare("DELETE FROM entities WHERE type = 'npc'").run(); // nobody in the way
  g.db.prepare("UPDATE entities SET zone_id = ?, x = ?, y = ? WHERE id = 'niko'").run(zone, x, y);
};
const niko = (g: ReturnType<typeof create>) => g.engine.state().niko;

// Which way a step off the map's edge goes, and the tile just inside it.
const towards = (d: DistrictPlan, e: { x: number; y: number }) => ({
  dir: e.x === 0 ? "W" : e.x === d.width - 1 ? "E" : e.y === 0 ? "N" : "S",
  inner: { x: e.x === 0 ? 1 : e.x === d.width - 1 ? e.x - 1 : e.x, y: e.y === 0 ? 1 : e.y === d.height - 1 ? e.y - 1 : e.y },
}) as { dir: "N" | "S" | "E" | "W"; inner: { x: number; y: number } };

test("the city is the street plus four districts, each joined to the street, with a lot for a home", () => {
  assert.equal(city.districts[0].id, OUTDOOR_ID);
  assert.deepEqual(city.districts.map((d) => d.id), ["outdoor", "district_market", "district_park", "district_riverside", "district_station"]);
  assert.equal(city.lots.length, 5);
  assert.deepEqual(city.lots.find((l) => l.id === DEFAULT_LOT), { id: DEFAULT_LOT, district: OUTDOOR_ID });
  for (const d of city.districts.slice(1)) {
    assert.deepEqual(d.exits.map((e) => e.to), [OUTDOOR_ID], `${d.id} leads back to the street`);
    assert.ok(city.districts[0].exits.some((e) => e.to === d.id), `the street leads to ${d.id}`);
  }
  const buildings = city.districts.flatMap((d) => d.buildings);
  assert.ok(buildings.length >= 20, "a city of many doors");
  assert.equal(new Set(buildings.map((b) => b.id)).size, buildings.length);
  assert.ok(buildings.every((b) => !b.theme || city.themes[b.theme]));
});

test("the street keeps its layout: the bakery door, the chapel door and the house lot are where they were", () => {
  const street = create().engine as any;
  const z = street.zones.get("outdoor");
  assert.equal(z.map[8][6], "D"); // the bakery
  assert.equal(z.map[20][32], "D"); // the chapel, on its west wall
  assert.equal(z.map[35][20], "D"); // the house
  assert.equal(z.portals[0].to, "house_001"); // the lot comes first, as the incident tests expect
  assert.deepEqual(z.portals.slice(-4).map((p: any) => p.to), ["district_market", "district_park", "district_riverside", "district_station"]);
});

test("a malformed city.json is rejected on load, naming the district", () => {
  const dir = mkdtempSync(join(tmpdir(), "niko-city-"));
  cpSync(DATA, dir, { recursive: true });
  const base = JSON.parse(readFileSync(join(DATA, "city.json"), "utf-8"));
  const bad = (patch: (c: any) => void, re: RegExp) => {
    const copy = JSON.parse(JSON.stringify(base));
    patch(copy);
    writeFileSync(join(dir, "city.json"), JSON.stringify(copy));
    assert.throws(() => loadCity(dir), re);
  };
  const market = (c: any) => c.districts[1];

  bad((c) => { c.districts = []; }, /at least one district/);
  bad((c) => { c.districts.reverse(); }, /must start with the district outdoor/);
  bad((c) => { c.districts[2].id = "district_market"; }, /distinct/);
  bad((c) => { market(c).width = 10; }, /district_market needs a size/);
  bad((c) => { market(c).exits = []; }, /district_market needs an exit/);
  bad((c) => { market(c).buildings[1].x = 4; }, /overlaps another/); // the pharmacy onto the cafe
  bad((c) => { market(c).buildings[0].x = 40; }, /outside the map/);
  bad((c) => { market(c).buildings[0].door = { x: 3, y: 3 }; }, /not on a corner/);
  bad((c) => { market(c).buildings[0].door = { x: 5, y: 5 }; }, /door on a wall/); // the middle of the cafe
  bad((c) => { market(c).scenery[0].points.push([6, 9]); }, /door that opens into an obstacle/);
  bad((c) => { market(c).scenery[0].points.push([6, 4]); }, /bad point/); // inside the cafe
  bad((c) => { market(c).exits[0].y = 20; }, /bad exit/); // not on the edge
  bad((c) => { market(c).exits[0].to = "district_nowhere"; }, /bad exit/);
  bad((c) => { c.districts[1].exits[0].to = "district_park"; }, /no way back/);
  bad((c) => { market(c).buildings[0].theme = "spaceport"; }, /known theme/);
  bad((c) => { c.themes.shop = []; }, /theme shop/);
  bad((c) => { c.districts[0].lots = []; }, /needs the lot street_home/);
  // A wall of scenery across the district cuts the cafe door off from the exit.
  bad((c) => { for (let x = 1; x <= 34; x++) market(c).scenery.push({ kind: "fence", name: "a fence", points: [[x, 16]] }); }, /nobody can reach/);

  writeFileSync(join(dir, "city.json"), JSON.stringify(base));
  assert.equal(loadCity(dir).districts.length, 5);
});

test("every exit leads to the district it names and back to the tile beside the reciprocal door", async () => {
  for (const d of city.districts) {
    for (const e of d.exits) {
      const g = create();
      const { dir, inner } = towards(d, e);
      place(g, d.id, inner.x, inner.y);
      const r = await g.engine.takeTurn({ type: "move", dir });
      assert.equal(r.ok, true, `${d.id} -> ${e.to}`);
      assert.equal(g.engine.zone.id, e.to);
      assert.equal(g.engine.zone.kind, "outdoor");
      // He appears beside the door that leads back, not on it and not across the district.
      const target = city.districts.find((o) => o.id === e.to)!;
      const back = target.exits.find((b) => b.to === d.id)!;
      const arrived = niko(g);
      assert.ok(Math.max(Math.abs(arrived.x - back.x), Math.abs(arrived.y - back.y)) <= 1, `${e.to} entry ${arrived.x},${arrived.y}`);
      // And back again onto the tile he left from.
      const home = towards(target, back);
      assert.equal((await g.engine.takeTurn({ type: "move", dir: home.dir })).ok, true);
      assert.equal(g.engine.zone.id, d.id);
      assert.deepEqual([niko(g).x, niko(g).y], [inner.x, inner.y]);
    }
  }
});

test("a building remembers the district it was entered from and takes its furniture from its theme", async () => {
  const g = create();
  const cafe = city.districts[1].buildings[0];
  place(g, "district_market", cafe.door.x, cafe.door.y + 1);
  assert.equal((await g.engine.takeTurn({ type: "move", dir: "N" })).ok, true);
  assert.equal(g.engine.zone.id, cafe.id);
  assert.equal(g.engine.zone.name, "the cafe");
  const exit = g.engine.zone.portals[0];
  assert.equal(exit.to, "district_market");
  assert.equal(exit.label, "the market"); // the district's own name, not a hard-coded street
  assert.ok(g.engine.zone.objects.length > 0);
  assert.ok(g.engine.zone.objects.every((o) => city.themes.food.includes(o.name)), g.engine.zone.objects.map((o) => o.name).join(","));

  // Out the door he stands in the market again, in front of the cafe.
  const z = g.engine.zone;
  g.db.prepare("UPDATE entities SET x = ?, y = ? WHERE id = 'niko'").run(z.portals[0].x, z.portals[0].y - 1);
  assert.equal((await g.engine.takeTurn({ type: "move", dir: "S" })).ok, true);
  assert.equal(g.engine.zone.id, "district_market");
  assert.deepEqual([niko(g).x, niko(g).y], [cafe.door.x, cafe.door.y + 1]);
});

test("a building off the street goes back to the street, and the old bakery is unchanged", async () => {
  const g = create();
  place(g, "outdoor", 6, 9);
  assert.equal((await g.engine.takeTurn({ type: "move", dir: "N" })).ok, true);
  assert.equal(g.engine.zone.portals[0].to, "outdoor");
  assert.equal(g.engine.zone.portals[0].label, "the street");
  assert.equal(g.engine.zone.width, 11);
  assert.equal(g.engine.zone.height, 9);
});

test("an old street without exits gains them and the new districts on the next boot, keeping everything else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niko-oldcity-"));
  const path = join(dir, "game.db");
  const first = create(path);
  await first.engine.start();
  // Rebuild what a save from before the city grew held: a street with no exits and no other district.
  const row = first.db.prepare("SELECT map, portals, objects FROM zones WHERE id = 'outdoor'").get() as { map: string; portals: string; objects: string };
  const map: string[] = JSON.parse(row.map);
  const exits = city.districts[0].exits;
  for (const e of exits) map[e.y] = map[e.y].slice(0, e.x) + "#" + map[e.y].slice(e.x + 1);
  const portals = (JSON.parse(row.portals) as any[]).filter((p) => !exits.some((e) => e.to === p.to));
  first.db.prepare("UPDATE zones SET map = ?, portals = ? WHERE id = 'outdoor'").run(JSON.stringify(map), JSON.stringify(portals));
  first.db.prepare("DELETE FROM zones WHERE id LIKE 'district_%'").run();
  first.db.close();

  const second = create(path);
  const street = (second.engine as any).zones.get("outdoor");
  assert.deepEqual(street.portals.map((p: any) => p.to), [...portals.map((p: any) => p.to), ...exits.map((e) => e.to)]);
  for (const e of exits) assert.equal(street.map[e.y][e.x], "D");
  assert.equal(street.objects.length, JSON.parse(row.objects).length); // nothing else was touched
  for (const d of city.districts.slice(1)) assert.ok((second.engine as any).zones.get(d.id), d.id);

  // And the exit works: out of the street into the market and back.
  const m = exits.find((e) => e.to === "district_market")!;
  place(second, "outdoor", m.x, m.y + 1);
  assert.equal((await second.engine.takeTurn({ type: "move", dir: "N" })).ok, true);
  assert.equal(second.engine.zone.id, "district_market");
});
