import { readFileSync } from "node:fs";
import type { Point } from "./agenda.js";

export interface SceneFact { id: string; text: string; revealed_by: string }
// The scene's answer: resolved once, when Niko knows every required fact. A scene with no goal
// never resolves, so a data file without one behaves as before.
export interface SceneGoal { id: string; text: string; requires: string[] }
export interface Scene { question: string; facts: SceneFact[]; goal?: SceneGoal }

// Provisional values, tunable in data without a code change.
export interface StakesRules {
  maxBeats: number;
  proximity: { adjacent: number; near: number };
  overlapThreshold: number;
  promptNarrations: number;
}

export const DEFAULT_STAKES_RULES: StakesRules = {
  maxBeats: 4,
  proximity: { adjacent: 1, near: 3 },
  overlapThreshold: 0.6,
  promptNarrations: 3,
};

const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf-8")) as T;

export function loadStakesRules(dataDir: string): StakesRules {
  const raw = read<Partial<StakesRules>>(`${dataDir}/stakes_rules.json`);
  return {
    ...DEFAULT_STAKES_RULES,
    ...raw,
    proximity: { ...DEFAULT_STAKES_RULES.proximity, ...(raw.proximity ?? {}) },
  };
}

export function loadScene(dataDir: string): Scene {
  const scene = read<Scene>(`${dataDir}/scene.json`);
  const facts = scene.facts ?? [];
  const goal = scene.goal;
  if (goal === undefined) return { question: scene.question ?? "", facts };
  if (typeof goal?.id !== "string" || !goal.id) throw new Error("scene.json goal needs an id");
  if (typeof goal.text !== "string") throw new Error("scene.json goal needs a text");
  if (!Array.isArray(goal.requires) || goal.requires.length === 0) throw new Error("scene.json goal needs a requires list");
  const known = new Set(facts.map((f) => f.id));
  for (const id of goal.requires) {
    if (!known.has(id)) throw new Error(`scene.json goal requires unknown fact ${id}`);
  }
  return { question: scene.question ?? "", facts, goal: { id: goal.id, text: goal.text, requires: goal.requires } };
}

export const chebyshev = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export type Proximity = "adjacent" | "near" | "far";

// Numbers never reach the narrator: a distance becomes a label and a direction word.
export function proximityLabel(distance: number, rules: StakesRules): Proximity {
  if (distance <= rules.proximity.adjacent) return "adjacent";
  if (distance <= rules.proximity.near) return "near";
  return "far";
}

export function directionWord(from: Point, to: Point): string {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (Math.abs(dx) === Math.abs(dy) && dx === 0) return "";
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "east" : "west") : dy > 0 ? "south" : "north";
}
