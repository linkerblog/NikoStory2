import { openDb, type Db } from "./db.js";
import { Engine } from "./engine.js";
import { loadZone, seed } from "./world.js";
import type { Narrator } from "./narrator.js";

export function createGame(dbPath: string, dataDir: string, seedValue: number, narratorFor: (db: Db) => Narrator) {
  const db = openDb(dbPath);
  seed(db, dataDir, seedValue);
  const engine = new Engine(db, loadZone(dataDir), narratorFor(db));
  return { db, engine };
}
