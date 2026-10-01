// Health is an engine rule. Everything here is pure: the engine rolls with `rngFor` and writes the
// result, the models only ever see `healthBand` words, never the numbers behind them.
export interface HealthBand { max: number; label: string }

// Provisional values, tunable in `data/rules.json` without a code change.
export interface CombatRules {
  hp: { niko: number; npc: number };
  strike: { hit: number; min: number; max: number };
  // Ether spent per point of damage the Ether Core takes in place of HP.
  etherPerHp: number;
  // A guarded blow is multiplied by this and rounded down.
  guardFactor: number;
  downedTicks: number;
  recoverHp: number;
  regen: { every: number; amount: number };
  // How long a witnessed blow justifies an NPC hitting back.
  retaliateTicks: number;
  // Ordered by `max` ascending; the first band whose `max` covers the HP fraction wins.
  bands: HealthBand[];
}

export const DEFAULT_COMBAT: CombatRules = {
  hp: { niko: 20, npc: 12 },
  strike: { hit: 0.75, min: 1, max: 3 },
  etherPerHp: 2,
  guardFactor: 0.5,
  downedTicks: 5,
  recoverHp: 3,
  regen: { every: 10, amount: 1 },
  retaliateTicks: 20,
  bands: [
    { max: 0, label: "down" },
    { max: 0.25, label: "near collapse" },
    { max: 0.5, label: "badly hurt" },
    { max: 0.999, label: "hurt" },
    { max: 1, label: "unhurt" },
  ],
};

// The keys of `entities.data` that belong to the health rules. They never reach a prompt.
const HIDDEN_KEYS = new Set(["hp", "hp_max", "guard_until", "downed_until"]);

export function publicData(data: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(data).filter(([k]) => !HIDDEN_KEYS.has(k)));
}

export interface Vitals { hp: number; max: number }

// A missing `hp` is full health, so a legacy save and a generated cast need no backfill.
export function vitalsOf(e: { type: string; data: Record<string, any> }, rules: CombatRules): Vitals {
  const fallback = e.type === "player" ? rules.hp.niko : rules.hp.npc;
  const rawMax = Number(e.data.hp_max);
  const max = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : fallback;
  const rawHp = e.data.hp === undefined ? max : Number(e.data.hp);
  const hp = Number.isFinite(rawHp) ? Math.max(0, Math.min(max, Math.floor(rawHp))) : max;
  return { hp, max };
}

export function healthBand(v: Vitals, rules: CombatRules): string {
  const fraction = v.max > 0 ? v.hp / v.max : 0;
  const band = rules.bands.find((b) => fraction <= b.max) ?? rules.bands[rules.bands.length - 1];
  return band.label;
}

export interface Blow { hit: boolean; damage: number }

// Two draws from the caller's seeded stream: whether it lands, then how hard. Both are always drawn so
// the stream position never depends on the outcome.
export function rollBlow(rules: CombatRules, rng: () => number): Blow {
  const hit = rng() < rules.strike.hit;
  const span = rules.strike.max - rules.strike.min + 1;
  const damage = rules.strike.min + Math.floor(rng() * span);
  return { hit, damage: hit ? damage : 0 };
}

export interface Mitigation {
  // Damage after the guard, before Ether.
  taken: number;
  // Points the Ether Core took, and what they cost in Ether.
  absorbed: number;
  etherSpent: number;
  hpLost: number;
}

export function mitigate(damage: number, ether: number, guarded: boolean, rules: CombatRules): Mitigation {
  const taken = guarded ? Math.floor(damage * rules.guardFactor) : damage;
  const absorbed = Math.min(taken, Math.floor(Math.max(0, ether) / rules.etherPerHp));
  return { taken, absorbed, etherSpent: absorbed * rules.etherPerHp, hpLost: taken - absorbed };
}

const positiveInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0;
const nonNegativeInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;
const fraction = (x: unknown): x is number => typeof x === "number" && x >= 0 && x <= 1;

// A malformed block is rejected, not trusted: the engine and both prompts depend on it. Missing keys
// fall back to the defaults, so a rules file written before combat existed still loads.
export function parseCombat(raw: any): CombatRules {
  if (raw === undefined) return DEFAULT_COMBAT;
  if (!raw || typeof raw !== "object") throw new Error("rules.json combat must be an object");
  const d = DEFAULT_COMBAT;
  const hp = { ...d.hp, ...(raw.hp ?? {}) };
  const strike = { ...d.strike, ...(raw.strike ?? {}) };
  const regen = { ...d.regen, ...(raw.regen ?? {}) };
  if (!positiveInt(hp.niko) || !positiveInt(hp.npc)) throw new Error("rules.json combat.hp needs positive integers");
  if (!fraction(strike.hit)) throw new Error("rules.json combat.strike.hit must be between 0 and 1");
  if (!nonNegativeInt(strike.min) || !nonNegativeInt(strike.max) || strike.max < strike.min) {
    throw new Error("rules.json combat.strike needs 0 <= min <= max");
  }
  if (!positiveInt(regen.every) || !nonNegativeInt(regen.amount)) {
    throw new Error("rules.json combat.regen needs a positive `every` and a non-negative `amount`");
  }
  const etherPerHp = raw.etherPerHp ?? d.etherPerHp;
  const guardFactor = raw.guardFactor ?? d.guardFactor;
  const downedTicks = raw.downedTicks ?? d.downedTicks;
  const recoverHp = raw.recoverHp ?? d.recoverHp;
  const retaliateTicks = raw.retaliateTicks ?? d.retaliateTicks;
  if (!positiveInt(etherPerHp)) throw new Error("rules.json combat.etherPerHp must be a positive integer");
  if (!fraction(guardFactor)) throw new Error("rules.json combat.guardFactor must be between 0 and 1");
  if (!positiveInt(downedTicks)) throw new Error("rules.json combat.downedTicks must be a positive integer");
  if (!positiveInt(recoverHp)) throw new Error("rules.json combat.recoverHp must be a positive integer");
  if (!positiveInt(retaliateTicks)) throw new Error("rules.json combat.retaliateTicks must be a positive integer");
  const bands = raw.bands ?? d.bands;
  if (
    !Array.isArray(bands) || bands.length === 0 ||
    bands.some((b: any, i: number) =>
      typeof b?.label !== "string" || !b.label || !fraction(b.max) || (i > 0 && b.max <= bands[i - 1].max))
  ) {
    throw new Error("rules.json combat.bands needs labelled bands with ascending max values");
  }
  if (bands[bands.length - 1].max !== 1) throw new Error("rules.json combat.bands must end at max 1");
  return {
    hp, strike, etherPerHp, guardFactor, downedTicks, recoverHp, regen, retaliateTicks,
    bands: bands.map((b: HealthBand) => ({ max: b.max, label: b.label })),
  };
}
