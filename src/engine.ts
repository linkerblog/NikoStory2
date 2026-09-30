import { getMeta, setMeta, type Db } from "./db.js";
import { rngFor } from "./rng.js";
import { roomAt, type Ent, type Zone } from "./world.js";
import type { Narrator, Option } from "./narrator.js";
import { memoryFromEvent, type MemoryEvent, type MemoryRules, DEFAULT_MEMORY_RULES } from "./memory.js";
import { bfsStep, deltaDir, goalPoint, reached, type Agenda } from "./agenda.js";
import { DEFAULT_STAKES_RULES, chebyshev, directionWord, proximityLabel, type Scene, type StakesRules } from "./stakes.js";

export type Dir = "N" | "S" | "E" | "W";
export type ReplyChoice = "ask" | "reassure" | "press";
export type Action =
  | { type: "move"; dir: Dir }
  | { type: "wait" }
  | { type: "talk"; target: string }
  | { type: "reply"; target: string; choice: ReplyChoice }
  | { type: "leave"; target: string }
  | { type: "examine"; target: string };
export interface AvailableAction { id: string; label: string; action: Action }

interface Conversation {
  id: number; npc_id: string; goal_id: string; status: string; beat: number; started_tick: number;
}

const DIR: Record<Dir, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
const DIR_WORD: Record<Dir, string> = { N: "north", S: "south", E: "east", W: "west" };
export const VISION_RANGE = 8;
const MSG_DOOR = "The door leads to a zone that does not exist yet (zone generation will go here).";

type Point = { x: number; y: number };

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
  constructor(
    private db: Db,
    readonly zone: Zone,
    private narrator: Narrator,
    private rules: MemoryRules = DEFAULT_MEMORY_RULES,
    private stakes: StakesRules = DEFAULT_STAKES_RULES,
    private scene: Scene = { question: "", facts: [] },
  ) {}

  private tick(): number { return Number(getMeta(this.db, "tick")); }
  private seed(): number { return Number(getMeta(this.db, "seed")); }

  private ents(): Ent[] {
    return (this.db.prepare("SELECT * FROM entities ORDER BY rowid").all() as any[]).map((r) => ({
      id: r.id, type: r.type, name: r.name, x: r.x, y: r.y, data: JSON.parse(r.data),
    }));
  }

  private free(x: number, y: number, ents: Ent[]): boolean {
    const z = this.zone;
    return x >= 0 && y >= 0 && x < z.width && y < z.height && z.map[y][x] === "." &&
      !z.objects.some((o) => o.blocks && o.x === x && o.y === y) &&
      !ents.some((e) => e.x === x && e.y === y);
  }

  private moveTo(e: Ent, x: number, y: number) {
    e.x = x; e.y = y;
    this.db.prepare("UPDATE entities SET x = ?, y = ? WHERE id = ?").run(x, y, e.id);
  }

  // The event is born with its witnesses: only those who could see it "know" it. The event, its
  // witnesses and one memory per witness commit together, so a memory can never outlive its event.
  private record(type: string, x: number, y: number, actor: string | null, data: object, withWitnesses: boolean): void {
    const tick = this.tick();
    const ents = this.ents();
    const names: Record<string, string> = {};
    for (const e of ents) names[e.id] = e.name;
    for (const o of this.zone.objects) names[o.id] = o.name;
    const witnesses = withWitnesses
      ? ents.filter((e) => canSee(this.zone, e, { x, y })).map((e) => e.id)
      : [];
    const base: Omit<MemoryEvent, "id"> = { tick, zone_id: this.zone.id, type, actor_id: actor, x, y, data, names, witnesses };
    this.db.transaction(() => {
      const id = Number(
        this.db.prepare("INSERT INTO events (tick, zone_id, type, actor_id, x, y, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(tick, this.zone.id, type, actor, x, y, JSON.stringify(data)).lastInsertRowid,
      );
      const insWitness = this.db.prepare("INSERT INTO witnesses (event_id, character_id) VALUES (?, ?)");
      for (const w of witnesses) insWitness.run(id, w);
      const insMemory = this.db.prepare(
        `INSERT OR IGNORE INTO memories (character_id, event_id, tick, zone_id, text, importance, participants)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const w of witnesses) {
        const m = memoryFromEvent({ ...base, id }, w, this.rules);
        insMemory.run(m.character_id, m.event_id, m.tick, m.zone_id, m.text, m.importance, JSON.stringify(m.participants));
      }
    })();
  }

  private conversation(): Conversation | undefined {
    return this.db
      .prepare("SELECT * FROM conversations WHERE status = 'open' ORDER BY id DESC LIMIT 1")
      .get() as Conversation | undefined;
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

  private closeConversation(convo: Conversation, npc: Ent, niko: Ent, notable: string[]): void {
    this.db.prepare("UPDATE conversations SET status = 'closed' WHERE id = ?").run(convo.id);
    const agenda = this.agendaOf(npc);
    const goalId = agenda?.goal_id ?? convo.goal_id;
    if (agenda) {
      this.ensureAgenda(npc, agenda);
      if (this.agendaRow(npc.id)?.status !== "done") this.setAgenda(npc.id, "done");
      if (agenda.reveals) {
        // Idempotent: the primary key keeps a fact known exactly once per character.
        this.db.prepare("INSERT OR IGNORE INTO facts_known (character_id, fact_id, tick) VALUES ('niko', ?, ?)")
          .run(agenda.reveals, this.tick());
      }
    }
    this.record("talked", niko.x, niko.y, "niko", { target: npc.id, goal_id: goalId, fact_id: agenda?.reveals ?? null }, true);
    notable.push(`Niko stops talking with ${npc.name}.`);
  }

  private availableActions(niko: Ent, ents: Ent[]): AvailableAction[] {
    const acc: AvailableAction[] = [];
    const convo = this.conversation();
    if (convo) {
      const npc = ents.find((e) => e.id === convo.npc_id && e.type === "npc");
      if (npc && near(niko, npc)) {
        acc.push({ id: `reply:${npc.id}:ask`, label: `Ask ${npc.name} a question`, action: { type: "reply", target: npc.id, choice: "ask" } });
        acc.push({ id: `reply:${npc.id}:reassure`, label: `Reassure ${npc.name}`, action: { type: "reply", target: npc.id, choice: "reassure" } });
        acc.push({ id: `reply:${npc.id}:press`, label: `Press ${npc.name} for details`, action: { type: "reply", target: npc.id, choice: "press" } });
        acc.push({ id: `leave:${npc.id}`, label: `Leave the conversation`, action: { type: "leave", target: npc.id } });
        return acc;
      }
    }
    for (const e of ents) {
      if (e.type === "npc" && near(niko, e)) {
        acc.push({ id: `talk:${e.id}`, label: `Talk to ${e.name}`, action: { type: "talk", target: e.id } });
      }
    }
    for (const o of this.zone.objects) {
      if (near(niko, o)) {
        acc.push({ id: `examine:${o.id}`, label: `Examine ${o.name}`, action: { type: "examine", target: o.id } });
      }
    }
    acc.push({ id: "wait", label: "Wait", action: { type: "wait" } });
    return acc;
  }

  private visibleActors(niko: Ent, ents: Ent[]): Ent[] {
    return ents.filter((e) => e.type === "npc" && canSee(this.zone, niko, e));
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

  private knownFacts(): string[] {
    const ids = (this.db.prepare("SELECT fact_id FROM facts_known WHERE character_id = 'niko'").all() as
      { fact_id: string }[]).map((r) => r.fact_id);
    return this.scene.facts.filter((f) => ids.includes(f.id)).map((f) => f.text);
  }

  private async narrate(events: string[]): Promise<void> {
    const ents = this.ents();
    const niko = ents.find((e) => e.id === "niko")!;
    const actions = this.availableActions(niko, ents);
    const visible = this.visibleActors(niko, ents);
    const convo = this.conversation();
    const convoNpc = convo ? ents.find((e) => e.id === convo.npc_id) : undefined;
    const n = await this.narrator.narrate({
      tick: this.tick(),
      sheet: { name: niko.name, ...niko.data },
      place: { name: this.zone.name, description: this.zone.description, room: roomAt(this.zone, niko.x, niko.y) },
      visible: visible.map((e) => ({
        name: e.name,
        proximity: proximityLabel(chebyshev(niko, e), this.stakes),
        direction: directionWord(niko, e),
        personality: String(e.data.personality ?? ""),
      })),
      events,
      actions: actions.map((a) => ({ id: a.id, label: a.label })),
      lastMove: this.lastMove(),
      recentNarrations: this.recentNarrations(this.stakes.promptNarrations),
      scene: { question: this.scene.question, knownFacts: this.knownFacts() },
      conversation: convo && convoNpc
        ? { npc: convoNpc.name, beat: convo.beat, maxBeats: this.stakes.maxBeats, want: this.agendaOf(convoNpc)?.want ?? "" }
        : null,
      memory: {
        characterId: niko.id, tick: this.tick(), zoneId: this.zone.id,
        presentCharacters: visible.map((e) => e.id),
      },
    });
    // The LLM proposes; the engine decides: only options that are real actions survive.
    let valid = n.options.filter((o) => actions.some((a) => a.id === o.id)).slice(0, 3);
    // A waiting NPC must always be reachable: if the narrator forgot `talk`, the engine offers it.
    if (!convo) {
      const talk = actions.find((a) => a.id.startsWith("talk:"));
      const waiting = ents.some((e) => e.type === "npc" && near(niko, e) && this.agendaRow(e.id)?.status === "arrived");
      if (talk && waiting && !valid.some((o) => o.id === talk.id)) {
        valid = valid.length >= 3
          ? [...valid.slice(0, 2), { id: talk.id, text: talk.label }]
          : [...valid, { id: talk.id, text: talk.label }];
      }
    }
    const replies = actions.filter((a) => a.id.startsWith("reply:"));
    const leave = actions.find((a) => a.id.startsWith("leave:"));
    const options = valid.length
      ? valid
      : convo && replies.length && leave
        ? [replies[0], replies[2] ?? replies[1], leave].map((a) => ({ id: a.id, text: a.label }))
        : actions.slice(0, 3).map((a) => ({ id: a.id, text: a.label }));
    this.record("narration", niko.x, niko.y, null, { text: n.text, options }, false);
  }

  async start(): Promise<void> {
    if (getMeta(this.db, "started")) return;
    const ents = this.ents();
    const niko = ents.find((e) => e.id === "niko")!;
    const vis = this.visibleActors(niko, ents);
    setMeta(this.db, "visible", JSON.stringify(vis.map((e) => e.id).sort()));
    const events = ["Niko wakes up in a bedroom he does not know. The house is silent."];
    for (const e of vis) events.push(`${e.name} is in the room, ${this.where(niko, e)}.`);
    await this.narrate(events);
    setMeta(this.db, "started", "1");
  }

  async takeTurn(a: Action): Promise<{ ok: boolean; error?: string }> {
    const z = this.zone;
    const ents = this.ents();
    const niko = ents.find((e) => e.id === "niko")!;
    const notable: string[] = [];
    const convo = this.conversation();

    // While a conversation is open, the only ways forward are answering it or leaving it.
    if (convo && a.type !== "reply" && a.type !== "leave" && !(a.type === "talk" && a.target === convo.npc_id)) {
      return { ok: false, error: "Finish the conversation first." };
    }

    switch (a.type) {
      case "move": {
        const d = DIR[a.dir];
        if (!d) return { ok: false, error: "Invalid direction." };
        const nx = niko.x + d[0], ny = niko.y + d[1];
        if (nx < 0 || ny < 0 || nx >= z.width || ny >= z.height) return { ok: false, error: "Out of the map." };
        if (z.map[ny][nx] === "D") return { ok: false, error: MSG_DOOR };
        if (!this.free(nx, ny, ents)) return { ok: false, error: "Something blocks the way." };
        this.moveTo(niko, nx, ny);
        this.record("move", nx, ny, "niko", { dir: a.dir }, true);
        break;
      }
      case "wait":
        this.record("wait", niko.x, niko.y, "niko", {}, true);
        break;
      case "talk": {
        const t = ents.find((e) => e.id === a.target && e.type === "npc");
        if (!t || !near(niko, t)) return { ok: false, error: "There is no one to talk to there." };
        if (convo) {
          const beat = convo.beat + 1;
          this.record("talk", niko.x, niko.y, "niko", { target: t.id, beat, choice: "ask" }, true);
          if (beat >= this.stakes.maxBeats) this.closeConversation(convo, t, niko, notable);
          else this.db.prepare("UPDATE conversations SET beat = ? WHERE id = ?").run(beat, convo.id);
          break;
        }
        const agenda = this.agendaOf(t);
        this.db.prepare("INSERT INTO conversations (npc_id, goal_id, status, beat, started_tick) VALUES (?, ?, 'open', 0, ?)")
          .run(t.id, agenda?.goal_id ?? "none", this.tick());
        this.record("talk", niko.x, niko.y, "niko", { target: t.id, beat: 0 }, true);
        notable.push(`Niko talks to ${t.name}.`);
        break;
      }
      case "reply": {
        const t = ents.find((e) => e.id === a.target && e.type === "npc");
        if (!convo || !t || convo.npc_id !== t.id) return { ok: false, error: "There is no conversation to answer." };
        if (!near(niko, t)) return { ok: false, error: "That conversation is out of reach." };
        const beat = convo.beat + 1;
        this.record("talk", niko.x, niko.y, "niko", { target: t.id, beat, choice: a.choice }, true);
        if (beat >= this.stakes.maxBeats) this.closeConversation(convo, t, niko, notable);
        else this.db.prepare("UPDATE conversations SET beat = ? WHERE id = ?").run(beat, convo.id);
        break;
      }
      case "leave": {
        const t = ents.find((e) => e.id === a.target && e.type === "npc");
        if (!convo || !t || convo.npc_id !== t.id) return { ok: false, error: "There is no conversation to leave." };
        this.closeConversation(convo, t, niko, notable);
        break;
      }
      case "examine": {
        const o = z.objects.find((x) => x.id === a.target);
        if (!o || !near(niko, o)) return { ok: false, error: "You cannot reach that object." };
        this.record("examine", niko.x, niko.y, "niko", { target: o.id }, true);
        notable.push(`Niko examines ${o.name}.`);
        break;
      }
      default:
        return { ok: false, error: "Unknown action." };
    }

    // The world advances one tick.
    const tick = this.tick() + 1;
    setMeta(this.db, "tick", String(tick));
    const d = niko.data;
    d.ether = Math.min(d.ether_max, d.ether + d.ether_regen);
    this.db.prepare("UPDATE entities SET data = ? WHERE id = 'niko'").run(JSON.stringify(d));

    // NPCs pursue their agenda with the same movement rules as Niko; wander is only the fallback.
    for (const npc of ents.filter((e) => e.type === "npc")) {
      if (this.conversation()?.npc_id === npc.id) continue;
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

    if (notable.length) await this.narrate(notable);
    return { ok: true };
  }

  positions(): Record<string, [number, number]> {
    return Object.fromEntries(this.ents().map((e) => [e.id, [e.x, e.y] as [number, number]]));
  }

  state() {
    const ents = this.ents();
    const niko = ents.find((e) => e.id === "niko")!;
    const tick = this.tick();
    const actions = this.availableActions(niko, ents);
    const narr = (
      this.db.prepare("SELECT tick, data FROM events WHERE type = 'narration' ORDER BY id DESC LIMIT 15").all() as
        { tick: number; data: string }[]
    ).reverse().map((r) => ({ tick: r.tick, ...JSON.parse(r.data) as { text: string; options: Option[] } }));
    const last = narr.at(-1);
    const byId = new Map(actions.map((a) => [a.id, a]));
    let options = actions.slice(0, 3).map((a) => ({ text: a.label, action: a.action }));
    if (last && last.tick === tick) {
      const o = last.options.filter((x) => byId.has(x.id)).map((x) => ({ text: x.text, action: byId.get(x.id)!.action }));
      if (o.length) options = o;
    }
    return {
      tick,
      zone: { id: this.zone.id, name: this.zone.name, width: this.zone.width, height: this.zone.height,
        map: this.zone.map, objects: this.zone.objects, rooms: this.zone.rooms },
      room: roomAt(this.zone, niko.x, niko.y),
      niko: { x: niko.x, y: niko.y, ether: niko.data.ether, ether_max: niko.data.ether_max },
      npcs: this.visibleActors(niko, ents).map((e) => ({ id: e.id, name: e.name, x: e.x, y: e.y })),
      log: narr.map((n) => ({ tick: n.tick, text: n.text })),
      options,
    };
  }
}
