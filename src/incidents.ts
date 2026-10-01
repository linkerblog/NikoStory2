import type { Db } from "./db.js";
import type { ProtocolStep } from "./government.js";

// Something the world may react to, and the queue of delayed consequences. The engine is the only
// caller: it decides when an incident is raised, who reports it and what a step puts on the grid.
export type IncidentStatus = "unreported" | "pending" | "reported";
export interface Incident {
  id: number; kind: string; zone_id: string; tick: number; tags: string[]; status: IncidentStatus;
  reported_tick: number | null;
  // Where the institution believes the subject is, as of `last_tick`. Responders go here.
  last_zone: string; last_tick: number;
  contacted: boolean;
}

export type ScheduledKind = "report" | "step" | "sighting";
export interface Scheduled { id: number; due_tick: number; kind: ScheduledKind; incident_id: number; payload: Record<string, any> }

// What the landing shows the world. A brace spends Ether, and that discharge is what instruments catch.
export function incidentTags(braced: boolean): string[] {
  return braced ? ["sky_fall", "ether"] : ["sky_fall"];
}

// Evaluated when a step fires, not when it is queued: contact and tags change while the step waits.
export function stepIsDue(step: ProtocolStep, incident: Incident): boolean {
  if (step.when === "contacted" && !incident.contacted) return false;
  if (step.when === "uncontacted" && incident.contacted) return false;
  return step.requires.every((t) => incident.tags.includes(t));
}

const toIncident = (r: any): Incident => ({
  id: r.id, kind: r.kind, zone_id: r.zone_id, tick: r.tick, tags: JSON.parse(r.tags), status: r.status,
  reported_tick: r.reported_tick, last_zone: r.last_zone, last_tick: r.last_tick, contacted: r.contacted === 1,
});

export class IncidentStore {
  constructor(private db: Db) {}

  create(kind: string, zoneId: string, tick: number, tags: string[], status: IncidentStatus): Incident {
    const id = Number(
      this.db.prepare(
        `INSERT INTO incidents (kind, zone_id, tick, tags, status, last_zone, last_tick) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(kind, zoneId, tick, JSON.stringify(tags), status, zoneId, tick).lastInsertRowid,
    );
    return this.get(id)!;
  }

  get(id: number): Incident | undefined {
    const r = this.db.prepare("SELECT * FROM incidents WHERE id = ?").get(id);
    return r ? toIncident(r) : undefined;
  }

  all(): Incident[] {
    return (this.db.prepare("SELECT * FROM incidents ORDER BY id").all() as any[]).map(toIncident);
  }

  reported(): Incident[] {
    return this.all().filter((i) => i.status === "reported");
  }

  markReported(id: number, tick: number): void {
    this.db.prepare("UPDATE incidents SET status = 'reported', reported_tick = ? WHERE id = ?").run(tick, id);
  }

  setLast(id: number, zoneId: string, tick: number): void {
    this.db.prepare("UPDATE incidents SET last_zone = ?, last_tick = ? WHERE id = ?").run(zoneId, tick, id);
  }

  // The first word with a responder: they ask for papers and Niko has none.
  contact(id: number): void {
    const inc = this.get(id);
    if (!inc || inc.contacted) return;
    const tags = inc.tags.includes("unregistered") ? inc.tags : [...inc.tags, "unregistered"];
    this.db.prepare("UPDATE incidents SET contacted = 1, tags = ? WHERE id = ?").run(JSON.stringify(tags), id);
  }

  schedule(due: number, kind: ScheduledKind, incidentId: number, payload: object = {}): void {
    this.db.prepare("INSERT INTO scheduled_events (due_tick, kind, incident_id, payload) VALUES (?, ?, ?, ?)")
      .run(due, kind, incidentId, JSON.stringify(payload));
  }

  // The order is part of the replay: by due tick, then by the order they were queued.
  due(tick: number): Scheduled[] {
    return (this.db.prepare(
      "SELECT * FROM scheduled_events WHERE status = 'pending' AND due_tick <= ? ORDER BY due_tick, id",
    ).all(tick) as any[]).map((r) => ({
      id: r.id, due_tick: r.due_tick, kind: r.kind, incident_id: r.incident_id, payload: JSON.parse(r.payload),
    }));
  }

  hasPending(kind: ScheduledKind, incidentId: number, zoneId: string): boolean {
    return !!this.db.prepare(
      `SELECT 1 FROM scheduled_events
       WHERE status = 'pending' AND kind = ? AND incident_id = ? AND json_extract(payload, '$.zone') = ? LIMIT 1`,
    ).get(kind, incidentId, zoneId);
  }

  settle(id: number, status: "done" | "skipped"): void {
    this.db.prepare("UPDATE scheduled_events SET status = ? WHERE id = ?").run(status, id);
  }

  pending(): Scheduled[] {
    return (this.db.prepare("SELECT * FROM scheduled_events WHERE status = 'pending' ORDER BY due_tick, id").all() as any[])
      .map((r) => ({ id: r.id, due_tick: r.due_tick, kind: r.kind, incident_id: r.incident_id, payload: JSON.parse(r.payload) }));
  }
}
