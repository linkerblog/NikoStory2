import { openDb, type Db } from "./db.js";
import { Engine } from "./engine.js";
import { loadZone, seed } from "./world.js";
import { loadMemoryRules, type MemoryRules } from "./memory.js";
import type { Narrator } from "./narrator.js";

export function createGame(
  dbPath: string,
  dataDir: string,
  seedValue: number,
  narratorFor: (db: Db, rules: MemoryRules) => Narrator,
) {
  const db = openDb(dbPath);
  seed(db, dataDir, seedValue);
  const rules = loadMemoryRules(dataDir);
  const engine = new Engine(db, loadZone(dataDir), narratorFor(db, rules), rules);
  return { db, engine };
}
