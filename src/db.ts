import Database from "better-sqlite3";

export type Db = Database.Database;

// Every schema change is a new migration at the end; an applied one is never edited.
const MIGRATIONS: string[] = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE entities (
     id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
     zone_id TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
     data TEXT NOT NULL DEFAULT '{}'
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, zone_id TEXT NOT NULL,
     type TEXT NOT NULL, actor_id TEXT, x INTEGER, y INTEGER, data TEXT NOT NULL DEFAULT '{}'
   );
   CREATE TABLE witnesses (
     event_id INTEGER NOT NULL REFERENCES events(id), character_id TEXT NOT NULL,
     PRIMARY KEY (event_id, character_id)
   );
   CREATE TABLE llm_calls (
     id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, role TEXT NOT NULL,
     model TEXT NOT NULL, tokens_input INTEGER, tokens_output INTEGER, cost REAL,
     request TEXT NOT NULL, response TEXT NOT NULL
   );`,
  `CREATE TABLE memories (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     character_id TEXT NOT NULL,
     event_id INTEGER NOT NULL REFERENCES events(id),
     tick INTEGER NOT NULL,
     zone_id TEXT NOT NULL,
     text TEXT NOT NULL,
     importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 10),
     participants TEXT NOT NULL,
     UNIQUE (character_id, event_id)
   );
   CREATE INDEX idx_memories_character_tick ON memories (character_id, tick DESC);`,
  `CREATE TABLE agenda_state (
     character_id TEXT PRIMARY KEY,
     goal_id      TEXT NOT NULL,
     status       TEXT NOT NULL CHECK (status IN ('active','arrived','done','blocked')),
     since_tick   INTEGER NOT NULL
   );
   CREATE TABLE conversations (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     npc_id       TEXT    NOT NULL,
     goal_id      TEXT    NOT NULL,
     status       TEXT    NOT NULL CHECK (status IN ('open','closed')),
     beat         INTEGER NOT NULL DEFAULT 0,
     started_tick INTEGER NOT NULL
   );
   CREATE TABLE facts_known (
     character_id TEXT    NOT NULL,
     fact_id      TEXT    NOT NULL,
     tick         INTEGER NOT NULL,
     PRIMARY KEY (character_id, fact_id)
   );`,
  `CREATE TABLE zones (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL,
     description  TEXT NOT NULL,
     width        INTEGER NOT NULL,
     height       INTEGER NOT NULL,
     map          TEXT NOT NULL,
     objects      TEXT NOT NULL,
     rooms        TEXT NOT NULL,
     portals      TEXT NOT NULL,
     kind         TEXT NOT NULL,
     created_tick INTEGER NOT NULL
   );`,
  `CREATE TABLE story_summary (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     upto_tick INTEGER NOT NULL,
     text      TEXT NOT NULL
   );`,
  // Conversations gain two explicit participants so two NPCs can hold one too. `npc_id` keeps its
  // NOT NULL for old rows and is no longer read by new code; new inserts write the listener there.
  `ALTER TABLE conversations ADD COLUMN initiator_id TEXT;
   ALTER TABLE conversations ADD COLUMN listener_id TEXT;
   UPDATE conversations SET initiator_id = 'niko' WHERE initiator_id IS NULL;
   UPDATE conversations SET listener_id = npc_id WHERE listener_id IS NULL;`,
  `CREATE TABLE items (
     id        TEXT PRIMARY KEY,
     name      TEXT NOT NULL,
     zone_id   TEXT,
     x         INTEGER,
     y         INTEGER,
     holder_id TEXT,
     hidden    INTEGER NOT NULL DEFAULT 0,
     data      TEXT NOT NULL DEFAULT '{}',
     CHECK ((holder_id IS NULL) <> (zone_id IS NULL))
   );`,
  // Model choices made from the Models tab. A preference of the install, not of the save, so
  // `clearSave` leaves it alone: a new game keeps the models the player picked.
  `CREATE TABLE role_config (
     role      TEXT PRIMARY KEY,
     model     TEXT,
     reasoning INTEGER
   );`,
  // An incident is something the world may react to; the queue carries every delayed consequence. Both
  // belong to the save: `clearSave` wipes them, children first.
  `CREATE TABLE incidents (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     kind          TEXT    NOT NULL,
     zone_id       TEXT    NOT NULL,
     tick          INTEGER NOT NULL,
     tags          TEXT    NOT NULL,
     status        TEXT    NOT NULL CHECK (status IN ('unreported','pending','reported')),
     reported_tick INTEGER,
     last_zone     TEXT    NOT NULL,
     last_tick     INTEGER NOT NULL,
     contacted     INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE scheduled_events (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     due_tick    INTEGER NOT NULL,
     kind        TEXT    NOT NULL CHECK (kind IN ('report','step','sighting')),
     incident_id INTEGER NOT NULL REFERENCES incidents(id),
     payload     TEXT    NOT NULL DEFAULT '{}',
     status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped'))
   );
   CREATE INDEX idx_scheduled_due ON scheduled_events (status, due_tick, id);`,
  // The worldbuilding the author edits in the World tab. Like `role_config` it is a preference of the
  // install, not of the save: `clearSave` leaves it alone, so a new game keeps the world.
  `CREATE TABLE world_doc (
     id  INTEGER PRIMARY KEY CHECK (id = 1),
     doc TEXT    NOT NULL
   );`,
];

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS migrations (n INTEGER PRIMARY KEY)");
  const done = new Set(
    (db.prepare("SELECT n FROM migrations").all() as { n: number }[]).map((r) => r.n),
  );
  MIGRATIONS.forEach((sql, i) => {
    const n = i + 1;
    if (done.has(n)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO migrations (n) VALUES (?)").run(n);
    })();
  });
  return db;
}

// Wipes every game table so a fresh save can be seeded over the same file. Children go first:
// witnesses and memories reference events, so the events cannot be deleted while they survive.
// `migrations` is never touched. `settings` goes last, clearing the seed marker with everything else.
export function clearSave(db: Db): void {
  db.transaction(() => {
    db.exec(`
      DELETE FROM witnesses;
      DELETE FROM memories;
      DELETE FROM events;
      DELETE FROM agenda_state;
      DELETE FROM conversations;
      DELETE FROM facts_known;
      DELETE FROM llm_calls;
      DELETE FROM story_summary;
      DELETE FROM items;
      DELETE FROM scheduled_events;
      DELETE FROM incidents;
      DELETE FROM entities;
      DELETE FROM settings;
      DELETE FROM zones;
    `);
  })();
}

export function getMeta(db: Db, key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function deleteMeta(db: Db, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}
