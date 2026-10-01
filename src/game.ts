import { clearSave, openDb, type Db } from "./db.js";
import { Engine } from "./engine.js";
import { loadOpening, loadWorld, seed } from "./world.js";
import { ZoneStore, ensureWorld } from "./zones.js";
import { loadMemoryRules, type MemoryRules } from "./memory.js";
import { loadScene, loadStakesRules, type StakesRules } from "./stakes.js";
import type { DeltaSink, Narrator } from "./narrator.js";

export type NarratorFor = (db: Db, rules: MemoryRules, stakes: StakesRules) => Narrator;

export function createGame(
  dbPath: string,
  dataDir: string,
  seedValue: number,
  narratorFor: NarratorFor,
) {
  const db = openDb(dbPath);
  seed(db, dataDir, seedValue);
  const zones = new ZoneStore(db);
  const { house } = ensureWorld(db, dataDir, seedValue, zones);
  const rules = loadMemoryRules(dataDir);
  const stakes = loadStakesRules(dataDir);
  const scene = loadScene(dataDir);
  const opening = loadOpening(dataDir, house);
  const world = loadWorld(dataDir);
  const engine = new Engine(db, zones, narratorFor(db, rules, stakes), rules, stakes, scene, opening, world);
  // Reset reuses the same engine: only the rows change, so every rule and narrator stays loaded.
  // The zone store is cleared too, so generated buildings are rebuilt from scratch.
  const reset = async (onDelta?: DeltaSink): Promise<void> => {
    clearSave(db);
    seed(db, dataDir, seedValue);
    zones.clear();
    ensureWorld(db, dataDir, seedValue, zones);
    await engine.start(onDelta);
  };
  return { db, engine, reset };
}
