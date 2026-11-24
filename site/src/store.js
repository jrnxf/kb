// The example store of the page and the words the budget widget shows. The page runs it in the browser, and build.ts runs it to
// write the numbers into the HTML and the static state of the widgets that a reader without JavaScript sees.
function demo(RAW, session) {
  const SCOPE = "github.com/jrnxf/kb";
  const fmt = (n) => n.toLocaleString("en-US");
  const KSHADE = [88, 68, 50, 34, 22];
  const kshade = (k) => `color-mix(in oklab, var(--ink) ${KSHADE[k]}%, var(--sunk))`;
  const mkNotes = (n) => Array.from({ length: n }, (_, i) => { const [k, g, blk, ll, br, tg] = RAW.notes[i % RAW.notes.length];
    return { id: "n" + String(i).padStart(4, "0"), kind: RAW.kinds[k], k, scope: g ? "global" : SCOPE, blk, line: "x".repeat(ll), brief: br || 0, trigger: !!tg, active: String(9999 - i).padStart(4, "0"), verified: "" }; });
  const runOn = (notes, chars) => session({ kinds: RAW.kinds, save: RAW.save, cap: RAW.cap, budgets: { chars, briefs: RAW.briefs }, notes }, SCOPE);
  const tiersOf = (S) => { const t = new Map(); for (const [name, list] of [["body", S.briefs], ["index", S.listed], ["wait", S.waits], ["gone", S.hidden]]) for (const n of list) t.set(n, name); return t; };
  // The six steps of the budget widget, for a store of notes packed into a budget of chars.
  const steps = (S, notes, chars) => { const R = notes.length, b = S.briefs.length, k = S.listed.length, w = S.waits.length, hd = S.hidden.length, g = notes.filter((n) => n.scope === "global").length;
    return [
      { t: `${R} notes, in no order`, d: `Every note a session in this repo could load: ${g} global notes and ${R - g} of its own. The shade shows the kind.` },
      { t: "Rank them", d: "The repo's notes come first, by kind: open work, then gotchas, conventions, decisions and how-tos. Global notes follow: open work, then the most recently active." },
      { t: b ? "Brief the open work" : "No brief fits", d: b ? "The repo's open work gets a brief: the title and the next step. At most 3 notes get one. No other note loads its body here." : "The fixed text alone fills the character budget." },
      { t: `${w} ${w === 1 ? "note waits" : "notes wait"} for a trigger`, d: "A global note with a trigger takes no line. It loads when the agent runs the command or hits the error." },
      { t: `Give ${k} notes an index line`, d: `A line is the id, the kind and the end of the title. The characters are the only limit: ${fmt(chars)} for the notes, with the save rule on top.` },
      { t: hd ? `${hd} ${hd === 1 ? "note reaches" : "notes reach"} no session` : "Every note reaches the session", d: hd ? "Their lines did not fit. Lines drop from the bottom, so the global notes of the lowest rank go first. A path or kb search still finds them." : "Each note has a brief, a line or a trigger. Lower the budget, and lines drop from the bottom." }]; };
  const legend = () => RAW.kinds.map((k, i) => `<span><i style="background:${kshade(i)}"></i>${k}</span>`).join("") + `<span><i style="background:var(--body)"></i>brief</span><span><i style="background:var(--index)"></i>index line</span><span><i class="l-wait"></i>waits for its trigger</span><span><i style="background:var(--gone)"></i>reaches no session</span><span><i class="l-fix"></i>fixed text</span>`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // "2 briefs", and "2 briefs · 140 lines" for the header of the budget card.
  const briefCount = (S) => plural(S.briefs.length, "brief", "briefs");
  const budgetCount = (S) => `${briefCount(S)} · ${S.listed.length} lines`;
  const tally = (S) => { const w = S.waits.length;
    return `<span class="w-tag t-body">${briefCount(S)}</span><span class="w-tag t-index">${S.listed.length} index lines</span><span class="w-tag t-wait">${w} ${w === 1 ? "waits" : "wait"} for a trigger</span><span class="w-tag t-gone">${S.hidden.length} reach no session</span>`; };
  // The caption and the character bar of the packer at step p (0 to 5): the build writes step 5, the page starts at step 0 and moves them.
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const packerCap = (st, p) => `<div class="p-cap"><span class="n">Step ${p + 1} of 6</span><b>${esc(st.t)}</b><p>${esc(st.d)}</p></div>`;
  const packerBars = (S, p) => { const by = S.by, pct = (x) => Math.min(1, x / S.budget), tot = p >= 4 ? S.chars : p >= 2 ? by.fixed + by.briefs : 0;
    return `<span class="lab">characters</span><div class="cbar-wrap"><div class="cbar"><div class="s-fix" style="width:${p >= 2 ? (pct(by.fixed) * 100).toFixed(2) : 0}%"></div><div class="seg s-body" style="left:${(pct(by.fixed) * 100).toFixed(2)}%;transform:scaleX(${p >= 2 ? pct(by.briefs).toFixed(4) : 0})"></div><div class="seg s-idx" style="left:${(pct(by.fixed + by.briefs) * 100).toFixed(2)}%;transform:scaleX(${p >= 4 ? pct(by.index).toFixed(4) : 0})"></div><div class="edge"></div></div></div><span class="v cval">${fmt(tot)} / ${fmt(S.budget)}</span>`; };
  // The growth widget: the same markup at build time (what a reader without JavaScript sees) and in the page, so nothing shifts when the page takes over.
  // The widget starts at GROWTH_START notes. The static numbers are those of that state.
  const GROWTH_START = 10, GROWTH_ALL = mkNotes(800), GROWTH_MAX = GROWTH_ALL.reduce((a, n) => a + n.blk, 0);
  const growthAt = (n) => { const notes = GROWTH_ALL.slice(0, n); return { notes, S: runOn(notes, RAW.chars), store: notes.reduce((a, x) => a + x.blk, 0) }; };
  const growthHTML = () => { const { S, store } = growthAt(GROWTH_START);
    const stat = (label, cls, v, color) => `<div class="g-stat">${label}<b class="${cls}">${fmt(v)} ch</b><div class="track"><div class="fill ${cls}f" style="background:${color};transform:scaleX(${(v / GROWTH_MAX).toFixed(4)})"></div></div></div>`;
    return `<div class="g-box"><canvas aria-hidden="true"></canvas></div>
    <label style="display:grid;gap:6px;font-size:13.5px;color:var(--mute)"><span style="display:flex;justify-content:space-between">Notes in the store <output style="color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums">${GROWTH_START}</output></span><input type="range" min="${GROWTH_START}" max="800" step="1" value="${GROWTH_START}" disabled></label>
    <div class="g-stats">${stat("in the store", "gs", store, "var(--mute)")}${stat("in each session", "gc", S.chars, "var(--index)")}</div>`; };
  return { SCOPE, fmt, kshade, mkNotes, runOn, tiersOf, steps, legend, tally, packerCap, packerBars, briefCount, budgetCount, GROWTH_START, GROWTH_MAX, growthAt, growthHTML };
}
if (typeof module !== "undefined") module.exports = { demo };
