import type { Ent, Zone } from "./world.js";

export type AgendaKind = "approach" | "follow" | "visit";

// An NPC's purpose, authored in `data/npcs.json`. Agendas are data so goals can change without code.
export interface Agenda {
  goal_id: string;
  kind: AgendaKind;
  target: string;
  want: string;
  reveals?: string;
}

export interface Point { x: number; y: number }

// Fixed neighbour order (N, S, E, W): the same state always yields the same path, so the agenda step
// needs no RNG and replays exactly.
const DELTAS: [number, number][] = [[0, -1], [0, 1], [1, 0], [-1, 0]];

export function deltaDir(dx: number, dy: number): "N" | "S" | "E" | "W" {
  if (dy < 0) return "N";
  if (dy > 0) return "S";
  return dx > 0 ? "E" : "W";
}

// Breadth-first search over walkable tiles. The goal tile may be occupied (the target stands there):
// it is entered as a terminal only. Returns the first step of a shortest path, or null if none.
export function bfsStep(
  zone: Zone,
  from: Point,
  goal: Point,
  canEnter: (x: number, y: number) => boolean,
): Point | null {
  if (from.x === goal.x && from.y === goal.y) return null;
  const key = (x: number, y: number) => y * zone.width + x;
  const seen = new Set<number>([key(from.x, from.y)]);
  const queue: { x: number; y: number; first: Point | null }[] = [{ x: from.x, y: from.y, first: null }];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const [dx, dy] of DELTAS) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= zone.width || ny >= zone.height) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      const isGoal = nx === goal.x && ny === goal.y;
      if (!isGoal && !canEnter(nx, ny)) continue;
      const first = cur.first ?? { x: nx, y: ny };
      if (isGoal) return first;
      seen.add(k);
      queue.push({ x: nx, y: ny, first });
    }
  }
  return null;
}

export function goalPoint(agenda: Agenda, ents: Ent[], zone: Zone): Point | null {
  if (agenda.kind === "visit") {
    const o = zone.objects.find((x) => x.id === agenda.target);
    return o ? { x: o.x, y: o.y } : null;
  }
  const t = ents.find((e) => e.id === agenda.target);
  return t ? { x: t.x, y: t.y } : null;
}

// approach and visit stop next to the goal; follow is satisfied within two tiles.
export function reached(agenda: Agenda, npc: Point, goal: Point): boolean {
  const d = Math.max(Math.abs(npc.x - goal.x), Math.abs(npc.y - goal.y));
  return d <= (agenda.kind === "follow" ? 2 : 1);
}
