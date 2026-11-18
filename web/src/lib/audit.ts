// The audit deck, worked out from the agent's cards and the user's picks. No React here, so tests can run it.

import type { AuditCard, AuditData, AuditNote, AuditPick } from "../../../cli/wire.ts";

/** What the user can pick on a card. keep changes nothing. ask sends the note back to the agent. index takes back a demotion. */
export type Choice = "verify" | "rewrite" | "ask" | "edit" | "trash" | "merge" | "demote" | "index" | "keep";

export interface Pick {
  action: Exclude<Choice, "edit">;
  /** The user's own text, from edit. */
  title?: string;
  body?: string;
  /** For ask: what is wrong with the note. */
  request?: string;
}

/** One step of the deck: a card, or a divider before a group of cards. */
export type Step = { type: "card"; card: AuditCard; i: number } | { type: "divider"; group: string; cards: number[] };

export const KEYS: Record<Choice, string> = { verify: "v", rewrite: "r", ask: "r", edit: "e", trash: "t", merge: "m", demote: "d", index: "i", keep: "k" };

/** The steps in order: cards with no group first, then each group after its divider, in the order the agent gave. */
export function steps(cards: AuditCard[]): Step[] {
  const groups = new Map<string, number[]>();
  const loose: number[] = [];
  cards.forEach((card, i) => (card.group ? groups.set(card.group, [...(groups.get(card.group) ?? []), i]) : loose.push(i)));
  const card = (i: number): Step => ({ type: "card", card: cards[i]!, i });
  return [...loose.map(card), ...[...groups].flatMap(([group, ids]): Step[] => [{ type: "divider", group, cards: ids }, ...ids.map(card)])];
}

/** The choices of a card, in the order of its keys. */
export function choices(card: AuditCard, over: boolean): Choice[] {
  if (card.merge) return ["merge", "edit", "keep"];
  // A demoted note can go back in the index. A note in it can be demoted only while notes reach no
  // session: each note out of the index gives one of them its line. Open work leaves the index when
  // it is done, so it is never demoted.
  const index: Choice[] = card.note.indexed ? (card.action === "demote" || (over && card.note.kind !== "open-work") ? ["demote"] : []) : ["index"];
  if (card.proposed) return ["verify", "rewrite", "edit", "trash", ...index, "keep"];
  return ["verify", "ask", "edit", "trash", ...index, "keep"];
}

export const agentPick = (card: AuditCard): Pick => ({ action: card.action });

/** True when the note takes a place in a session now, so taking it out frees a line for another note. */
const placed = (note: AuditNote) => note.indexed && note.place !== "hidden";

/**
 * The index lines the picks give back. A note that leaves gives its line to a note that reaches no
 * session, but only if it had one. A demoted note put back takes a line again.
 */
export function freed(cards: AuditCard[], picks: Pick[]): number {
  return cards.reduce((n, card, i) => {
    const pick = picks[i]!;
    if (pick.action === "trash" || pick.action === "demote") return n + (placed(card.note) ? 1 : 0);
    if (pick.action === "merge") return n + (card.merge ?? []).filter(placed).length;
    if (pick.action === "index") return n - 1;
    return n;
  }, 0);
}

/** Notes that still reach no session after the picks. */
export const stillHidden = (data: AuditData, picks: Pick[]) => Math.max(0, data.index.hidden - freed(data.cards, picks));

/** The words for a pick, as the card and the summary say it. */
export function pickLabel(card: AuditCard, pick: Pick): string {
  switch (pick.action) {
    case "rewrite":
      return pick.body !== undefined || pick.title !== undefined ? "rewrite with your text" : "rewrite with the agent's text";
    case "merge":
      return pick.body !== undefined || pick.title !== undefined ? "merge with your text" : "merge";
    case "ask":
      return "ask the agent to rewrite";
    case "index":
      return "put back in the index";
    case "keep":
      return card.merge ? "keep both" : "keep";
    default:
      return pick.action;
  }
}

/** The label of a choice's button. */
export function choiceLabel(card: AuditCard, choice: Choice): string {
  if (choice === "rewrite") return "use new text";
  if (choice === "ask") return "ask for rewrite";
  if (choice === "edit") return "edit text";
  if (choice === "index") return "put back";
  if (choice === "keep" && card.merge) return "keep both";
  return choice;
}

/** The picks as the server takes them. keep is sent too, so the result says what the user kept. */
export function toPicks(cards: AuditCard[], picks: Pick[]): AuditPick[] {
  return cards.map((card, i) => {
    const pick = picks[i]!;
    const out: AuditPick = { id: card.id, action: pick.action };
    if (pick.title !== undefined) out.title = pick.title;
    if (pick.body !== undefined) out.body = pick.body;
    if (pick.request !== undefined) out.request = pick.request;
    return out;
  });
}

/** The summary before Apply: each pick with the cards that have it, in a fixed order. */
export function summary(cards: AuditCard[], picks: Pick[]): { label: string; action: Pick["action"]; ids: string[] }[] {
  const groups = new Map<string, { label: string; action: Pick["action"]; ids: string[] }>();
  const order = ["verify", "rewrite", "merge", "ask", "trash", "demote", "index", "keep"];
  cards.forEach((card, i) => {
    const pick = picks[i]!;
    const label = pick.action === "ask" ? "sent back to the agent to rewrite" : pickLabel(card, pick);
    const group = groups.get(label) ?? { label, action: pick.action, ids: [] };
    group.ids.push(card.id);
    groups.set(label, group);
  });
  return [...groups.values()].sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
}
