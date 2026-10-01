import { readFileSync } from "node:fs";

// The hard rules of the game world, authored in `data/rules.json`. The interpreter reads them
// verbatim so the model can only propose what the engine already knows how to resolve, and the
// engine reads the same numbers (effect limits, ability costs) when it validates a turn.
export interface Ability {
  id: string;
  ether_cost: number;
  range: number;
  description: string;
}

export interface GameRules {
  abilities: Record<string, Ability>;
  maxEffects: number;
  maxPathSteps: number;
  summaryEveryTicks: number;
  // How often an NPC may ask the model for a decision: one proposal every N ticks, at most one per
  // player turn. Provisional; a value of 1 asks on every tick an NPC can see Niko.
  npcThinkEveryTicks: number;
  // How many items Niko can hold at once. Provisional.
  inventorySlots: number;
  limits: string[];
  risk: string;
}

export const DEFAULT_RULES: GameRules = {
  abilities: {
    brace: { id: "brace", ether_cost: 2, range: 0, description: "Cushion an impact by spending Ether." },
  },
  maxEffects: 4,
  maxPathSteps: 6,
  summaryEveryTicks: 20,
  npcThinkEveryTicks: 3,
  inventorySlots: 8,
  limits: [],
  risk: "",
};

const positiveInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0;
const nonNegativeInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;

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
    abilities[a.id] = {
      id: a.id, ether_cost: a.ether_cost, range: a.range,
      description: typeof a.description === "string" ? a.description : "",
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
    maxEffects: raw.maxEffects,
    maxPathSteps: raw.maxPathSteps,
    summaryEveryTicks: raw.summaryEveryTicks,
    npcThinkEveryTicks: raw.npcThinkEveryTicks ?? DEFAULT_RULES.npcThinkEveryTicks,
    inventorySlots: raw.inventorySlots ?? DEFAULT_RULES.inventorySlots,
    limits: raw.limits,
    risk: raw.risk,
  };
}
