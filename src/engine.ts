import { getMeta, setMeta, type Db } from "./db.js";
import { rngFor } from "./rng.js";
import {
  roomAt, DEFAULT_OPENING, DEFAULT_WORLD, type Ent, type Opening, type Portal, type WorldFacts, type Zone,
} from "./world.js";
import { buildingSpec, generateBuilding, validateZoneDraft, type ZoneStore } from "./zones.js";
import type { Context, DeltaSink, Narrator, TurnEffects } from "./narrator.js";
import {
  memoryFromEvent, recalledLines, type MemoryEvent, type MemoryQuery, type MemoryRules, type MemorySentence,
  type MemoryWriteContext, type MemoryWriter, DEFAULT_MEMORY_RULES,
} from "./memory.js";
import { bfsStep, deltaDir, goalPoint, reached, type Agenda } from "./agenda.js";
import { DEFAULT_STAKES_RULES, chebyshev, directionWord, proximityLabel, type Scene, type StakesRules } from "./stakes.js";
import { DEFAULT_RULES, type GameRules } from "./rules.js";
import { describeEffect, keywordsOf, type Effect, type Interpretation, type InterpretContext, type Interpreter } from "./interpreter.js";
import type { NpcContext, NpcDecision, NpcDecider } from "./npc.js";
import type { Action, Dir, ItemRef, ItemVerb, ReplyChoice } from "./actions.js";
import { readItems, type Item } from "./items.js";
import type { CastWriter } from "./cast.js";

export type { Action, Dir, ItemVerb, ReplyChoice } from "./actions.js";
export { parseFreeAction } from "./actions.js";
export type { Effect, Interpretation } from "./interpreter.js";

export interface FallIntent { steer: boolean; brace: boolean }
// The opening is free text: the player writes what Niko does and this deterministic scan turns it
// into the physics the engine applies, so neither a model nor a client can bypass the outcome.
const BRACE_WORDS = ["brace", "resist", "absorb", "cushion", "tuck", "roll", "endure", "shield", "guard", "take the hit", "soften", "break the fall"];
const STEER_WORDS = ["steer", "aim", "glide", "angle", "direct", "guide", "toward", "towards", "head for", "dive", "slant", "lean", "reach the"];
export function fallIntent(text: string): FallIntent {
  const t = text.toLowerCase();
  return {
    brace: BRACE_WORDS.some((w) => t.includes(w)),
    steer: STEER_WORDS.some((w) => t.includes(w)),
  };
}

// The roles the engine needs. The interpreter turns free text into effects; the narrator writes the
// turn; the memory writer words the memories and the rolling summary. All optional but the first two.
export interface EngineServices {
  narrator: Narrator;
  interpreter: Interpreter;
  memories?: MemoryWriter;
  // Optional: proposes one NPC's action. Without it (offline, tests, over budget) the engine keeps its
  // deterministic agenda step, so behavior and replay are unchanged.
  npcdecider?: NpcDecider;
  // Optional: writes the personality and voice of a new game's cast. Without it (offline, tests) the
  // generated temperaments from `data/cast.json` stand. Used by `reset` in `src/game.ts`, not by turns.
  castwriter?: CastWriter;
}

// A conversation is between two participants. `npc_id` is legacy (kept for the NOT NULL of old rows)
// and new code reads `initiator_id`/`listener_id`, which migration 6 backfills to ('niko', npc_id).
interface Conversation {
  id: number; npc_id: string; goal_id: string; status: string; beat: number; started_tick: number;
  initiator_id: string | null; listener_id: string | null;
}

const DIR: Record<Dir, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
const DIR_WORD: Record<Dir, string> = { N: "north", S: "south", E: "east", W: "west" };
export const VISION_RANGE = 8;
const MSG_DOOR = "That door is sealed.";
// Low-importance event kinds keep their deterministic template sentence and cost no model call.
const TEMPLATE_TYPES = new Set(["move", "wait", "appears", "take", "drop", "search"]);
const ITEM_VERBS: ReadonlySet<string> = new Set<ItemVerb>(["take", "drop", "search", "read"]);
const MSG_NO_ITEM = "There is no such item here.";

type Point = { x: number; y: number };
type Applied = { ok: true; notable: string[] } | { ok: false; error: string };

// Bresenham: only the intermediate tiles can block the view.
export function lineClear(z: Zone, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  while (x !== x1 || y !== y1) {
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
    if ((x !== x1 || y !== y1) && z.map[y][x] === "#") return false;
  }
  return true;
}

export function canSee(z: Zone, a: Point, b: Point): boolean {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy <= VISION_RANGE * VISION_RANGE && lineClear(z, a.x, a.y, b.x, b.y);
}

const near = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;

export class Engine {
  // Set when the opening lands; drives the one landing narration and then clears.
  private pendingImpact: "soft" | "hard" | null = null;
  // The live sink for the turn in progress; turns are serialized, so one field is enough.
  private onDelta: DeltaSink | undefined;
  // Events whose memory wording the `memory` role writes at the end of the turn.
  private pendingMemory: MemoryEvent[] = [];
  // NPCs that already asked the decider this player turn, so a multi-effect turn never multiplies calls.
  private npcProposed = new Set<string>();

  constructor(
    private db: Db,
    private zones: ZoneStore,
    private services: EngineServices,
    private rules: GameRules = DEFAULT_RULES,
    private memory: MemoryRules = DEFAULT_MEMORY_RULES,
    private stakes: StakesRules = DEFAULT_STAKES_RULES,
    private scene: Scene = { question: "", facts: [] },
    private opening: Opening = DEFAULT_OPENING,
    private world: WorldFacts = DEFAULT_WORLD,
  ) {}

  private get narrator(): Narrator { return this.services.narrator; }

  // The zone Niko is in. Zones live in the store (and the database), so the engine can move between
  // the house, the street and generated buildings without a single hard-coded map.
  get zone(): Zone {
    const id = this.ents().find((e) => e.id === "niko")!.zone_id;
    const z = this.zones.get(id);
    if (!z) throw new Error(`Niko is in unknown zone ${id}`);
    return z;
  }

  private tick(): number { return Number(getMeta(this.db, "tick")); }
  private seed(): number { return Number(getMeta(this.db, "seed")); }

  // A new game starts in the `fall`; a legacy save (no `phase`) behaves as `play`.
  private phase(): "fall" | "play" {
    return getMeta(this.db, "phase") === "fall" ? "fall" : "play";
  }

  private fallBeat(): number { return Number(getMeta(this.db, "fall_beat") ?? "0"); }

  // The free text of each fall beat, oldest first. Legacy saves stored the old choice ids here and
  // they still read back as text, so `fallIntent` gives them the same outcome.
  private fallLog(): string[] {
    try {
      const v = JSON.parse(getMeta(this.db, "fall_log") ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  private fallBrace(): boolean { return getMeta(this.db, "fall_brace") === "1"; }

  private abilityCost(id: string): number { return this.rules.abilities[id]?.ether_cost ?? 0; }

  private ents(): Ent[] {
    return (this.db.prepare("SELECT * FROM entities ORDER BY rowid").all() as any[]).map((r) => ({
      id: r.id, type: r.type, name: r.name, zone_id: r.zone_id, x: r.x, y: r.y, data: JSON.parse(r.data),
    }));
  }

  private free(x: number, y: number, ents: Ent[]): boolean {
    const z = this.zone;
    return x >= 0 && y >= 0 && x < z.width && y < z.height && z.map[y][x] === "." &&
      !z.objects.some((o) => o.blocks && o.x === x && o.y === y) &&
      !ents.some((e) => e.zone_id === z.id && e.x === x && e.y === y);
  }

  private moveTo(e: Ent, x: number, y: number) {
    e.x = x; e.y = y;
    this.db.prepare("UPDATE entities SET x = ?, y = ? WHERE id = ?").run(x, y, e.id);
  }

  // Moving through a door: the entity changes zone, not just tile.
  private setZone(e: Ent, zone: Zone, x: number, y: number): void {
    e.zone_id = zone.id; e.x = x; e.y = y;
    this.db.prepare("UPDATE entities SET zone_id = ?, x = ?, y = ? WHERE id = ?").run(zone.id, x, y, e.id);
  }

  // The event is born with its witnesses: only those who could see it "know" it. The event and its
  // witnesses commit together; memories for the wording-matters kinds are written later, still
  // append-only, and every witness always ends up with one (the template is the fallback).
  private record(type: string, x: number, y: number, actor: string | null, data: object, withWitnesses: boolean): void {
    const tick = this.tick();
    const z = this.zone;
    const here = this.ents().filter((e) => e.zone_id === z.id);
    const names: Record<string, string> = {};
    for (const e of here) names[e.id] = e.name;
    for (const o of z.objects) names[o.id] = o.name;
    for (const i of readItems(this.db)) names[i.id] = i.name;
    const witnesses = withWitnesses
      ? here.filter((e) => canSee(z, e, { x, y })).map((e) => e.id)
      : [];
    const base: Omit<MemoryEvent, "id"> = { tick, zone_id: z.id, type, actor_id: actor, x, y, data, names, witnesses };
    this.db.transaction(() => {
      const id = Number(
        this.db.prepare("INSERT INTO events (tick, zone_id, type, actor_id, x, y, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(tick, z.id, type, actor, x, y, JSON.stringify(data)).lastInsertRowid,
      );
      const insWitness = this.db.prepare("INSERT INTO witnesses (event_id, character_id) VALUES (?, ?)");
      for (const w of witnesses) insWitness.run(id, w);
      const event: MemoryEvent = { ...base, id };
      if (witnesses.length && !TEMPLATE_TYPES.has(type)) {
        this.pendingMemory.push(event);
        return;
      }
      const insMemory = this.db.prepare(
        `INSERT OR IGNORE INTO memories (character_id, event_id, tick, zone_id, text, importance, participants)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const w of witnesses) {
        const m = memoryFromEvent(event, w, this.memory);
        insMemory.run(m.character_id, m.event_id, m.tick, m.zone_id, m.text, m.importance, JSON.stringify(m.participants));
      }
    })();
  }

  // Where a mover appears when entering `zone` from `fromId`: the walkable tile next to the zone's
  // own portal back to `fromId`. This keeps the two doors of a link in agreement with no coordinates
  // stored twice, so navigation is coherent at every scale (house <-> street <-> building).
  private entryTile(zone: Zone, fromId: string, mover: Ent): Point {
    const q = (zone.portals ?? []).find((p) => p.to === fromId);
    const others = this.ents().filter((e) => e.zone_id === zone.id && e.id !== mover.id);
    const freeAt = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < zone.width && y < zone.height && zone.map[y][x] === "." &&
      !zone.objects.some((o) => o.blocks && o.x === x && o.y === y) &&
      !others.some((e) => e.x === x && e.y === y);
    if (q) {
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
        if (freeAt(q.x + dx, q.y + dy)) return { x: q.x + dx, y: q.y + dy };
      }
    }
    for (let y = 0; y < zone.height; y++) for (let x = 0; x < zone.width; x++) if (freeAt(x, y)) return { x, y };
    return { x: 1, y: 1 };
  }

  // The engine asks the architect for a building; the model proposes, the engine decides. A missing,
  // invalid or over-budget draft is replaced by the deterministic generator, so play never stops.
  private async buildZone(portal: Portal): Promise<Zone> {
    const spec = buildingSpec(portal);
    const fallback = generateBuilding(this.seed(), spec);
    if (!this.narrator.generateZone) return fallback;
    try {
      const draft = await this.narrator.generateZone({
        id: spec.id, name: spec.name, kind: "building", width: spec.width, height: spec.height,
        entry: spec.entry, tick: this.tick(), world: this.world,
      });
      return validateZoneDraft(draft, spec) ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async enterPortal(portal: Portal, niko: Ent, notable: string[]): Promise<void> {
    const from = this.zone;
    let target = this.zones.get(portal.to);
    if (!target) {
      target = await this.buildZone(portal);
      this.zones.put(target);
      notable.push(`Niko enters ${target.name}.`);
    } else {
      notable.push(`Niko goes through to ${target.name}.`);
    }
    const spot = this.entryTile(target, from.id, niko);
    this.setZone(niko, target, spot.x, spot.y);
    this.record("enter", spot.x, spot.y, "niko", { from: from.id, to: target.id, label: portal.label }, true);
    setMeta(this.db, "visible", JSON.stringify(this.visibleActors(niko, this.ents()).map((e) => e.id).sort()));
  }

  // The two participants of a conversation, tolerating a legacy row that predates migration 6.
  private participants(c: Conversation): string[] {
    const a = c.initiator_id ?? "niko";
    const b = c.listener_id ?? c.npc_id;
    return a === b ? [a] : [a, b];
  }

  private hasParticipant(c: Conversation, id: string): boolean {
    return this.participants(c).includes(id);
  }

  // Whose turn it is in a two-sided exchange: the listener answers an odd beat, the initiator an
  // even one. An NPC conversation opens on beat 1, so the listener answers first.
  private mayAdvance(c: Conversation, id: string): boolean {
    const parts = this.participants(c);
    if (parts.length < 2) return true;
    return id === (c.beat % 2 === 0 ? parts[0] : parts[1]);
  }

  private openConversations(): Conversation[] {
    return this.db.prepare("SELECT * FROM conversations WHERE status = 'open' ORDER BY id DESC").all() as Conversation[];
  }

  // The newest open conversation that involves `id`, or Niko's when called with no argument.
  private conversationFor(id: string): Conversation | undefined {
    return this.openConversations().find((c) => this.hasParticipant(c, id));
  }

  private conversation(): Conversation | undefined {
    return this.conversationFor("niko");
  }

  private agendaOf(e: Ent): Agenda | null {
    const a = e.data?.agenda as Agenda | undefined;
    return a && typeof a.goal_id === "string" && typeof a.want === "string" ? a : null;
  }

  private agendaRow(characterId: string): { status: string; goal_id: string; since_tick: number } | undefined {
    return this.db
      .prepare("SELECT goal_id, status, since_tick FROM agenda_state WHERE character_id = ?")
      .get(characterId) as { status: string; goal_id: string; since_tick: number } | undefined;
  }

  // Agendas are authored in data but their status lives in the database. A missing row (an old save,
  // or an NPC that just gained an agenda) starts active, so no savegame needs to be wiped.
  private ensureAgenda(npc: Ent, agenda: Agenda): { status: string; goal_id: string; since_tick: number } {
    const row = this.agendaRow(npc.id);
    if (row) return row;
    this.db.prepare("INSERT INTO agenda_state (character_id, goal_id, status, since_tick) VALUES (?, ?, 'active', ?)")
      .run(npc.id, agenda.goal_id, this.tick());
    return { status: "active", goal_id: agenda.goal_id, since_tick: this.tick() };
  }

  private setAgenda(characterId: string, status: string): void {
    this.db.prepare("UPDATE agenda_state SET status = ?, since_tick = ? WHERE character_id = ?")
      .run(status, this.tick(), characterId);
  }

  private closeConversation(convo: Conversation, actor: Ent, notable: string[]): void {
    this.db.prepare("UPDATE conversations SET status = 'closed' WHERE id = ?").run(convo.id);
    const parts = this.participants(convo);
    const ents = this.ents();
    const nikoInvolved = parts.includes("niko");
    let goalId = convo.goal_id;
    let factId: string | null = null;
    for (const p of parts) {
      const npc = ents.find((e) => e.id === p && e.type === "npc");
      const agenda = npc ? this.agendaOf(npc) : null;
      if (!npc || !agenda) continue;
      goalId = agenda.goal_id;
      this.ensureAgenda(npc, agenda);
      if (this.agendaRow(npc.id)?.status !== "done") this.setAgenda(npc.id, "done");
      if (agenda.reveals) {
        factId = agenda.reveals;
        // Only Niko's knowledge is tracked so far: an NPC-to-NPC exchange records the event, no fact.
        if (nikoInvolved) {
          this.db.prepare("INSERT OR IGNORE INTO facts_known (character_id, fact_id, tick) VALUES ('niko', ?, ?)")
            .run(agenda.reveals, this.tick());
        }
      }
    }
    const otherId = parts.find((p) => p !== actor.id) ?? null;
    this.record("talked", actor.x, actor.y, actor.id, { target: otherId, participants: parts, goal_id: goalId, fact_id: factId }, true);
    const otherName = (otherId && ents.find((e) => e.id === otherId)?.name) || otherId || "them";
    notable.push(`${actor.name} stops talking with ${otherName}.`);
  }

  private visibleActors(niko: Ent, ents: Ent[]): Ent[] {
    // Niko keeps his seed tile in the house while he falls, but he is in the open sky: nobody is in
    // reach of his eyes until the landing puts him on a tile.
    if (this.phase() === "fall") return [];
    const z = this.zone;
    return ents.filter((e) => e.type === "npc" && e.zone_id === z.id && canSee(z, niko, e));
  }

  private where(niko: Point, e: Point): string {
    if (chebyshev(niko, e) <= this.stakes.proximity.adjacent) return "right next to Niko";
    const dir = directionWord(niko, e);
    return `${proximityLabel(chebyshev(niko, e), this.stakes) === "near" ? "nearby" : "far away"}, to the ${dir}`;
  }

  private recentNarrations(limit: number): string[] {
    const rows = this.db.prepare("SELECT data FROM events WHERE type = 'narration' ORDER BY id DESC LIMIT ?")
      .all(limit) as { data: string }[];
    return rows.map((r) => (JSON.parse(r.data) as { text: string }).text).reverse();
  }

  private lastMove(): string | null {
    const row = this.db
      .prepare("SELECT data FROM events WHERE type = 'move' AND actor_id = 'niko' ORDER BY id DESC LIMIT 1")
      .get() as { data: string } | undefined;
    if (!row) return null;
    const dir = (JSON.parse(row.data) as { dir?: Dir }).dir;
    return dir ? DIR_WORD[dir] ?? null : null;
  }

  // A generated cast words the facts that name a character; the scene's own text is the default, so a
  // save without overrides (the authored cast, or one that predates them) reads exactly as before.
  private factTexts(): Record<string, string> {
    try {
      const v = JSON.parse(getMeta(this.db, "fact_texts") ?? "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  private knownFacts(): string[] {
    const ids = (this.db.prepare("SELECT fact_id FROM facts_known WHERE character_id = 'niko'").all() as
      { fact_id: string }[]).map((r) => r.fact_id);
    const texts = this.factTexts();
    return this.scene.facts.filter((f) => ids.includes(f.id)).map((f) => texts[f.id] ?? f.text);
  }

  // Items Niko can act on: what he holds and what lies in his zone, not hidden. Hidden items are
  // invisible to every prompt and to the client until somebody searches the object they are in.
  private itemsFor(niko: Ent, items: Item[]): ItemRef[] {
    const z = this.zone;
    const out: ItemRef[] = [];
    for (const i of items) {
      if (i.holder_id === niko.id) out.push({ id: i.id, name: i.name, where: "held" });
      else if (!i.hidden && i.zone_id === z.id && canSee(z, niko, { x: i.x!, y: i.y! })) out.push({ id: i.id, name: i.name, where: "here" });
    }
    return out;
  }

  private knownFactIds(): Set<string> {
    return new Set((this.db.prepare("SELECT fact_id FROM facts_known WHERE character_id = 'niko'").all() as
      { fact_id: string }[]).map((r) => r.fact_id));
  }

  private sceneResolved(): boolean { return getMeta(this.db, "scene_resolved") !== undefined; }

  // True when every fact the goal requires is known. A scene with no goal is never met.
  private goalMet(): boolean {
    const goal = this.scene.goal;
    if (!goal) return false;
    const known = this.knownFactIds();
    return goal.requires.every((id) => known.has(id));
  }

  // Resolves the scene exactly once, on the turn the last required fact is learned, by conversation
  // or by reading. The narration of that same turn already saw `justResolved` through `goalMet`.
  private resolveScene(): void {
    if (!this.scene.goal || this.sceneResolved() || !this.goalMet()) return;
    const niko = this.ents().find((e) => e.id === "niko")!;
    setMeta(this.db, "scene_resolved", String(this.tick()));
    this.record("scene_resolved", niko.x, niko.y, "niko", { goal_id: this.scene.goal.id }, true);
  }

  private storySoFar(): string | null {
    const row = this.db.prepare("SELECT text FROM story_summary ORDER BY id DESC LIMIT 1").get() as
      { text: string } | undefined;
    return row?.text ?? null;
  }

  // The fall beats send their altitude; the landing sends its impact and the choices taken.
  private arrivalContext(): Context["arrival"] {
    if (this.phase() === "fall") {
      const beat = this.fallBeat();
      const i = Math.min(beat, this.opening.beats.length - 1);
      return {
        phase: "fall", altitude: this.opening.beats[i].altitude, beat, beats: this.opening.beats.length,
        text: this.fallLog().at(-1),
      };
    }
    if (this.pendingImpact) {
      return {
        phase: "play",
        altitude: this.opening.beats[this.opening.beats.length - 1].altitude,
        beat: this.opening.beats.length,
        beats: this.opening.beats.length,
        impact: this.pendingImpact,
        choices: this.fallLog(),
      };
    }
    return undefined;
  }

  private async narrate(events: string[], effects?: TurnEffects, keywords?: string[]): Promise<void> {
    this.onDelta?.({ kind: "stage", text: "narrating" });
    const ents = this.ents();
    const niko = ents.find((e) => e.id === "niko")!;
    const visible = this.visibleActors(niko, ents);
    const convo = this.conversation();
    const convoOther = convo ? this.participants(convo).find((p) => p !== "niko") : undefined;
    const convoNpc = convoOther ? ents.find((e) => e.id === convoOther) : undefined;
    const arrival = this.arrivalContext();
    this.pendingImpact = null;
    // While he falls the house is not his place: telling the narrator "Living Room" would put walls
    // and people around a character who is alone in the air.
    const place = this.phase() === "fall"
      ? { name: "The sky", description: "Open air high above the world. Niko is alone and nothing else is within reach." }
      : { name: this.zone.name, description: this.zone.description, room: roomAt(this.zone, niko.x, niko.y) };
    const n = await this.narrator.narrate({
      tick: this.tick(),
      sheet: { name: niko.name, ...niko.data },
      place,
      world: this.world,
      arrival,
      visible: visible.map((e) => ({
        name: e.name,
        proximity: proximityLabel(chebyshev(niko, e), this.stakes),
        direction: directionWord(niko, e),
        personality: String(e.data.personality ?? ""),
      })),
      events,
      effects,
      summary: this.storySoFar(),
      lastMove: this.lastMove(),
      recentNarrations: this.recentNarrations(this.stakes.promptNarrations),
      scene: {
        question: this.scene.question,
        knownFacts: this.knownFacts(),
        // The goal text is the story's answer: it reaches the narrator only once Niko knows it.
        goal: this.goalMet() ? this.scene.goal?.text : undefined,
        resolved: this.sceneResolved() || this.goalMet(),
        justResolved: !this.sceneResolved() && this.goalMet(),
      },
      conversation: convo && convoNpc
        ? { npc: convoNpc.name, beat: convo.beat, maxBeats: this.stakes.maxBeats, want: this.agendaOf(convoNpc)?.want ?? "" }
        : null,
      memory: {
        characterId: niko.id, tick: this.tick(), zoneId: this.zone.id,
        presentCharacters: visible.map((e) => e.id),
        keywords,
      },
    }, this.onDelta);
    this.record(
      "narration", niko.x, niko.y, null,
      { text: n.text, degraded: !!n.degraded, resolved: effects?.resolved ?? [], rejected: effects?.rejected ?? [] },
      false,
    );
  }

  // The interpreter sees the same situation the narrator does: who is visible, the zone with its
  // object and portal ids, the open conversation, the rolling summary and Niko's recalled memories.
  private interpretContext(text: string): InterpretContext {
    const ents = this.ents();
    const niko = ents.find((e) => e.id === "niko")!;
    const z = this.zone;
    const convo = this.conversation();
    const convoOther = convo ? this.participants(convo).find((p) => p !== "niko") : undefined;
    const convoNpc = convoOther ? ents.find((e) => e.id === convoOther) : undefined;
    const visible = this.visibleActors(niko, ents);
    const query: MemoryQuery = {
      characterId: niko.id, tick: this.tick(), zoneId: z.id,
      presentCharacters: visible.map((e) => e.id), keywords: keywordsOf(text),
    };
    return {
      text,
      tick: this.tick(),
      sheet: { name: niko.name, ...niko.data },
      ether: Number(niko.data.ether ?? 0),
      etherMax: Number(niko.data.ether_max ?? 0),
      rules: this.rules,
      zone: z,
      ents,
      visible: visible.map((e) => ({
        id: e.id, name: e.name,
        proximity: proximityLabel(chebyshev(niko, e), this.stakes),
        direction: directionWord(niko, e),
      })),
      items: this.itemsFor(niko, readItems(this.db)),
      conversation: convo && convoNpc
        ? { npc_id: convo.npc_id, npc: convoNpc.name, beat: convo.beat, want: this.agendaOf(convoNpc)?.want ?? "" }
        : null,
      memories: recalledLines(this.db, query, this.memory),
      summary: this.storySoFar(),
      recentNarrations: this.recentNarrations(this.stakes.promptNarrations),
    };
  }

  async start(onDelta?: DeltaSink): Promise<void> {
    if (getMeta(this.db, "started")) return;
    this.onDelta = onDelta;
    try {
      const ents = this.ents();
      const niko = ents.find((e) => e.id === "niko")!;
      const vis = this.visibleActors(niko, ents);
      setMeta(this.db, "visible", JSON.stringify(vis.map((e) => e.id).sort()));
      const events: string[] = [];
      if (this.phase() === "fall") {
        events.push(`Niko falls ${this.opening.beats[0].altitude}.`);
      } else {
        events.push("Niko wakes up in a bedroom he does not know. The house is silent.");
        for (const e of vis) events.push(`${e.name} is in the room, ${this.where(niko, e)}.`);
      }
      await this.narrate(events);
      setMeta(this.db, "started", "1");
    } finally {
      this.onDelta = undefined;
    }
  }

  async takeTurn(a: Action, onDelta?: DeltaSink): Promise<{ ok: boolean; error?: string }> {
    this.onDelta = onDelta;
    this.pendingMemory = [];
    this.npcProposed.clear();
    try {
      const r = await this.runTurn(a);
      if (r.ok) {
        this.resolveScene();
        await this.flushMemories();
        await this.maybeSummarize();
      }
      return r;
    } finally {
      this.onDelta = undefined;
      this.pendingMemory = [];
      this.npcProposed.clear();
    }
  }

  private async runTurn(a: Action): Promise<{ ok: boolean; error?: string }> {
    if (this.phase() === "fall") return this.fallStep(a);
    if (a.type === "free") return this.freeTurn(a.text ?? "");
    if (a.type === "fall") return { ok: false, error: "Niko is not falling." };

    const applied = await this.applyAction(a);
    if (!applied.ok) return applied;
    const notable = [...applied.notable, ...(await this.stepWorld())];
    if (notable.length) await this.narrate(notable);
    return { ok: true };
  }

  // One free-text turn: interpret, apply each effect in order (one effect = one tick), stop at the
  // first rejection, then narrate the whole turn once with what resolved and what did not.
  private async freeTurn(text: string): Promise<{ ok: boolean; error?: string }> {
    const t = text.trim();
    if (!t) return { ok: false, error: "Say what Niko does." };
    if (t.length > 500) return { ok: false, error: "That is too long. Keep it short." };

    this.onDelta?.({ kind: "stage", text: "interpreting" });
    let interp: Interpretation;
    try {
      interp = await this.services.interpreter.interpret(this.interpretContext(t), this.onDelta);
    } catch (e) {
      console.warn("The interpreter failed:", (e as Error).message);
      return { ok: false, error: "Niko did not catch that. Try again." };
    }
    if (interp.effects.length > this.rules.maxEffects) {
      return { ok: false, error: "That asks for too much at once. Break it up." };
    }
    if (interp.impossible || interp.effects.length === 0) {
      const reason = interp.impossible?.reason ?? "Nothing in that can be done here.";
      await this.narrate([`Niko cannot do that: ${reason}`], { resolved: [], rejected: [{ effect: t, reason }] }, interp.keywords);
      return { ok: false, error: reason };
    }

    const notable: string[] = [];
    const resolved: string[] = [];
    const rejected: { effect: string; reason: string }[] = [];
    for (const e of interp.effects) {
      this.onDelta?.({ kind: "stage", text: "resolving" });
      const r = await this.applyEffect(e);
      if (!r.ok) {
        rejected.push({ effect: describeEffect(e), reason: r.error });
        break;
      }
      resolved.push(describeEffect(e));
      notable.push(...r.notable, ...(await this.stepWorld()));
    }
    const events = notable.length
      ? notable
      : resolved.length ? resolved.map((d) => `Niko: ${d}.`) : [`Niko tries: ${t}`];
    await this.narrate(events, { resolved, rejected }, interp.keywords);
    if (!resolved.length) return { ok: false, error: rejected[0]?.reason ?? "Niko cannot do that." };
    return { ok: true };
  }

  // A move path is validated in full before any step runs, so a path through a wall changes nothing.
  private validatePath(path: Dir[]): string | null {
    if (path.length > this.rules.maxPathSteps) return "That path is too long.";
    const z = this.zone;
    const ents = this.ents();
    const niko = ents.find((e) => e.id === "niko")!;
    let p: Point = { x: niko.x, y: niko.y };
    for (let i = 0; i < path.length; i++) {
      const d = DIR[path[i]];
      if (!d) return "Invalid direction.";
      const nx = p.x + d[0], ny = p.y + d[1];
      if (nx < 0 || ny < 0 || nx >= z.width || ny >= z.height) return "Out of the map.";
      if (z.map[ny][nx] === "D") {
        if (i !== path.length - 1) return "A path cannot pass through a door.";
        const portal = (z.portals ?? []).find((q) => q.x === nx && q.y === ny);
        return portal ? null : MSG_DOOR;
      }
      if (!this.free(nx, ny, ents)) return "Something blocks the way.";
      p = { x: nx, y: ny };
    }
    return null;
  }

  private async applyEffect(e: Effect): Promise<Applied> {
    switch (e.kind) {
      case "move": {
        if (!e.path.length) return { ok: false, error: "That path is empty." };
        const bad = this.validatePath(e.path);
        if (bad) return { ok: false, error: bad };
        const notable: string[] = [];
        for (const dir of e.path) {
          const r = await this.applyAction({ type: "move", dir });
          if (!r.ok) return r;
          notable.push(...r.notable);
        }
        return { ok: true, notable };
      }
      case "wait":
        return this.applyAction({ type: "wait" });
      case "speak": {
        if (e.to === null) return this.applyAction({ type: "say", text: e.text });
        const convo = this.conversation();
        if (convo && this.hasParticipant(convo, e.to)) {
          return this.applyAction({ type: "reply", target: e.to, choice: e.tone ?? "ask" });
        }
        return this.applyAction({ type: "talk", target: e.to });
      }
      case "end_conversation": {
        const convo = this.conversation();
        if (!convo) return { ok: false, error: "There is no conversation to end." };
        return this.applyAction({ type: "leave", target: convo.npc_id });
      }
      case "interact":
        if (e.verb === "examine") return this.applyAction({ type: "examine", target: e.target });
        if (ITEM_VERBS.has(e.verb)) return this.applyAction({ type: "item", verb: e.verb as ItemVerb, target: e.target });
        return { ok: false, error: "Niko cannot do that with it." };
      case "ability":
        return this.applyAction({ type: "ability", id: e.id, target: e.target });
    }
  }

  // The four item verbs. Every precondition is checked before any row changes, so a rejected verb
  // leaves no tick and no event. A hidden item answers like a missing one, so nothing leaks.
  private applyItem(a: { verb: ItemVerb; target: string }, niko: Ent): Applied {
    const z = this.zone;
    const items = readItems(this.db);
    const itemAt = (i: Item | undefined): i is Item => !!i && !i.hidden && i.zone_id === z.id;
    switch (a.verb) {
      case "take": {
        const it = items.find((i) => i.id === a.target);
        if (!itemAt(it)) return { ok: false, error: MSG_NO_ITEM };
        if (!near(niko, { x: it.x!, y: it.y! })) return { ok: false, error: "That item is out of reach." };
        if (!it.data.portable) return { ok: false, error: "That cannot be carried." };
        if (items.filter((i) => i.holder_id === niko.id).length >= this.rules.inventorySlots) {
          return { ok: false, error: "Niko cannot carry any more." };
        }
        this.db.prepare("UPDATE items SET holder_id = ?, zone_id = NULL, x = NULL, y = NULL WHERE id = ?").run(niko.id, it.id);
        this.record("take", niko.x, niko.y, niko.id, { target: it.id }, true);
        return { ok: true, notable: [`Niko takes ${it.name}.`] };
      }
      case "drop": {
        const it = items.find((i) => i.id === a.target && i.holder_id === niko.id);
        if (!it) return { ok: false, error: "Niko is not carrying that." };
        this.db.prepare("UPDATE items SET holder_id = NULL, zone_id = ?, x = ?, y = ? WHERE id = ?").run(z.id, niko.x, niko.y, it.id);
        this.record("drop", niko.x, niko.y, niko.id, { target: it.id }, true);
        return { ok: true, notable: [`Niko drops ${it.name}.`] };
      }
      case "search": {
        const o = z.objects.find((x) => x.id === a.target);
        if (!o || !near(niko, o)) return { ok: false, error: "You cannot reach that object." };
        const found = items.filter((i) => i.hidden && i.zone_id === z.id && i.x === o.x && i.y === o.y);
        for (const i of found) this.db.prepare("UPDATE items SET hidden = 0 WHERE id = ?").run(i.id);
        this.record("search", niko.x, niko.y, niko.id, { target: o.id, found: found.map((i) => i.id) }, true);
        return {
          ok: true,
          notable: [found.length
            ? `Niko searches ${o.name} and finds ${found.map((i) => i.name).join(" and ")}.`
            : `Niko searches ${o.name} and finds nothing.`],
        };
      }
      case "read": {
        const it = items.find((i) => i.id === a.target && !i.hidden);
        if (!it || (it.holder_id !== niko.id && !itemAt(it))) return { ok: false, error: MSG_NO_ITEM };
        if (it.holder_id !== niko.id && !near(niko, { x: it.x!, y: it.y! })) return { ok: false, error: "That item is out of reach." };
        if (typeof it.data.text !== "string") return { ok: false, error: "There is nothing to read on it." };
        const factId = it.data.reveals ?? null;
        // Reading is a second writer of Niko's facts, equal to a conversation; witnesses learn that he
        // read something, not what it said.
        if (factId) {
          this.db.prepare("INSERT OR IGNORE INTO facts_known (character_id, fact_id, tick) VALUES ('niko', ?, ?)")
            .run(factId, this.tick());
        }
        this.record("read", niko.x, niko.y, niko.id, { target: it.id, fact_id: factId }, true);
        return { ok: true, notable: [`Niko reads ${it.name}: "${it.data.text}"`] };
      }
    }
  }

  // One action, applied to state but with no tick: `runTurn` advances the world once per action or
  // per effect, and a move path advances it once for the whole effect.
  private async applyAction(a: Action): Promise<Applied> {
    const z = this.zone;
    const ents = this.ents();
    const niko = ents.find((e) => e.id === "niko")!;
    const notable: string[] = [];
    const convo = this.conversation();

    // While a conversation is open, the only ways forward are answering it or leaving it.
    if (convo && a.type !== "reply" && a.type !== "leave" && !(a.type === "talk" && this.hasParticipant(convo, a.target))) {
      return { ok: false, error: "Finish the conversation first." };
    }

    switch (a.type) {
      case "move": {
        const d = DIR[a.dir];
        if (!d) return { ok: false, error: "Invalid direction." };
        const nx = niko.x + d[0], ny = niko.y + d[1];
        if (nx < 0 || ny < 0 || nx >= z.width || ny >= z.height) return { ok: false, error: "Out of the map." };
        if (z.map[ny][nx] === "D") {
          const portal = (z.portals ?? []).find((p) => p.x === nx && p.y === ny);
          if (!portal) return { ok: false, error: MSG_DOOR };
          await this.enterPortal(portal, niko, notable);
          return { ok: true, notable };
        }
        if (!this.free(nx, ny, ents)) return { ok: false, error: "Something blocks the way." };
        this.moveTo(niko, nx, ny);
        this.record("move", nx, ny, "niko", { dir: a.dir }, true);
        return { ok: true, notable };
      }
      case "wait":
        this.record("wait", niko.x, niko.y, "niko", {}, true);
        return { ok: true, notable };
      case "say": {
        const text = a.text.trim();
        if (!text) return { ok: false, error: "Say what Niko says." };
        this.record("say", niko.x, niko.y, "niko", { text }, true);
        notable.push(`Niko: ${text}.`);
        return { ok: true, notable };
      }
      case "talk": {
        const t = ents.find((e) => e.id === a.target && e.type === "npc" && e.zone_id === z.id);
        if (!t || !near(niko, t)) return { ok: false, error: "There is no one to talk to there." };
        if (convo) {
          const beat = convo.beat + 1;
          this.record("talk", niko.x, niko.y, "niko", { target: t.id, beat, choice: "ask" }, true);
          if (beat >= this.stakes.maxBeats) this.closeConversation(convo, niko, notable);
          else this.db.prepare("UPDATE conversations SET beat = ? WHERE id = ?").run(beat, convo.id);
          return { ok: true, notable };
        }
        const agenda = this.agendaOf(t);
        this.db.prepare(
          "INSERT INTO conversations (npc_id, goal_id, status, beat, started_tick, initiator_id, listener_id) VALUES (?, ?, 'open', 0, ?, 'niko', ?)",
        ).run(t.id, agenda?.goal_id ?? "none", this.tick(), t.id);
        this.record("talk", niko.x, niko.y, "niko", { target: t.id, beat: 0 }, true);
        notable.push(`Niko talks to ${t.name}.`);
        return { ok: true, notable };
      }
      case "reply": {
        const t = ents.find((e) => e.id === a.target && e.type === "npc" && e.zone_id === z.id);
        if (!convo || !t || !this.hasParticipant(convo, t.id)) return { ok: false, error: "There is no conversation to answer." };
        if (!near(niko, t)) return { ok: false, error: "That conversation is out of reach." };
        const beat = convo.beat + 1;
        this.record("talk", niko.x, niko.y, "niko", { target: t.id, beat, choice: a.choice }, true);
        if (beat >= this.stakes.maxBeats) this.closeConversation(convo, niko, notable);
        else this.db.prepare("UPDATE conversations SET beat = ? WHERE id = ?").run(beat, convo.id);
        return { ok: true, notable };
      }
      case "leave": {
        const t = ents.find((e) => e.id === a.target && e.type === "npc" && e.zone_id === z.id);
        if (!convo || !t || !this.hasParticipant(convo, t.id)) return { ok: false, error: "There is no conversation to leave." };
        this.closeConversation(convo, niko, notable);
        return { ok: true, notable };
      }
      case "examine": {
        const o = z.objects.find((x) => x.id === a.target);
        if (!o) {
          // An item id is examined like an object, through its authored description.
          const it = readItems(this.db).find((i) => i.id === a.target && !i.hidden &&
            (i.holder_id === niko.id || (i.zone_id === z.id && near(niko, { x: i.x!, y: i.y! }))));
          if (!it) return { ok: false, error: "You cannot reach that object." };
          this.record("examine", niko.x, niko.y, "niko", { target: it.id }, true);
          notable.push(`Niko examines ${it.name}.${it.data.description ? ` ${it.data.description}` : ""}`);
          return { ok: true, notable };
        }
        if (!near(niko, o)) return { ok: false, error: "You cannot reach that object." };
        this.record("examine", niko.x, niko.y, "niko", { target: o.id }, true);
        notable.push(`Niko examines ${o.name}.`);
        return { ok: true, notable };
      }
      case "item":
        return this.applyItem(a, niko);
      case "ability": {
        const ability = this.rules.abilities[a.id];
        if (!ability) return { ok: false, error: "Niko cannot do that." };
        if (Number(niko.data.ether ?? 0) < ability.ether_cost) return { ok: false, error: "Not enough Ether." };
        if (a.target && ability.range > 0) {
          const spot = ents.find((e) => e.id === a.target) ?? z.objects.find((o) => o.id === a.target);
          if (!spot || chebyshev(niko, spot) > ability.range) return { ok: false, error: "That is out of reach." };
        }
        niko.data.ether = Number(niko.data.ether ?? 0) - ability.ether_cost;
        this.db.prepare("UPDATE entities SET data = ? WHERE id = 'niko'").run(JSON.stringify(niko.data));
        // Risky outcomes are the engine's: the roll is seeded and stored, never the model's.
        const roll = rngFor(this.seed(), this.tick(), "risk")();
        this.record("ability", niko.x, niko.y, "niko", { id: ability.id, target: a.target ?? null, roll }, true);
        notable.push(`Niko uses ${ability.id}.`);
        return { ok: true, notable };
      }
      default:
        return { ok: false, error: "Unknown action." };
    }
  }

  // A fall turn is not a world turn: no tick, no NPCs and no witnesses until the last beat. The last
  // beat lands Niko and then runs the normal world step for that turn.
  private async fallStep(a: Action): Promise<{ ok: boolean; error?: string }> {
    if (a.type !== "fall") return { ok: false, error: "You are still falling." };
    const text = (a.text ?? "").trim();
    if (!text) return { ok: false, error: "Say what Niko does." };
    if (text.length > 500) return { ok: false, error: "That is too long. Keep it short." };
    const cost = this.abilityCost(this.opening.braceAbility);
    const niko = this.ents().find((e) => e.id === "niko")!;
    const log = this.fallLog();
    log.push(text);
    // A brace only lands if the Ether is there; a shortfall simply fails, it does not eat the turn.
    const intent = fallIntent(text);
    if (intent.brace && Number(niko.data.ether ?? 0) >= cost) {
      niko.data.ether -= cost;
      this.db.prepare("UPDATE entities SET data = ? WHERE id = 'niko'").run(JSON.stringify(niko.data));
      setMeta(this.db, "fall_brace", "1");
    }
    setMeta(this.db, "fall_log", JSON.stringify(log));
    const beat = this.fallBeat() + 1;
    setMeta(this.db, "fall_beat", String(beat));

    if (beat >= this.opening.beats.length) {
      const notable: string[] = [];
      this.land(log, notable);
      notable.push(...(await this.stepWorld()));
      await this.narrate(notable);
    } else {
      await this.narrate([`Niko: ${text}.`]);
    }
    return { ok: true };
  }

  // The landing is deterministic: candidates are filtered first, then rngFor(seed, 0, "landing")
  // picks one. `steer` restricts the candidates to the configured room.
  private land(choices: string[], notable: string[]): void {
    const z = this.zone;
    const impact: "soft" | "hard" = this.fallBrace() ? "soft" : "hard";
    const steer = choices.some((t) => fallIntent(t).steer);
    const ents = this.ents();
    const room = z.rooms.find((r) => r.id === this.opening.landing.steer_room);
    const inRoom = (x: number, y: number) =>
      !!room && x >= room.x && y >= room.y && x < room.x + room.w && y < room.y + room.h;
    const tiles: Point[] = [];
    for (let y = 0; y < z.height; y++) {
      for (let x = 0; x < z.width; x++) {
        if (steer && !inRoom(x, y)) continue;
        if (this.free(x, y, ents)) tiles.push({ x, y });
      }
    }
    if (!tiles.length) throw new Error("The opening has no free tile to land on");
    const rng = rngFor(this.seed(), 0, "landing");
    const tile = tiles[Math.floor(rng() * tiles.length)];
    const niko = ents.find((e) => e.id === "niko")!;
    this.moveTo(niko, tile.x, tile.y);
    setMeta(this.db, "phase", "play");
    if (impact === "hard") {
      niko.data.ether = 0;
      this.db.prepare("UPDATE entities SET data = ? WHERE id = 'niko'").run(JSON.stringify(niko.data));
    }
    setMeta(this.db, "visible", JSON.stringify(this.visibleActors(niko, ents).map((e) => e.id).sort()));
    this.record("arrives", tile.x, tile.y, "niko", { impact, choices }, true);
    this.pendingImpact = impact;
    notable.push(`Niko lands in ${roomAt(z, tile.x, tile.y)}.`);
  }

  // One world step: the tick, Ether regen, NPC agendas and the change in Niko's field of view. Used
  // by every action. It returns the notable lines and never narrates; the caller narrates once.
  private async stepWorld(): Promise<string[]> {
    const notable: string[] = [];
    const z = this.zone;
    const tick = this.tick() + 1;
    setMeta(this.db, "tick", String(tick));
    const ents = this.ents();
    const niko = ents.find((e) => e.id === "niko")!;
    const d = niko.data;
    d.ether = Math.min(d.ether_max, d.ether + d.ether_regen);
    this.db.prepare("UPDATE entities SET data = ? WHERE id = 'niko'").run(JSON.stringify(d));

    // NPCs pursue their agenda with the same movement rules as Niko; wander is only the fallback.
    // Only the NPCs in Niko's zone act: a character in another zone has no shared grid to path on.
    for (const npc of ents.filter((e) => e.type === "npc" && e.zone_id === z.id)) {
      const convo = this.conversationFor(npc.id);
      // Niko drives his own exchange; an NPC-to-NPC conversation is driven by the `npc` role below.
      if (convo && this.hasParticipant(convo, "niko")) continue;
      // The `npc` role may decide this actor's move; a null decision (offline, over budget, error)
      // falls through to the deterministic agenda, so behavior never depends on the model.
      if (await this.npcTurn(npc, ents, notable, convo)) continue;
      if (convo) continue; // an NPC conversation with no decision waits for this actor's turn
      const agenda = this.agendaOf(npc);
      if (agenda) {
        const row = this.ensureAgenda(npc, agenda);
        if (row.status === "active" || row.status === "blocked") {
          const goal = goalPoint(agenda, ents, z);
          if (goal && reached(agenda, npc, goal)) {
            this.setAgenda(npc.id, "arrived");
            if (canSee(z, niko, npc)) notable.push(`${npc.name} reaches Niko and waits to speak.`);
            continue;
          }
          if (goal) {
            const step = bfsStep(z, npc, goal, (x, y) => this.free(x, y, ents));
            if (step) {
              if (row.status !== "active") this.setAgenda(npc.id, "active");
              const dir = deltaDir(step.x - npc.x, step.y - npc.y);
              this.moveTo(npc, step.x, step.y);
              this.record("move", step.x, step.y, npc.id, { dir }, true);
              continue;
            }
          }
          // No route this tick: mark it and let the wander routine fill the turn. A blocked NPC
          // keeps retrying above, so a path that opens later is resumed instead of dead-ending.
          if (row.status === "active") this.setAgenda(npc.id, "blocked");
        }
        if (row.status === "arrived" || row.status === "done") continue;
      }
      const routine = npc.data.routine;
      if (routine?.type !== "wander") continue;
      const rng = rngFor(this.seed(), tick, npc.id);
      if (rng() >= (routine.prob ?? 0.4)) continue;
      const dir = (["N", "S", "E", "W"] as Dir[])[Math.floor(rng() * 4)];
      const nx = npc.x + DIR[dir][0], ny = npc.y + DIR[dir][1];
      if (!this.free(nx, ny, ents)) continue;
      this.moveTo(npc, nx, ny);
      this.record("move", nx, ny, npc.id, { dir }, true);
    }

    // Who enters or leaves Niko's field of view.
    const now = this.visibleActors(niko, ents).map((e) => e.id).sort();
    const before: string[] = JSON.parse(getMeta(this.db, "visible") ?? "[]");
    for (const id of now.filter((i) => !before.includes(i))) {
      const n = ents.find((e) => e.id === id)!;
      this.record("appears", n.x, n.y, n.id, {}, true);
      notable.push(`${n.name} enters Niko's field of view, ${this.where(niko, n)}.`);
    }
    setMeta(this.db, "visible", JSON.stringify(now));
    return notable;
  }

  // The `npc` role decides one actor's action. Returns true when the actor acted (a valid effect was
  // applied), false to let the deterministic agenda step run. Gated by visibility and by a cadence so
  // a turn can never multiply calls: one proposal per NPC per player turn, at most every N ticks.
  private async npcTurn(npc: Ent, ents: Ent[], notable: string[], convo: Conversation | undefined): Promise<boolean> {
    const decider = this.services.npcdecider;
    if (!decider) return false;
    // In an NPC conversation only the side whose turn it is may advance it, so one beat per tick.
    if (convo && !this.mayAdvance(convo, npc.id)) return false;
    if (this.npcProposed.has(npc.id)) return false;
    const tick = this.tick();
    const every = Math.max(1, this.rules.npcThinkEveryTicks);
    if (tick % every !== 0) return false;
    const niko = ents.find((e) => e.id === "niko")!;
    if (!canSee(this.zone, npc, niko)) return false;
    this.npcProposed.add(npc.id);
    let decision: NpcDecision | null = null;
    try {
      decision = await decider.decide(this.npcContext(npc, ents));
    } catch (e) {
      console.warn("The NPC decision failed, using the agenda:", (e as Error).message);
      return false;
    }
    if (!decision?.effects.length) return false;
    let applied = 0;
    for (const effect of decision.effects.slice(0, this.rules.maxEffects)) {
      const r = this.applyNpcEffect(npc, effect, ents);
      if (!r.ok) break; // a bad effect is dropped; earlier valid ones stand, the agenda does not also run
      applied++;
      notable.push(...r.notable);
    }
    return applied > 0;
  }

  private npcContext(npc: Ent, ents: Ent[]): NpcContext {
    const z = this.zone;
    const convo = this.conversationFor(npc.id);
    const partnerId = convo ? this.participants(convo).find((p) => p !== npc.id) : undefined;
    const partner = partnerId ? ents.find((e) => e.id === partnerId) : undefined;
    const agenda = this.agendaOf(npc);
    return {
      tick: this.tick(),
      actor: {
        id: npc.id, name: npc.name,
        personality: String(npc.data.personality ?? ""),
        voice: typeof npc.data.voice === "string" ? npc.data.voice : undefined,
      },
      agenda: agenda ? { goal_id: agenda.goal_id, kind: agenda.kind, want: agenda.want } : null,
      place: { id: z.id, name: z.name, room: roomAt(z, npc.x, npc.y) },
      visible: ents
        .filter((e) => e.zone_id === z.id && e.id !== npc.id && canSee(z, npc, e))
        .map((e) => ({
          id: e.id, name: e.name,
          proximity: proximityLabel(chebyshev(npc, e), this.stakes),
          direction: directionWord(npc, e),
        })),
      objects: z.objects.map((o) => ({ id: o.id, name: o.name })),
      ether: Number(npc.data.ether ?? 0),
      conversation: convo && partner
        ? { partner: partner.id, partner_name: partner.name, beat: convo.beat, maxBeats: this.stakes.maxBeats }
        : null,
      recentEvents: this.recentEventsFor(npc.id, ents),
      rules: this.rules,
    };
  }

  // What this actor witnessed, newest last, as compact lines for the prompt.
  private recentEventsFor(id: string, ents: Ent[]): string[] {
    const rows = this.db.prepare(
      `SELECT e.tick, e.type, e.actor_id, e.data FROM events e
       JOIN witnesses w ON w.event_id = e.id
       WHERE w.character_id = ? AND e.type != 'narration'
       ORDER BY e.id DESC LIMIT 5`,
    ).all(id) as { tick: number; type: string; actor_id: string | null; data: string }[];
    return rows.reverse().map((r) => {
      let target = "";
      try {
        const d = JSON.parse(r.data);
        target = d.target ?? d.to ?? d.id ?? d.dir ?? "";
      } catch { /* keep the line without a target */ }
      const who = r.actor_id ? (ents.find((e) => e.id === r.actor_id)?.name ?? r.actor_id) : "the world";
      return `t${r.tick}: ${who} ${r.type}${target ? ` ${target}` : ""}`;
    });
  }

  // Apply one effect proposed for an NPC through the same tile, path and witness checks as Niko, so no
  // actor gets a private shortcut. Niko-only operations (doors, the conversation lock) are absent.
  private applyNpcEffect(npc: Ent, e: Effect, ents: Ent[]): Applied {
    const z = this.zone;
    switch (e.kind) {
      case "move": {
        if (!e.path.length) return { ok: false, error: "That path is empty." };
        if (e.path.length > this.rules.maxPathSteps) return { ok: false, error: "That path is too long." };
        let p: Point = { x: npc.x, y: npc.y };
        for (const dir of e.path) {
          const d = DIR[dir];
          if (!d) return { ok: false, error: "Invalid direction." };
          const nx = p.x + d[0], ny = p.y + d[1];
          if (nx < 0 || ny < 0 || nx >= z.width || ny >= z.height) return { ok: false, error: "Out of the map." };
          if (z.map[ny][nx] === "D") return { ok: false, error: MSG_DOOR };
          if (!this.free(nx, ny, ents)) return { ok: false, error: "Something blocks the way." };
          p = { x: nx, y: ny };
        }
        for (const dir of e.path) {
          const d = DIR[dir];
          const nx = npc.x + d[0], ny = npc.y + d[1];
          this.moveTo(npc, nx, ny);
          this.record("move", nx, ny, npc.id, { dir }, true);
        }
        return { ok: true, notable: [] };
      }
      case "wait":
        this.record("wait", npc.x, npc.y, npc.id, {}, true);
        return { ok: true, notable: [] };
      case "speak":
        return this.applyNpcSpeak(npc, e, ents);
      case "end_conversation": {
        const convo = this.conversationFor(npc.id);
        if (!convo) return { ok: false, error: "There is no conversation to end." };
        const lines: string[] = [];
        this.closeConversation(convo, npc, lines);
        return { ok: true, notable: lines };
      }
      case "interact": {
        // NPCs only examine for now: an item verb is rejected so the `npc` role cannot move items.
        if (e.verb !== "examine") return { ok: false, error: "That is not something an NPC can do yet." };
        const o = z.objects.find((x) => x.id === e.target);
        if (!o || chebyshev(npc, o) > 1) return { ok: false, error: "That object is out of reach." };
        this.record("examine", npc.x, npc.y, npc.id, { target: o.id }, true);
        return { ok: true, notable: [`${npc.name} examines ${o.name}.`] };
      }
      case "ability": {
        const ability = this.rules.abilities[e.id];
        if (!ability) return { ok: false, error: "No such ability." };
        if (Number(npc.data.ether ?? 0) < ability.ether_cost) return { ok: false, error: "Not enough Ether." };
        npc.data.ether = Number(npc.data.ether ?? 0) - ability.ether_cost;
        this.db.prepare("UPDATE entities SET data = ? WHERE id = ?").run(JSON.stringify(npc.data), npc.id);
        const roll = rngFor(this.seed(), this.tick(), `risk:${npc.id}`)();
        this.record("ability", npc.x, npc.y, npc.id, { id: ability.id, target: e.target ?? null, roll }, true);
        return { ok: true, notable: [`${npc.name} uses ${ability.id}.`] };
      }
    }
  }

  private applyNpcSpeak(npc: Ent, e: { to: string | null; text: string }, ents: Ent[]): Applied {
    const z = this.zone;
    const text = e.text.trim();
    if (e.to === null) {
      if (!text) return { ok: false, error: "Nothing to say." };
      this.record("say", npc.x, npc.y, npc.id, { text }, true);
      return { ok: true, notable: [`${npc.name}: ${text}.`] };
    }
    const t = ents.find((x) => x.id === e.to && x.zone_id === z.id && x.id !== npc.id);
    if (!t || !near(npc, t)) return { ok: false, error: "There is no one to talk to there." };
    let convo = this.conversationFor(npc.id);
    if (convo && !this.hasParticipant(convo, t.id)) convo = undefined; // already busy with someone else
    if (convo) {
      const beat = convo.beat + 1;
      this.record("talk", npc.x, npc.y, npc.id, { target: t.id, beat, text }, true);
      if (beat >= this.stakes.maxBeats) {
        const lines: string[] = [];
        this.closeConversation(convo, npc, lines);
        return { ok: true, notable: lines };
      }
      this.db.prepare("UPDATE conversations SET beat = ? WHERE id = ?").run(beat, convo.id);
      return { ok: true, notable: [] };
    }
    // The opener is beat 0; the row starts at beat 1 so `mayAdvance` gives the listener the next turn.
    this.db.prepare(
      "INSERT INTO conversations (npc_id, goal_id, status, beat, started_tick, initiator_id, listener_id) VALUES (?, ?, 'open', 1, ?, ?, ?)",
    ).run(t.type === "npc" ? t.id : npc.id, this.agendaOf(npc)?.goal_id ?? "none", this.tick(), npc.id, t.id);
    this.record("talk", npc.x, npc.y, npc.id, { target: t.id, beat: 0, text }, true);
    return { ok: true, notable: [`${npc.name} talks to ${t.name}.`] };
  }

  // Insert the memories the memory role wrote, falling back to the deterministic template per
  // witness, so every witness always gets a memory and the table stays append-only.
  private async flushMemories(): Promise<void> {
    if (!this.pendingMemory.length) return;
    const events = this.pendingMemory;
    this.pendingMemory = [];
    let sentences: MemorySentence[] = [];
    if (this.services.memories) {
      const ents = this.ents();
      const niko = ents.find((e) => e.id === "niko")!;
      const ctx: MemoryWriteContext = {
        tick: this.tick(), zoneId: this.zone.id,
        presentCharacters: this.visibleActors(niko, ents).map((e) => e.id),
        summary: this.storySoFar(),
      };
      try {
        sentences = await this.services.memories.write(events, ctx);
      } catch (e) {
        console.warn("The memory call failed, using the template:", (e as Error).message);
        sentences = [];
      }
    }
    const byEvent = new Map<number, Map<string, MemorySentence>>();
    for (const s of sentences) {
      const m = byEvent.get(s.event_id) ?? new Map<string, MemorySentence>();
      m.set(s.character_id, s);
      byEvent.set(s.event_id, m);
    }
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO memories (character_id, event_id, tick, zone_id, text, importance, participants)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of events) {
      for (const w of e.witnesses) {
        const template = memoryFromEvent(e, w, this.memory);
        const custom = byEvent.get(e.id)?.get(w);
        ins.run(
          w, e.id, e.tick, e.zone_id,
          custom?.text ?? template.text, custom?.importance ?? template.importance,
          JSON.stringify(template.participants),
        );
      }
    }
  }

  // Every `summaryEveryTicks`, the memory role folds the events since the last summary into a new
  // rolling summary row. A failed call writes nothing; the previous summary keeps serving.
  private async maybeSummarize(): Promise<void> {
    const tick = this.tick();
    if (tick === 0 || tick % this.rules.summaryEveryTicks !== 0) return;
    const last = this.db.prepare("SELECT upto_tick FROM story_summary ORDER BY id DESC LIMIT 1").get() as
      { upto_tick: number } | undefined;
    const from = last?.upto_tick ?? 0;
    if (tick <= from) return;
    const rows = this.db.prepare(
      "SELECT tick, type, actor_id, data FROM events WHERE tick > ? AND tick <= ? AND type != 'narration' ORDER BY id",
    ).all(from, tick) as { tick: number; type: string; actor_id: string | null; data: string }[];
    if (!rows.length) return;
    const events = rows.map((r) => {
      const data = (() => { try { return JSON.parse(r.data); } catch { return {}; } })();
      const target = data.target ?? data.to ?? data.id ?? "";
      return `t${r.tick}: ${r.actor_id ?? "-"} ${r.type}${target ? ` ${target}` : ""}`;
    });
    const text = await this.services.memories?.summarize({ previous: this.storySoFar(), events, uptoTick: from, tick });
    if (text) this.db.prepare("INSERT INTO story_summary (upto_tick, text) VALUES (?, ?)").run(tick, text);
  }

  positions(): Record<string, [number, number]> {
    return Object.fromEntries(this.ents().map((e) => [e.id, [e.x, e.y] as [number, number]]));
  }

  // Read-only inspection for the debug tab: raw tables, recent events with their witnesses, the
  // seeded RNG state, the LLM spend by role and the rolling summary.
  debug() {
    const all = (sql: string) => this.db.prepare(sql).all() as any[];
    const parse = (s: string) => { try { return JSON.parse(s); } catch { return s; } };
    const ents = this.ents();
    const niko = ents.find((e) => e.id === "niko");
    return {
      tick: this.tick(),
      phase: this.phase(),
      seed: this.seed(),
      started: getMeta(this.db, "started") ?? null,
      niko: niko ? { x: niko.x, y: niko.y, ether: niko.data.ether, ether_max: niko.data.ether_max } : null,
      zone: { id: this.zone.id, name: this.zone.name, width: this.zone.width, height: this.zone.height },
      entities: ents.map((e) => ({ id: e.id, type: e.type, name: e.name, x: e.x, y: e.y, data: e.data })),
      positions: this.positions(),
      settings: all("SELECT key, value FROM settings ORDER BY key"),
      counts: this.db.prepare(
        `SELECT (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM memories) AS memories,
                (SELECT COUNT(*) FROM llm_calls) AS llm_calls, (SELECT COUNT(*) FROM conversations) AS conversations,
                (SELECT COUNT(*) FROM witnesses) AS witnesses, (SELECT COUNT(*) FROM facts_known) AS facts_known,
                (SELECT COUNT(*) FROM story_summary) AS story_summary`,
      ).get(),
      cost_by_role: all(
        `SELECT role, COUNT(*) AS calls, COALESCE(SUM(cost), 0) AS cost
         FROM llm_calls GROUP BY role ORDER BY role`,
      ),
      events: all(
        `SELECT e.id, e.tick, e.type, e.actor_id, e.x, e.y, e.data,
                (SELECT GROUP_CONCAT(w.character_id) FROM witnesses w WHERE w.event_id = e.id) AS witnesses
         FROM events e ORDER BY e.id DESC LIMIT 40`,
      ).map((r) => ({ ...r, data: parse(r.data), witnesses: r.witnesses ? String(r.witnesses).split(",") : [] })),
      memories: all("SELECT id, character_id, event_id, tick, text, importance FROM memories ORDER BY id DESC LIMIT 40"),
      story_summary: all("SELECT id, upto_tick, text FROM story_summary ORDER BY id DESC LIMIT 5"),
      llm_calls: all(
        `SELECT id, tick, role, model, tokens_input, tokens_output, cost, request, response
         FROM llm_calls ORDER BY id DESC LIMIT 10`,
      ),
    };
  }

  state() {
    const ents = this.ents();
    const niko = ents.find((e) => e.id === "niko")!;
    const z = this.zone;
    const tick = this.tick();
    const phase = this.phase();
    const beat = this.fallBeat();
    const narr = (
      this.db.prepare("SELECT tick, data FROM events WHERE type = 'narration' ORDER BY id DESC LIMIT 15").all() as
        { tick: number; data: string }[]
    ).reverse().map((r) => ({ tick: r.tick, ...JSON.parse(r.data) as { text: string; degraded?: boolean } }));
    const i = Math.min(beat, this.opening.beats.length - 1);
    const items = readItems(this.db);
    return {
      tick,
      phase,
      ...(phase === "fall"
        ? { fall: { altitude: this.opening.beats[i].altitude, beat, beats: this.opening.beats.length } }
        : {}),
      zone: {
        id: z.id, name: z.name, kind: z.kind, width: z.width, height: z.height,
        map: z.map, objects: z.objects, rooms: z.rooms,
        portals: (z.portals ?? []).map((p) => ({ x: p.x, y: p.y, label: p.label })),
      },
      zoneId: z.id,
      room: roomAt(z, niko.x, niko.y),
      niko: { x: niko.x, y: niko.y, ether: niko.data.ether, ether_max: niko.data.ether_max },
      npcs: this.visibleActors(niko, ents).map((e) => ({ id: e.id, name: e.name, x: e.x, y: e.y })),
      inventory: items.filter((i) => i.holder_id === niko.id).map((i) => ({ id: i.id, name: i.name })),
      items: items
        .filter((i) => !i.hidden && i.zone_id === z.id)
        .map((i) => ({ id: i.id, name: i.name, x: i.x!, y: i.y! })),
      // Only what Niko knows is sent: the facts behind an unmet goal never reach the client.
      scene: {
        question: this.scene.question,
        goal: this.scene.goal
          ? { id: this.scene.goal.id, text: this.sceneResolved() ? this.scene.goal.text : null }
          : null,
        known: this.knownFacts(),
        resolved: this.sceneResolved(),
      },
      log: narr.map((n) => ({ tick: n.tick, text: n.text, degraded: !!n.degraded })),
    };
  }
}
