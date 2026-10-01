import { clearSave, openDb, type Db } from "./db.js";
import { Engine, type EngineServices } from "./engine.js";
import { loadOpening, loadWorld, seed } from "./world.js";
import { ZoneStore, ensureWorld } from "./zones.js";
import { loadMemoryRules, OfflineMemories, type MemoryRules } from "./memory.js";
import { loadScene, loadStakesRules, type StakesRules } from "./stakes.js";
import { loadRules, type GameRules } from "./rules.js";
import { OfflineNarrator, type DeltaSink } from "./narrator.js";
import { OfflineInterpreter } from "./interpreter.js";
import { loadItems, seedItems } from "./items.js";

// The game builds its roles from the environment. Tests pass the offline roles (or a stub), the
// server passes OpenRouter-backed ones when a key and a model are configured.
export type ServicesFor = (db: Db, memory: MemoryRules, stakes: StakesRules, rules: GameRules) => EngineServices;

export function createGame(
  dbPath: string,
  dataDir: string,
  seedValue: number,
  servicesFor: ServicesFor,
) {
  const db = openDb(dbPath);
  seed(db, dataDir, seedValue);
  const zones = new ZoneStore(db);
  const { house } = ensureWorld(db, dataDir, seedValue, zones);
  const memory = loadMemoryRules(dataDir);
  const stakes = loadStakesRules(dataDir);
  const gameRules = loadRules(dataDir);
  const scene = loadScene(dataDir);
  // Items are validated against the zones and the scene facts, then inserted once per save.
  const plantItems = () => seedItems(db, loadItems(dataDir, (id) => zones.get(id), scene));
  plantItems();
  const opening = loadOpening(dataDir, house);
  const world = loadWorld(dataDir);
  const engine = new Engine(db, zones, servicesFor(db, memory, stakes, gameRules), gameRules, memory, stakes, scene, opening, world);
  // Reset reuses the same engine: only the rows change, so every rule and role stays loaded.
  // The zone store is cleared too, so generated buildings are rebuilt from scratch.
  const reset = async (onDelta?: DeltaSink): Promise<void> => {
    clearSave(db);
    seed(db, dataDir, seedValue);
    zones.clear();
    ensureWorld(db, dataDir, seedValue, zones);
    plantItems();
    await engine.start(onDelta);
  };
  return { db, engine, reset };
}

// The offline roles: deterministic interpreter, template narrator and no model-written memories.
// Used by the tests and whenever no API key is configured.
export function offlineServices(): EngineServices {
  return { narrator: new OfflineNarrator(), interpreter: new OfflineInterpreter(), memories: new OfflineMemories() };
}
