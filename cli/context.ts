// `kb context`: the text a session gets at start. Ranking and both budgets live here.

import { KINDS } from "./note.ts";
import { resolveRepo } from "./scope.ts";
import { HARD_CONTEXT_CAP, type Store, type StoredNote, type Usage } from "./store.ts";

export interface ContextResult {
  text: string;
  scope: string | null;
  /** Ids shown as index lines. */
  index: string[];
  /** Ids printed with a full body. */
  bodies: string[];
  /** Ids whose body did not fit the character budget. */
  dropped: string[];
  /** Index lines cut by the index budget. */
  hiddenIndexLines: number;
  chars: number;
}

const EMPTY: ContextResult = { text: "", scope: null, index: [], bodies: [], dropped: [], hiddenIndexLines: 0, chars: 0 };

/** open-work, gotcha, convention, decision, how-to. Then repo before global, last_used, last_verified. */
export function rank(notes: StoredNote[], usage: Map<string, Usage>): StoredNote[] {
  const desc = (a: string | undefined, b: string | undefined) => (b ?? "").localeCompare(a ?? "");
  return [...notes].sort(
    (a, b) =>
      KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
      Number(a.scope === "global") - Number(b.scope === "global") ||
      desc(usage.get(a.id)?.last_used, usage.get(b.id)?.last_used) ||
      desc(a.last_verified, b.last_verified) ||
      a.id.localeCompare(b.id),
  );
}

function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function indexLine(note: StoredNote): string {
  return `- ${note.id} [${note.kind}] ${note.title}`;
}

function bodyBlock(note: StoredNote): string {
  const meta = [`verified ${localDate(note.last_verified)}${note.verified_at_commit ? ` at ${note.verified_at_commit}` : ""}`, `confidence ${note.confidence}`];
  if (note.anchors.length > 0) meta.push(`anchors: ${note.anchors.join(", ")}`);
  return `### ${note.id} [${note.kind}] ${note.title}\n${meta.join(" | ")}\n${note.body}\n`;
}

function pointer(dropped: number): string {
  const fit = dropped > 0 ? `${dropped} ${dropped === 1 ? "note is" : "notes are"} in the index only, because the bodies did not fit. ` : "";
  return `${fit}\`kb show <id>\` prints one note. \`kb search <query>\` searches every note.`;
}

export function buildContext(store: Store, repoPath: string): ContextResult {
  if (!store.exists()) return EMPTY;
  const { scope } = resolveRepo(repoPath, store);
  const usage = store.usage();
  const config = store.config();

  // Promoted notes are already loaded by the repo's own CLAUDE.md or AGENTS.md.
  const visible = store.notes().filter((n) => n.indexed && !n.promoted_to && (n.scope === "global" || n.scope === scope));
  const syncError = store.syncError();
  if (visible.length === 0 && !syncError) return { ...EMPTY, scope };

  const ranked = rank(visible, usage);
  const charBudget = Math.max(500, Math.min(config.budgets.contextChars, HARD_CONTEXT_CAP));
  let indexCount = Math.min(ranked.length, Math.max(1, config.budgets.indexLines));

  const render = (indexed: StoredNote[], bodies: StoredNote[], droppedBodies: number): string => {
    const lines = [`# kb: saved knowledge for ${scope ?? "this machine"}`, "These notes come from earlier sessions. Index lines are titles only."];
    if (syncError) lines.push(`kb sync did not finish: ${syncError} \`kb sync\` shows the detail.`);
    if (indexed.length > 0) {
      lines.push("", "## Index");
      for (const section of ["global", scope]) {
        const inSection = indexed.filter((n) => n.scope === section);
        if (inSection.length === 0) continue;
        lines.push(`### ${section} (${inSection.length})`, ...inSection.map(indexLine));
      }
      const hidden = ranked.length - indexed.length;
      if (hidden > 0) lines.push(`${hidden} more index ${hidden === 1 ? "line is" : "lines are"} over the index budget.`);
    }
    if (bodies.length > 0) {
      lines.push("", `## Notes (${bodies.length} of ${ranked.length}, by rank)`);
      for (const note of bodies) lines.push(bodyBlock(note));
    } else {
      lines.push("");
    }
    if (ranked.length > 0) lines.push(pointer(droppedBodies));
    return `${lines.join("\n")}\n`;
  };

  // The index comes first. If it alone is over the character budget, cut it from the bottom.
  while (indexCount > 1 && render(ranked.slice(0, indexCount), [], ranked.length).length > charBudget) indexCount--;
  const indexed = ranked.slice(0, indexCount);

  // Whole bodies in rank order. The first one that does not fit ends the list, so a note is
  // never cut in half and a low-ranked short note never jumps ahead of a higher one.
  const bodies: StoredNote[] = [];
  for (const note of ranked) {
    const candidate = render(indexed, [...bodies, note], ranked.length);
    if (candidate.length > charBudget) break;
    bodies.push(note);
  }

  const dropped = ranked.slice(bodies.length);
  const text = render(indexed, bodies, dropped.length);
  return {
    text,
    scope,
    index: indexed.map((n) => n.id),
    bodies: bodies.map((n) => n.id),
    dropped: dropped.map((n) => n.id),
    hiddenIndexLines: ranked.length - indexed.length,
    chars: text.length,
  };
}

export interface BudgetResult {
  scope: string | null;
  index: { lines: number; budget: number; hidden: number };
  context: { chars: number; budget: number; bodies: number; dropped: number };
  over: boolean;
  /** Every note a session of this scope can see, in rank order. */
  notes: { id: string; kind: string; scope: string; uses: number; last_used: string | null; chars: number; shown: "body" | "index" | "hidden" }[];
  /** Notes to take out of the index first: fewest uses, then longest unused. Empty when nothing is over budget. */
  demote: { id: string; reason: string }[];
}

/** `kb budget`: sizes against both budgets, and which notes to demote when one is exceeded. */
export function buildBudget(store: Store, repoPath: string): BudgetResult {
  const context = buildContext(store, repoPath);
  const config = store.config();
  const usage = store.usage();
  const byId = new Map(store.notes().map((n) => [n.id, n]));
  const ranked = [...context.bodies, ...context.dropped].map((id) => byId.get(id)!).filter(Boolean);
  const bodies = new Set(context.bodies);
  const index = new Set(context.index);
  const notes = ranked.map((n) => ({
    id: n.id,
    kind: n.kind,
    scope: n.scope,
    uses: usage.get(n.id)?.uses ?? 0,
    last_used: usage.get(n.id)?.last_used ?? null,
    chars: bodyBlock(n).length,
    shown: bodies.has(n.id) ? ("body" as const) : index.has(n.id) ? ("index" as const) : ("hidden" as const),
  }));
  const over = context.dropped.length > 0 || context.hiddenIndexLines > 0;
  // Open work is never a demotion candidate: it leaves the index when it is done.
  const demote = over
    ? notes
        .filter((n) => n.kind !== "open-work")
        .sort((a, b) => a.uses - b.uses || (a.last_used ?? "").localeCompare(b.last_used ?? "") || b.chars - a.chars)
        .slice(0, Math.max(context.dropped.length, context.hiddenIndexLines))
        .map((n) => ({ id: n.id, reason: n.uses === 0 ? "never used" : `${n.uses} ${n.uses === 1 ? "use" : "uses"}, last ${n.last_used?.slice(0, 10)}` }))
    : [];
  return {
    scope: context.scope,
    index: { lines: ranked.length, budget: config.budgets.indexLines, hidden: context.hiddenIndexLines },
    context: { chars: context.chars, budget: Math.min(config.budgets.contextChars, HARD_CONTEXT_CAP), bodies: context.bodies.length, dropped: context.dropped.length },
    over,
    notes,
    demote,
  };
}
