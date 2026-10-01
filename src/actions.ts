import type { Ent, Zone } from "./world.js";

// The single action API: the client, the interpreter and the engine all speak these types. The
// engine is the only place that turns one into state, so no actor gets a private shortcut.
export type Dir = "N" | "S" | "E" | "W";
export type ReplyChoice = "ask" | "reassure" | "press";
// `search` targets an object id; the other three target an item id.
export type ItemVerb = "take" | "drop" | "search" | "read";

export type Action =
  | { type: "move"; dir: Dir }
  | { type: "wait" }
  | { type: "talk"; target: string }
  | { type: "reply"; target: string; choice: ReplyChoice }
  | { type: "leave"; target: string }
  | { type: "examine"; target: string }
  | { type: "item"; verb: ItemVerb; target: string }
  | { type: "say"; text: string }
  | { type: "ability"; id: string; target?: string }
  | { type: "attack"; target: string }
  | { type: "fall"; text: string }
  | { type: "free"; text: string };

export interface OpenConversation { npc_id: string }
// An item as the parser and the interpreter see it: held by Niko, or visible on a tile in his zone.
export interface ItemRef { id: string; name: string; where: "held" | "here" }

// The deterministic parser behind the offline interpreter: an unknown line is not an action but a
// line the narrator answers, so "type anything" keeps working with no model and no network.
const FREE_DIR: Record<string, Dir> = {
  n: "N", north: "N", up: "N", forward: "N", forwards: "N",
  s: "S", south: "S", down: "S", back: "S",
  e: "E", east: "E", right: "E",
  w: "W", west: "W", left: "W",
};

export function parseFreeAction(
  text: string,
  zone: Zone,
  ents: Ent[],
  convo: OpenConversation | undefined,
  items: ItemRef[] = [],
): Action | null {
  const t = text.toLowerCase().trim().replace(/[.!?,;]+$/, "");
  if (!t) return null;
  const words = t.split(/\s+/);
  const head = words[0];
  if (convo) {
    if (["leave", "exit", "stop", "end", "goodbye", "bye", "farewell"].includes(head)) return { type: "leave", target: convo.npc_id };
    if (["reassure", "calm", "comfort", "soothe", "console"].includes(head)) return { type: "reply", target: convo.npc_id, choice: "reassure" };
    if (["press", "demand", "insist", "push", "urge"].includes(head)) return { type: "reply", target: convo.npc_id, choice: "press" };
    return { type: "reply", target: convo.npc_id, choice: "ask" };
  }
  const dir = FREE_DIR[head] ??
    (["go", "walk", "head", "move", "run"].includes(head) ? FREE_DIR[words[1] ?? ""] : undefined);
  if (dir) return { type: "move", dir };
  if (["wait", "rest", "stay", "idle", "pause"].includes(head) && words.length <= 2) return { type: "wait" };
  if (["talk", "speak", "chat", "greet", "address", "say"].includes(head)) {
    const name = t.replace(/^(talk|speak|chat|greet|address|say)(\s+to|\s+with)?\s*/, "").trim();
    const npc = ents.filter((e) => e.type === "npc" && e.zone_id === zone.id)
      .find((e) => name && e.name.toLowerCase().includes(name.toLowerCase()));
    if (npc) return { type: "talk", target: npc.id };
  }
  if (STRIKE_VERBS.includes(head)) {
    const name = nameAfter(t.replace(/^\w+/, ""));
    const npc = ents.filter((e) => e.type === "npc" && e.zone_id === zone.id)
      .find((e) => name && e.name.toLowerCase().includes(name));
    return npc ? { type: "attack", target: npc.id } : null;
  }
  const verb = ITEM_VERBS.find(([re]) => re.test(t));
  if (verb) {
    const name = nameAfter(t.replace(verb[0], ""));
    if (!name) return null;
    const [, itemVerb] = verb;
    if (itemVerb === "search") {
      const o = zone.objects.find((obj) => obj.name.toLowerCase().includes(name));
      return o ? { type: "item", verb: "search", target: o.id } : null;
    }
    const pool = items.filter((i) => (itemVerb === "drop" ? i.where === "held" : itemVerb === "take" ? i.where === "here" : true));
    const it = pool.find((i) => i.name.toLowerCase().includes(name));
    return it ? { type: "item", verb: itemVerb, target: it.id } : null;
  }
  if (["examine", "inspect", "check", "study", "look", "find"].includes(head)) {
    const name = nameAfter(t.replace(/^(examine|inspect|check|study|look at|look|find)\b/, ""));
    if (!name) return null;
    const o = zone.objects.find((obj) => obj.name.toLowerCase().includes(name));
    if (o) return { type: "examine", target: o.id };
    const it = items.find((i) => i.name.toLowerCase().includes(name));
    if (it) return { type: "examine", target: it.id };
  }
  return null;
}

const STRIKE_VERBS = ["attack", "hit", "punch", "strike", "kick", "slap"];

// `open` is a search: the engine resolves it on the object and finds nothing when nothing is hidden.
const ITEM_VERBS: [RegExp, ItemVerb][] = [
  [/^(take|grab|get|pick up)\b/, "take"],
  [/^(drop|put down)\b/, "drop"],
  [/^(search|open)\b/, "search"],
  [/^read\b/, "read"],
];

const nameAfter = (rest: string) => rest.trim().replace(/^(the|a|an|my|at)\s+/, "").trim();
