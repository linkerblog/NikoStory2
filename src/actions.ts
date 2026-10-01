import type { Ent, Zone } from "./world.js";

// The single action API: the client, the interpreter and the engine all speak these types. The
// engine is the only place that turns one into state, so no actor gets a private shortcut.
export type Dir = "N" | "S" | "E" | "W";
export type ReplyChoice = "ask" | "reassure" | "press";

export type Action =
  | { type: "move"; dir: Dir }
  | { type: "wait" }
  | { type: "talk"; target: string }
  | { type: "reply"; target: string; choice: ReplyChoice }
  | { type: "leave"; target: string }
  | { type: "examine"; target: string }
  | { type: "say"; text: string }
  | { type: "ability"; id: string; target?: string }
  | { type: "fall"; text: string }
  | { type: "free"; text: string };

export interface OpenConversation { npc_id: string }

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
  if (["examine", "inspect", "search", "check", "study", "look", "find", "open", "read"].includes(head)) {
    const name = t.replace(/^(examine|inspect|search|check|study|look at|look|find|open|read)(\s+the|\s+at)?\s*/, "").trim();
    const o = zone.objects.find((obj) => name && obj.name.toLowerCase().includes(name.toLowerCase()));
    if (o) return { type: "examine", target: o.id };
  }
  return null;
}
