// The audit deck, worked out from the agent's cards and the user's picks. No React here, so tests can run it.

import type { AuditCard, AuditData, AuditNote, AuditPick } from "../../../cli/wire.ts";

/**
 * What the user can pick on a card. keep says the note is still true. ask sends the note back to
 * the agent. edit opens the user's own text.
 */
export type Choice = "rewrite" | "ask" | "edit" | "trash" | "merge" | "keep";

export interface Pick {
  action: Exclude<Choice, "edit">;
  /** The user's own text, from edit. */
  title?: string;
  body?: string;
  /** For ask: what is wrong with the note. */
  request?: string;
  /** For keep: the user picked it on the card, so the note records the check. */
  checked?: boolean;
}

/** One step of the deck: a card, or a divider before a group of cards. */
export type Step = { type: "card"; card: AuditCard; i: number } | { type: "divider"; group: string; cards: number[] };

export const KEYS: Record<Choice, string> = { rewrite: "u", ask: "r", edit: "e", trash: "t", merge: "m", keep: "k" };

/** The key that takes the agent's pick, whatever it is. */
export const ACCEPT_KEY = "a";

/** The key that takes the agent's pick on every card the user has not picked yet. */
export const ACCEPT_REST_KEY = "A";

/** The steps in order: cards with no group first, then each group after its divider, in the order the agent gave. */
export function steps(cards: AuditCard[]): Step[] {
  const groups = new Map<string, number[]>();
  const loose: number[] = [];
  cards.forEach((card, i) => (card.group ? groups.set(card.group, [...(groups.get(card.group) ?? []), i]) : loose.push(i)));
  const card = (i: number): Step => ({ type: "card", card: cards[i]!, i });
  return [...loose.map(card), ...[...groups].flatMap(([group, ids]): Step[] => [{ type: "divider", group, cards: ids }, ...ids.map(card)])];
}

/**
 * The buttons of a card. The agent's pick comes first, as accept. Then the other picks, each once.
 */
export function choices(card: AuditCard): Choice[] {
  const all: Choice[] = card.merge ? ["merge", "keep"] : [...(card.proposed ? (["rewrite"] as Choice[]) : []), "keep", "trash"];
  return [card.action, ...all.filter((c) => c !== card.action)];
}

/** The picks that change the text. They sit on the text box, not in the row of buttons. */
export const textChoices = (card: AuditCard): Choice[] => (card.merge ? ["edit"] : ["edit", "ask"]);

/** The choice a key takes on a card, if any. */
export function choiceForKey(card: AuditCard, key: string): Choice | undefined {
  if (key === ACCEPT_KEY) return card.action;
  return [...choices(card), ...textChoices(card)].find((c) => KEYS[c] === key);
}

export const agentPick = (card: AuditCard): Pick => ({ action: card.action });

/** True when the note takes a place in a session now, so taking it out frees a line for another note. */
const placed = (note: AuditNote) => note.place !== "hidden";

/**
 * The index lines the picks give back. A note that leaves gives its line to a note that reaches no
 * session, but only if it had one.
 */
export function freed(cards: AuditCard[], picks: Pick[]): number {
  return cards.reduce((n, card, i) => {
    const pick = picks[i]!;
    if (pick.action === "trash") return n + (placed(card.note) ? 1 : 0);
    if (pick.action === "merge") return n + (card.merge ?? []).filter(placed).length;
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
    case "keep":
      return card.merge ? "keep both" : "keep as is";
    default:
      return pick.action;
  }
}

/** The label of a choice's button. */
export function choiceLabel(card: AuditCard, choice: Choice): string {
  if (choice === "rewrite") return "use new text";
  if (choice === "ask") return "ask the agent";
  if (choice === "edit") return "edit";
  if (choice === "keep") return card.merge ? "keep both" : "keep as is";
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
    if (pick.checked) out.checked = true;
    return out;
  });
}

/** The summary before Apply: each pick with the cards that have it, in a fixed order. */
export function summary(cards: AuditCard[], picks: Pick[]): { label: string; action: Pick["action"]; ids: string[] }[] {
  const groups = new Map<string, { label: string; action: Pick["action"]; ids: string[] }>();
  const order = ["rewrite", "merge", "ask", "trash", "keep"];
  cards.forEach((card, i) => {
    const pick = picks[i]!;
    const label = pick.action === "ask" ? "sent back to the agent to rewrite" : pickLabel(card, pick);
    const group = groups.get(label) ?? { label, action: pick.action, ids: [] };
    group.ids.push(card.id);
    groups.set(label, group);
  });
  return [...groups.values()].sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
}
