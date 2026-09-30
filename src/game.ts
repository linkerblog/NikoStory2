import { openDb, type Db } from "./db.js";
import { Engine } from "./engine.js";
import { loadOpening, loadWorld, loadZone, seed } from "./world.js";
import { loadMemoryRules, type MemoryRules } from "./memory.js";
import { loadScene, loadStakesRules, type StakesRules } from "./stakes.js";
import type { Narrator } from "./narrator.js";

export type NarratorFor = (db: Db, rules: MemoryRules, stakes: StakesRules) => Narrator;

export function createGame(
  dbPath: string,
  dataDir: string,
  seedValue: number,
  narratorFor: NarratorFor,
) {
  const db = openDb(dbPath);
  seed(db, dataDir, seedValue);
  const rules = loadMemoryRules(dataDir);
  const stakes = loadStakesRules(dataDir);
  const scene = loadScene(dataDir);
  const zone = loadZone(dataDir);
  const opening = loadOpening(dataDir, zone);
  const world = loadWorld(dataDir);
  const engine = new Engine(db, zone, narratorFor(db, rules, stakes), rules, stakes, scene, opening, world);
  return { db, engine };
}
