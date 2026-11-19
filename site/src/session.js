// Mirrors cli/context.ts newStart: the fixed text, briefs of the repo's open work, one index line for each other note, and the pointer.
// The character budget is the one limit. A global note with a trigger takes no line.
const SENT = 'Each note is below once. An index line is the id, then "..." and the rest of the title.';
const MAX_BRIEFS = 3;
function rankNotes(list, D) {
  const desc = (a, b) => (b ?? "").localeCompare(a ?? "");
  const open = (n) => (n.kind === "open-work" ? 0 : 1);
  return [...list].sort((a, b) => {
    const global = a.scope === "global";
    if (global !== (b.scope === "global")) return global ? 1 : -1;
    const kind = D.kinds.indexOf(a.kind) - D.kinds.indexOf(b.kind), activity = desc(a.active, b.active), rest = desc(a.verified, b.verified) || a.id.localeCompare(b.id);
    return global ? open(a) - open(b) || activity || kind || rest : kind || activity || rest;
  });
}
function session(D, scope) {
  const ranked = rankNotes(D.notes.filter((n) => !n.trashed && !n.promoted && (n.scope === "global" || n.scope === scope)), D);
  const budget = Math.min(Math.max(500, D.budgets.chars) + D.save + 1, D.cap);
  const atTrigger = (n) => n.scope === "global" && n.kind !== "open-work" && n.trigger;
  const pointer = (t) => (t > 0 ? `${t} more global ${t === 1 ? "note loads" : "notes load"} only at ${t === 1 ? "its" : "their"} trigger, a command or an error. ` : "") + "`kb show <id>` prints one note. `kb search <words>` searches every note.";
  // Each entry of a list is the length of one line of the text. A line costs its length and one newline.
  const size = (L) => L.reduce((a, b) => a + b, 0) + L.length;
  const parts = ({ briefs, listed, waits, hidden }) => {
    const B = briefs.length ? [0, "## Open work".length, ...briefs.map((n) => n.brief)] : [], I = [];
    if (listed.length) {
      I.push(0, "## Index".length);
      for (const sec of [scope, "global"]) { const s = listed.filter((n) => n.scope === sec); if (s.length) I.push(`### ${sec} (${s.length})`.length, ...s.map((n) => n.line.length)); }
      if (hidden.length) I.push(`${hidden.length} more index ${hidden.length === 1 ? "line is" : "lines are"} over the index budget.`.length);
    }
    const F = [`# kb: saved knowledge for ${scope ?? "this machine"}`.length, SENT.length, D.save, 0];
    if (ranked.length) F.push(pointer(waits.length).length);
    return { fixed: size(F), briefs: size(B), index: size(I) };
  };
  const len = (shown) => { const p = parts(shown); return p.fixed + p.briefs + p.index; };
  const place = (briefs) => {
    const rest = ranked.filter((n) => !briefs.includes(n)), lined = rest.filter((n) => !atTrigger(n)), waits = rest.filter(atTrigger);
    return { total: lined.length, at: (k) => ({ briefs, listed: lined.slice(0, k), hidden: lined.slice(k), waits }) };
  };
  // The largest count of lines that fits, and at least one. Lines drop from the bottom.
  const fit = ({ total, at }) => {
    const fits = (k) => len(at(k)) <= budget;
    if (total <= 1 || fits(total)) return total;
    let low = 1, high = total - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(mid)) low = mid; else high = mid - 1; }
    return low;
  };
  // Open work of this scope only, at most 3 briefs, inside the brief budget.
  const own = scope ?? "global", briefs = [];
  const open = ranked.filter((n) => n.kind === "open-work" && n.scope === own).sort((a, b) => (b.verified ?? "").localeCompare(a.verified ?? "") || a.id.localeCompare(b.id));
  let chars = 0;
  for (const n of open) { chars += n.brief + 1; if (briefs.length === MAX_BRIEFS || chars > D.budgets.briefs || len(place([...briefs, n]).at(0)) > budget) break; briefs.push(n); }
  const placed = place(briefs), shown = placed.at(fit(placed)), by = ranked.length ? parts(shown) : { fixed: 0, briefs: 0, index: 0 };
  return { ranked, ...shown, budget, by, chars: by.fixed + by.briefs + by.index };
}
if (typeof module !== "undefined") module.exports = { session };
