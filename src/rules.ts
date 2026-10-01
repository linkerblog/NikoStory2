import { readFileSync } from "node:fs";
import { DEFAULT_COMBAT, parseCombat, type CombatRules } from "./combat.js";

// The hard rules of the game world, authored in `data/rules.json`. The interpreter reads them
// verbatim so the model can only propose what the engine already knows how to resolve, and the
// engine reads the same numbers (effect limits, ability costs) when it validates a turn.
export interface Ability {
  id: string;
  ether_cost: number;
  range: number;
  description: string;
  // Ticks during which the user's incoming blows are reduced (`combat.guardFactor`). Absent for
  // abilities that do not guard.
  guard_ticks?: number;
}

// Bounds on a government draft written by the `government` role; the engine rejects anything outside them.
export interface GovernmentLimits {
  maxInstitutions: number;
  maxSteps: number;
  maxUnits: number;
  minAfter: number;
  maxAfter: number;
  maxText: number;
}

// How an incident turns into a report. `ambient` is the number of unnamed bystanders by zone kind, each
// one a chance that somebody calls it in; the named witnesses of the event count on top. Provisional.
export interface IncidentRules {
  reportChance: number;
  reportDelay: [number, number];
  ambient: Record<string, number>;
  government: GovernmentLimits;
}

export const DEFAULT_INCIDENTS: IncidentRules = {
  reportChance: 0.6,
  reportDelay: [4, 10],
  ambient: { house: 2, outdoor: 6, building: 1 },
  government: { maxInstitutions: 5, maxSteps: 6, maxUnits: 2, minAfter: 1, maxAfter: 300, maxText: 160 },
};

export interface GameRules {
  abilities: Record<string, Ability>;
  combat: CombatRules;
  maxEffects: number;
  maxPathSteps: number;
  summaryEveryTicks: number;
  // How often an NPC may ask the model for a decision: one proposal every N ticks, at most one per
  // player turn. Provisional; a value of 1 asks on every tick an NPC can see Niko.
  npcThinkEveryTicks: number;
  // How many items Niko can hold at once. Provisional.
  inventorySlots: number;
  incidents: IncidentRules;
  limits: string[];
  risk: string;
}

export const DEFAULT_RULES: GameRules = {
  abilities: {
    brace: { id: "brace", ether_cost: 2, range: 0, description: "Cushion an impact by spending Ether.", guard_ticks: 2 },
  },
  combat: DEFAULT_COMBAT,
  maxEffects: 4,
  maxPathSteps: 6,
  summaryEveryTicks: 20,
  npcThinkEveryTicks: 3,
  inventorySlots: 8,
  incidents: DEFAULT_INCIDENTS,
  limits: [],
  risk: "",
};

const positiveInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0;
const nonNegativeInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;

function parseIncidents(raw: any): IncidentRules {
  if (raw === undefined) return DEFAULT_INCIDENTS;
  const bad = (what: string) => new Error(`rules.json incidents ${what}`);
  if (!(typeof raw?.reportChance === "number" && raw.reportChance >= 0 && raw.reportChance <= 1)) {
    throw bad("reportChance must be between 0 and 1");
  }
  const d = raw.reportDelay;
  if (!Array.isArray(d) || d.length !== 2 || !positiveInt(d[0]) || !positiveInt(d[1]) || d[0] > d[1]) {
    throw bad("reportDelay must be [min, max] positive integers");
  }
  const ambient = raw.ambient;
  if (!ambient || typeof ambient !== "object" || Object.values(ambient).some((n) => !nonNegativeInt(n))) {
    throw bad("ambient must map zone kinds to non-negative integers");
  }
  const g = raw.government;
  for (const k of ["maxInstitutions", "maxSteps", "maxUnits", "minAfter", "maxAfter", "maxText"] as const) {
    if (!positiveInt(g?.[k])) throw bad(`government.${k} must be a positive integer`);
  }
  if (g.minAfter > g.maxAfter) throw bad("government.minAfter cannot exceed maxAfter");
  return {
    reportChance: raw.reportChance,
    reportDelay: [d[0], d[1]],
    ambient,
    government: {
      maxInstitutions: g.maxInstitutions, maxSteps: g.maxSteps, maxUnits: g.maxUnits,
      minAfter: g.minAfter, maxAfter: g.maxAfter, maxText: g.maxText,
    },
  };
}

// A malformed rules file is rejected, not trusted: the engine and the interpreter both depend on it.
export function loadRules(dataDir: string): GameRules {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(`${dataDir}/rules.json`, "utf-8"));
  } catch {
    return DEFAULT_RULES;
  }
  const list = raw?.abilities;
  if (!Array.isArray(list)) throw new Error("rules.json needs an abilities list");
  const abilities: Record<string, Ability> = {};
  for (const a of list as any[]) {
    if (typeof a?.id !== "string" || !a.id) throw new Error("rules.json ability needs a non-empty id");
    if (!nonNegativeInt(a.ether_cost)) throw new Error(`rules.json ability ${a.id} needs a non-negative ether_cost`);
    if (!nonNegativeInt(a.range)) throw new Error(`rules.json ability ${a.id} needs a non-negative range`);
    if (a.guard_ticks !== undefined && !positiveInt(a.guard_ticks)) {
      throw new Error(`rules.json ability ${a.id} needs a positive integer guard_ticks`);
    }
    abilities[a.id] = {
      id: a.id, ether_cost: a.ether_cost, range: a.range,
      description: typeof a.description === "string" ? a.description : "",
      ...(a.guard_ticks !== undefined ? { guard_ticks: a.guard_ticks } : {}),
    };
  }
  if (!positiveInt(raw.maxEffects)) throw new Error("rules.json maxEffects must be a positive integer");
  if (!positiveInt(raw.maxPathSteps)) throw new Error("rules.json maxPathSteps must be a positive integer");
  if (!positiveInt(raw.summaryEveryTicks)) throw new Error("rules.json summaryEveryTicks must be a positive integer");
  if (raw.npcThinkEveryTicks !== undefined && !positiveInt(raw.npcThinkEveryTicks)) {
    throw new Error("rules.json npcThinkEveryTicks must be a positive integer");
  }
  if (raw.inventorySlots !== undefined && !positiveInt(raw.inventorySlots)) {
    throw new Error("rules.json inventorySlots must be a positive integer");
  }
  if (!Array.isArray(raw.limits) || raw.limits.some((l: unknown) => typeof l !== "string")) {
    throw new Error("rules.json limits must be a list of strings");
  }
  if (typeof raw.risk !== "string") throw new Error("rules.json risk must be a string");
  return {
    abilities,
    combat: parseCombat(raw.combat),
    maxEffects: raw.maxEffects,
    maxPathSteps: raw.maxPathSteps,
    summaryEveryTicks: raw.summaryEveryTicks,
    npcThinkEveryTicks: raw.npcThinkEveryTicks ?? DEFAULT_RULES.npcThinkEveryTicks,
    inventorySlots: raw.inventorySlots ?? DEFAULT_RULES.inventorySlots,
    incidents: parseIncidents(raw.incidents),
    limits: raw.limits,
    risk: raw.risk,
  };
}
