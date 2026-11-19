// Mirrors cli/context.ts buildContext: rank, index first, then whole bodies in rank order.
const SENT = 'These notes come from earlier sessions. Each is below once: with its body, or as an index line. An index line is the id, then after "..." the words of the title that the id cut.';
function rankNotes(list, D) {
  const desc = (a, b) => (b ?? "").localeCompare(a ?? "");
  return [...list].sort((a, b) => D.kinds.indexOf(a.kind) - D.kinds.indexOf(b.kind) || Number(a.scope === "global") - Number(b.scope === "global") || desc(a.last_used, b.last_used) || desc(a.verified, b.verified) || a.id.localeCompare(b.id));
}
function session(D, scope) {
  const visible = D.notes.filter((n) => !n.trashed && !n.promoted && (n.scope === "global" || n.scope === scope));
  const ranked = rankNotes(visible, D);
  const budget = D.budgets.chars;
  const len = (listed, bodies) => {
    let L = [`# kb: saved knowledge for ${scope ?? "this machine"}`.length, SENT.length, D.save];
    if (listed.length) {
      L.push(0, 8);
      for (const sec of ["global", scope]) { const s = listed.filter((n) => n.scope === sec); if (!s.length) continue; L.push(`### ${sec} (${s.length})`.length, ...s.map((n) => n.line.length)); }
      const hidden = ranked.length - bodies.length - listed.length;
      if (hidden > 0) L.push(`${hidden} more index ${hidden === 1 ? "line is" : "lines are"} over the index budget.`.length);
    }
    if (bodies.length) { L.push(0, `## Notes (${bodies.length} of ${ranked.length}, by rank)`.length, ...bodies.map((n) => n.blk)); } else L.push(0);
    if (ranked.length) { const d = listed.length; L.push((d > 0 ? `${d} ${d === 1 ? "note is" : "notes are"} in the index only, because the bodies did not fit. `.length : 0) + "`kb show <id>` prints one note. `kb search <words>` searches every note.".length); }
    return L.reduce((a, b) => a + b, 0) + L.length;
  };
  const listedFor = (b, k) => ranked.slice(b, b + k);
  let k = Math.min(ranked.length, Math.max(1, D.budgets.lines));
  while (k > 1 && len(listedFor(0, k), []) > budget) k--;
  const bodies = [];
  for (const n of ranked) { if (len(listedFor(bodies.length + 1, k), [...bodies, n]) > budget) break; bodies.push(n); }
  const listed = listedFor(bodies.length, k);
  const hidden = ranked.slice(bodies.length + listed.length);
  return { ranked, bodies, listed, hidden, chars: ranked.length ? len(listed, bodies) : 0 };
}
if (typeof module !== "undefined") module.exports = { session };
