import { clearSave, getMeta, openDb, type Db } from "./db.js";
import { generateGovernment, loadGovernmentData, plantGovernment, readGovernment, sanitizeGovernment } from "./government.js";
import { Engine, type EngineServices } from "./engine.js";
import { applyPersonalities, loadOpening, loadWorld, loadZone, seed } from "./world.js";
import { castBrief, generateCast, loadCast } from "./cast.js";
import { loadHomes, pickStart } from "./homes.js";
import { ZoneStore, ensureWorld, loadCity } from "./zones.js";
import { loadMemoryRules, OfflineMemories, type MemoryRules } from "./memory.js";
import { loadScene, loadStakesRules, type StakesRules } from "./stakes.js";
import { loadRules, type GameRules } from "./rules.js";
import { OfflineNarrator, type DeltaSink } from "./narrator.js";
import { OfflineInterpreter } from "./interpreter.js";
import { loadItems, seedItems } from "./items.js";
import { compileWorld, publicWorld, readWorldDoc } from "./worlddoc.js";

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
  const memory = loadMemoryRules(dataDir);
  const stakes = loadStakesRules(dataDir);
  const gameRules = loadRules(dataDir);
  const scene = loadScene(dataDir);
  // The authored house validates the opening and the cast's own spawns; every home, the city and the scene are
  // checked here, before any save is touched, so a bad data file fails at start-up and not mid-game.
  const authored = loadZone(dataDir);
  const opening = loadOpening(dataDir, authored);
  const cast = loadCast(dataDir, authored, scene);
  const homes = loadHomes(dataDir, cast.slots.map((s) => s.role), opening.landing.steer_room);
  const city = loadCity(dataDir);
  const lots = city.lots.map((l) => l.id);
  // The first boot is the authored game: the authored house on the street.
  seed(db, dataDir, seedValue, undefined, pickStart(homes, lots));
  const zones = new ZoneStore(db);
  ensureWorld(db, city, homes, zones);
  // Items are validated against the zones and the scene facts, then inserted once per save. The ones that name
  // an object (`on`) follow the home the save drew.
  const plantItems = () => seedItems(db, loadItems(dataDir, (id) => zones.get(id), scene, zones.get(getMeta(db, "home") ?? "")));
  plantItems();
  const world = loadWorld(dataDir);
  // The roles that write the new game's people and institutions read the world as anyone in it would
  // know it, with the author's edit from the World tab applied at the moment of the reset.
  const openWorld = () => publicWorld((() => { const doc = readWorldDoc(db); return doc ? compileWorld(doc) : world; })());
  const govData = loadGovernmentData(dataDir, gameRules.incidents.government);
  // Every save has a government, the deterministic one until a model writes a better one at a reset.
  const plantDefaultGovernment = (gameSeed: number) => {
    if (!readGovernment(db)) plantGovernment(db, generateGovernment(govData, gameSeed));
  };
  plantDefaultGovernment(Number(getMeta(db, "seed")));
  const services = servicesFor(db, memory, stakes, gameRules);
  const engine = new Engine(db, zones, services, gameRules, memory, stakes, scene, opening, world, govData);
  // Reset reuses the same engine: only the rows change, so every rule and role stays loaded.
  // The zone store is cleared too, so generated buildings are rebuilt from scratch. Given a `seed`, the
  // new game is a new world: that seed becomes the save's seed and the NPCs are generated from it.
  // Without one, the authored game restarts as it began.
  const reset = async (onDelta?: DeltaSink, options: { seed?: number } = {}): Promise<void> => {
    const fresh = options.seed;
    const gameSeed = fresh ?? seedValue;
    // A new game draws where it opens too: a home and a lot of the city, from the same seed as the cast.
    const start = pickStart(homes, lots, fresh);
    const generated = fresh === undefined ? undefined : generateCast(cast, fresh, start.home);
    clearSave(db);
    seed(db, dataDir, gameSeed, generated, start);
    zones.clear();
    ensureWorld(db, city, homes, zones);
    plantItems();
    plantDefaultGovernment(gameSeed);
    // Same rule for the government: the save is whole with the deterministic one, so a model that fails,
    // times out or writes something the engine rejects changes nothing.
    if (generated && services.governor) {
      onDelta?.({ kind: "stage", text: "governing" });
      try {
        const written = await services.governor.write({ world: openWorld(), tags: govData.tags, limits: gameRules.incidents.government }, onDelta);
        // Checked again here: the writer is a role, and the engine trusts no role's output.
        const checked = written && sanitizeGovernment(written, govData.tags, gameRules.incidents.government).government;
        if (checked) plantGovernment(db, checked);
      } catch (e) {
        console.warn("The government call failed, keeping the generated one:", (e as Error).message);
      }
    }
    // The save is already whole with the pool temperaments, so the model is asked after the seed: its call
    // is logged in the new save (`clearSave` empties `llm_calls`) and a slow or failed call changes nothing.
    if (generated && services.castwriter) {
      onDelta?.({ kind: "stage", text: "casting" });
      try {
        const bearings = Object.fromEntries(Object.entries(cast.bearings).map(([id, b]) => [id, b.word]));
        const picks = await services.castwriter.write({ characters: castBrief(generated), world: openWorld(), bearings }, onDelta);
        if (picks) applyPersonalities(db, picks, cast.bearings);
      } catch (e) {
        console.warn("The cast call failed, keeping the generated temperaments:", (e as Error).message);
      }
    }
    await engine.start(onDelta);
  };
  return { db, engine, reset };
}

// The offline roles: deterministic interpreter, template narrator and no model-written memories.
// Used by the tests and whenever no API key is configured.
export function offlineServices(): EngineServices {
  return { narrator: new OfflineNarrator(), interpreter: new OfflineInterpreter(), memories: new OfflineMemories() };
}
