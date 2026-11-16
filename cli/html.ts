// `kb html`: one self-contained page that shows the whole store. No server, no script dependency.

import { join } from "node:path";
import { rank } from "./context.ts";
import { KINDS } from "./note.ts";
import { type Store, type StoredNote, type Usage, writeAtomic } from "./store.ts";

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderBody(markdown: string): string {
  try {
    // Raw HTML in a note is shown as text, never run.
    return Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true });
  } catch {
    return `<pre>${esc(markdown)}</pre>`;
  }
}

/** A repo scope is host/owner/name. Show owner/name for GitHub. */
function scopeName(scope: string): string {
  return scope.startsWith("github.com/") ? scope.slice("github.com/".length) : scope;
}

/** The scope name, as a link to the repo when the scope is one. */
function scopeLabel(scope: string): string {
  const parts = scope.split("/");
  if (parts.length < 2 || !parts[0]!.includes(".")) return esc(scope);
  return `<a href="https://${esc(scope)}" target="_blank" rel="noopener noreferrer">${esc(scopeName(scope))}</a>`;
}

const KEY = (key: string) => `<kbd>${key}</kbd>`;

/** A short date in the zone of this machine: "16 Nov", with the year when it is not this year. */
function day(iso: string): string {
  const date = new Date(iso);
  const year = date.getFullYear() === new Date().getFullYear() ? {} : ({ year: "numeric" } as const);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...year });
}

/** One line in the list pane. `n` ties it to its article in the reading pane. */
function rowHtml(note: StoredNote, n: number): string {
  const haystack = esc(`${note.id} ${note.title} ${note.kind} ${note.scope} ${note.body}`.toLowerCase());
  return `<button class="row k-${note.kind}${note.archived ? " archived" : ""}" data-n="${n}" data-scope="${esc(note.scope)}" data-kind="${note.kind}" data-search="${haystack}" tabindex="-1"><span class="dot"></span><span class="title">${esc(note.title)}</span></button>`;
}

/** The whole note, shown in the reading pane when its row is the current one. */
function articleHtml(note: StoredNote, n: number, usage: Map<string, Usage>): string {
  const used = usage.get(note.id);
  const meta = [
    `<button data-copy="${esc(note.id)}" title="Copy the id">${esc(note.id)}</button>`,
    `<span>verified ${day(note.last_verified)}${note.verified_at_commit ? ` at ${esc(note.verified_at_commit)}` : ""}</span>`,
    `<span>confidence ${note.confidence}</span>`,
    `<span>${used?.uses ?? 0} ${used?.uses === 1 ? "use" : "uses"}${used?.last_used ? `, last ${day(used.last_used)}` : ""}</span>`,
  ];
  if (note.archived) meta.push("<span>archived</span>");
  if (!note.indexed) meta.push("<span>not indexed</span>");
  if (note.promoted_to) meta.push(`<span>promoted to ${esc(note.promoted_to)}</span>`);
  const anchors = note.anchors.length > 0 ? `<p class="anchors">${note.anchors.map((a) => `<code>${esc(a)}</code>`).join(" ")}</p>` : "";
  return `<article id="n-${n}" class="k-${note.kind}" hidden>
<p class="crumb"><span class="dot"></span><span class="kind">${note.kind}</span><span class="scope">${scopeLabel(note.scope)}</span></p>
<h2>${esc(note.title)}</h2>
<p class="meta">${meta.join("")}</p>${anchors}
<div class="body">${renderBody(note.body)}</div>
</article>`;
}

const STYLE = `
:root { --bg:#fbfbfa; --fg:#1c1c1a; --muted:#6f6f6a; --faint:#a3a39c; --line:#e7e7e2; --card:#fff; --hover:#f3f3f0; --sel:#eaeae6; --ring:#d3d3cd; --accent:#2f5bd8;
  --k-open-work:#c2410c; --k-gotcha:#b91c1c; --k-convention:#15803d; --k-decision:#6d28d9; --k-how-to:#0369a1;
  --mono:ui-monospace, SFMono-Regular, Menlo, monospace; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --fg:#ececea; --muted:#96968f; --faint:#6b6b65; --line:#262624; --card:#1c1c1b; --hover:#1c1c1b; --sel:#262625; --ring:#3b3b38; --accent:#8aa6ff;
  --k-open-work:#fb923c; --k-gotcha:#f87171; --k-convention:#4ade80; --k-decision:#c4b5fd; --k-how-to:#7dd3fc; } }
* { box-sizing: border-box; }
[hidden] { display:none !important; }
html, body { margin:0; }
body { background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing:antialiased; }
button { font:inherit; color:inherit; background:none; border:0; padding:0; cursor:pointer; text-align:left; }
.page { display:grid; grid-template-columns:248px 380px minmax(0,1fr); height:100vh; }
.pane { min-width:0; overflow-y:auto; }
.num { color:var(--faint); font-variant-numeric:tabular-nums; }
.dot { flex:none; width:7px; height:7px; border-radius:50%; background:var(--k); }
.k-open-work { --k:var(--k-open-work); } .k-gotcha { --k:var(--k-gotcha); } .k-convention { --k:var(--k-convention); } .k-decision { --k:var(--k-decision); } .k-how-to { --k:var(--k-how-to); }

.rail { padding:28px 12px 28px 16px; border-right:1px solid var(--line); }
.rail header { display:flex; align-items:baseline; gap:10px; padding:0 8px; }
h1 { font-size:20px; margin:0; letter-spacing:-0.01em; }
.sub { color:var(--muted); font-size:13px; }
.rail h3 { margin:22px 0 6px; padding:0 8px; font-size:11px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; color:var(--faint); }
.item { display:flex; align-items:center; gap:8px; width:100%; padding:4px 8px; border-radius:6px; font-size:13.5px; color:var(--muted); }
.item:hover { background:var(--hover); color:var(--fg); }
.item[aria-pressed=true] { background:var(--hover); color:var(--fg); font-weight:550; }
.item .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.item .num { font-size:12px; font-weight:400; }
.item.zero { opacity:0.4; }
.keys { margin:22px 8px 0; padding-top:12px; border-top:1px solid var(--line); font-size:12px; color:var(--faint); line-height:2; }
kbd { font:11px var(--mono); border:1px solid var(--line); border-radius:4px; padding:1px 5px; color:var(--muted); }

.list { border-right:1px solid var(--line); }
.top { position:sticky; top:0; z-index:1; background:var(--bg); padding:24px 16px 8px; }
.search { position:relative; }
.search input { width:100%; height:36px; padding:0 34px 0 12px; font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:8px; outline:0; }
.search input::placeholder { color:var(--faint); }
.search input:focus { border-color:var(--faint); }
.search kbd { position:absolute; right:9px; top:8px; pointer-events:none; }
.search input:focus + kbd { display:none; }
.where { display:flex; align-items:baseline; gap:8px; margin-top:14px; font:600 13px var(--mono); }
.where .num { font-weight:400; }
#rows { padding:0 8px 24px; }
.row { display:flex; gap:10px; align-items:baseline; width:100%; padding:7px 8px; border-radius:6px; font-size:14px; line-height:1.4; scroll-margin:104px 0 16px; }
.row .dot { position:relative; top:-2px; }
.row .title { flex:1; min-width:0; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.row:hover { background:var(--hover); }
.row[aria-current=true] { background:var(--hover); font-weight:550; }
.row.archived .title { color:var(--muted); }
/* The pane that has the keys marks its current item a little more. */
body[data-pane=list] .row[aria-current=true], body[data-pane=rail] .item.cur { background:var(--sel); box-shadow:inset 0 0 0 1px var(--ring); color:var(--fg); }
.empty { color:var(--muted); padding:8px 16px; margin:0; }

.read { padding:48px 48px 80px; }
article { max-width:660px; }
.crumb { display:flex; gap:10px; align-items:center; font-size:12.5px; color:var(--muted); margin:0 0 10px; }
.crumb .kind { color:var(--k); font-weight:550; }
.crumb a { color:inherit; text-decoration:none; }
.crumb a:hover { color:var(--fg); text-decoration:underline; }
article h2 { font-size:24px; line-height:1.25; letter-spacing:-0.015em; margin:0 0 14px; overflow-wrap:anywhere; }
.meta { display:flex; flex-wrap:wrap; gap:4px 14px; color:var(--muted); font-size:12.5px; margin:0 0 20px; padding-bottom:16px; border-bottom:1px solid var(--line); }
.meta button { font:12px var(--mono); color:var(--muted); overflow-wrap:anywhere; }
.meta button:hover { color:var(--fg); }
.anchors { margin:0 0 14px; display:flex; flex-wrap:wrap; gap:6px; }
.body { font-size:15.5px; line-height:1.65; overflow-wrap:anywhere; }
.body > :first-child { margin-top:0; } .body > :last-child { margin-bottom:0; }
.body p, .body ul, .body ol, .body pre { margin:0 0 12px; }
.body ul, .body ol { padding-left:20px; }
.body a { color:var(--accent); }
code { font:12.5px var(--mono); background:var(--hover); border-radius:4px; padding:1px 5px; }
pre { overflow-x:auto; background:var(--hover); border-radius:6px; padding:10px 12px; }
pre code { padding:0; background:none; }

@media (max-width:900px) {
  .page { display:block; height:auto; }
  .rail { padding:20px 16px 12px; border-right:0; border-bottom:1px solid var(--line); }
  .rail nav { display:flex; flex-wrap:wrap; gap:4px; margin-top:12px; }
  .rail h3, .keys { display:none; }
  .item { width:auto; border:1px solid var(--line); border-radius:999px; padding:2px 10px; }
  .list { max-height:46vh; border-right:0; border-bottom:1px solid var(--line); }
  .top { padding-top:14px; }
  .read { padding:24px 16px 60px; }
}
`;

// Runs in the page. String.raw keeps the regular expressions as written.
const SCRIPT = String.raw`
const q = document.getElementById("q"), read = document.getElementById("read"), where = document.getElementById("where"), none = document.getElementById("none");
const rows = [...document.querySelectorAll(".row")], items = [...document.querySelectorAll(".item")], articles = [...document.querySelectorAll("article")];
const kinds = items.filter((i) => i.dataset.kind).map((i) => i.dataset.kind);
const state = { scope: null, kind: null, archived: false };
// cursor: where the keys are in the sidebar. held: the scope to go back to when the cursor walks past the scopes.
let pane = "list", current = null, shown = [], cursor = items[0], held = null;
const isScope = (item) => item.dataset.scope !== undefined;

function paint() {
  document.body.dataset.pane = pane;
  for (const item of items) item.classList.toggle("cur", item === cursor);
}
function show(row, scroll) {
  current = row || null;
  for (const r of rows) r.setAttribute("aria-current", r === current);
  for (const a of articles) a.hidden = !current || a.id !== "n-" + current.dataset.n;
  if (current && scroll) current.scrollIntoView({ block: "nearest" });
  read.scrollTop = 0;
}
function render() {
  const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
  const byScope = new Map(), byKind = new Map();
  let anyScope = 0;
  shown = [];
  for (const row of rows) {
    const base = words.every((w) => row.dataset.search.includes(w)) && (state.archived || !row.classList.contains("archived"));
    const inScope = !state.scope || row.dataset.scope === state.scope, inKind = !state.kind || row.dataset.kind === state.kind;
    if (base && inKind) { anyScope++; byScope.set(row.dataset.scope, (byScope.get(row.dataset.scope) || 0) + 1); }
    if (base && inScope) byKind.set(row.dataset.kind, (byKind.get(row.dataset.kind) || 0) + 1);
    row.hidden = !(base && inScope && inKind);
    if (!row.hidden) shown.push(row);
  }
  for (const item of items) {
    if (item.dataset.archived !== undefined) { item.setAttribute("aria-pressed", state.archived); continue; }
    const count = isScope(item) ? (item.dataset.scope === "*" ? anyScope : byScope.get(item.dataset.scope) || 0) : byKind.get(item.dataset.kind) || 0;
    item.querySelector(".num").textContent = count;
    item.classList.toggle("zero", count === 0);
    item.setAttribute("aria-pressed", isScope(item) ? (state.scope || "*") === item.dataset.scope : state.kind === item.dataset.kind);
  }
  const scopeItem = items.find((i) => isScope(i) && (state.scope || "*") === i.dataset.scope);
  where.firstChild.textContent = scopeItem.querySelector(".name").textContent + (state.kind ? " / " + state.kind : "");
  where.lastChild.textContent = shown.length;
  none.hidden = shown.length > 0;
  show(shown.includes(current) ? current : shown[0], true);
  paint();
}
function setScope(item) { state.scope = item.dataset.scope === "*" ? null : item.dataset.scope; }
function toggleKind(kind) { state.kind = state.kind === kind ? null : kind; }
/** A click or Enter on a sidebar item. A scope chosen this way is held. */
function activate(item) {
  if (isScope(item)) { setScope(item); held = state.scope; }
  else if (item.dataset.kind) toggleKind(item.dataset.kind);
  else state.archived = !state.archived;
  render();
}
function step(list, from, by) { return list[Math.max(0, Math.min(list.length - 1, list.indexOf(from) + by))]; }

q.addEventListener("input", render);
document.addEventListener("click", (event) => {
  const copy = event.target.closest("[data-copy]"), item = event.target.closest(".item"), row = event.target.closest(".row");
  if (copy) {
    if (navigator.clipboard) navigator.clipboard.writeText(copy.dataset.copy);
    const id = copy.textContent;
    copy.textContent = "copied";
    setTimeout(() => (copy.textContent = id), 900);
  } else if (item) {
    pane = "rail"; cursor = item;
    activate(item);
  } else if (row) {
    pane = "list";
    show(row);
    paint();
    if (matchMedia("(max-width: 900px)").matches) read.scrollIntoView({ block: "start" });
  }
});
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key;
  if (document.activeElement === q) {
    if (key === "Escape") { q.value = ""; q.blur(); render(); }
    else if (key === "ArrowDown" || key === "Enter") { event.preventDefault(); q.blur(); pane = "list"; paint(); }
    return;
  }
  const by = key === "ArrowDown" || key === "j" ? 1 : key === "ArrowUp" || key === "k" ? -1 : 0;
  if (key === "/") { q.focus(); q.select(); }
  else if (key === "ArrowLeft" || key === "h") {
    if (pane !== "rail") { cursor = items.find((i) => isScope(i) && (state.scope || "*") === i.dataset.scope); held = state.scope; }
    pane = "rail";
  } else if (key === "ArrowRight" || key === "l") pane = "list";
  else if (by && pane === "list") { if (shown.length) show(step(shown, current, by), true); }
  else if (by) {
    const was = cursor;
    cursor = step(items, cursor, by);
    // Scopes apply as the cursor moves. Walking on into the kinds puts the held scope back.
    if (isScope(cursor)) { if (!isScope(was)) held = state.scope; setScope(cursor); render(); }
    else if (isScope(was)) { state.scope = held; render(); }
    cursor.scrollIntoView({ block: "nearest" });
  } else if ((key === "Enter" || key === " ") && pane === "rail") activate(cursor);
  else if (kinds[Number(key) - 1]) { toggleKind(kinds[Number(key) - 1]); render(); }
  else return;
  event.preventDefault();
  paint();
});
render();
`;

export function renderHtml(store: Store): string {
  const usage = store.usage();
  const active = store.notes();
  const archived = store.notes({ archived: true });
  const scopes = [...new Set([...active, ...archived].map((n) => n.scope))].sort((a, b) => (a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b)));
  // The list reads scope by scope, live notes before archived ones, each in rank order.
  const notes = scopes.flatMap((scope) => [...rank(active.filter((n) => n.scope === scope), usage), ...rank(archived.filter((n) => n.scope === scope), usage)]);

  const item = (attrs: string, name: string, cls = "") => `<button class="item${cls}" ${attrs} aria-pressed="false" tabindex="-1">${name}<span class="num"></span></button>`;
  const rail = [
    "<h3>Scopes</h3>",
    item('data-scope="*"', '<span class="name">All notes</span>'),
    ...scopes.map((scope) => item(`data-scope="${esc(scope)}" title="${esc(scope)}"`, `<span class="name">${esc(scopeName(scope))}</span>`)),
    "<h3>Kinds</h3>",
    ...KINDS.map((kind) => item(`data-kind="${kind}"`, `<span class="dot"></span><span class="name">${kind}</span>`, ` k-${kind}`)),
    ...(archived.length > 0 ? ["<h3>Archive</h3>", `<button class="item" data-archived aria-pressed="false" tabindex="-1"><span class="name">Show archived</span><span class="num">${archived.length}</span></button>`] : []),
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kb</title>
<style>${STYLE}</style>
</head>
<body data-pane="list">
<div class="page">
<aside class="pane rail">
<header><h1>kb</h1><span class="sub">${active.length} ${active.length === 1 ? "note" : "notes"}${archived.length > 0 ? `, ${archived.length} archived` : ""}</span></header>
<nav>
${rail}
</nav>
<p class="keys">${KEY("&uarr;")} ${KEY("&darr;")} move<br>${KEY("&larr;")} ${KEY("&rarr;")} sidebar or list<br>${KEY("enter")} pick in the sidebar<br>${KEY("1")} to ${KEY(String(KINDS.length))} kind on or off<br>${KEY("/")} filter</p>
</aside>
<div class="pane list">
<div class="top"><div class="search"><input type="search" id="q" placeholder="Filter notes" autocomplete="off"><kbd>/</kbd></div><div class="where" id="where"><span></span><span class="num"></span></div></div>
<div id="rows">
${notes.map(rowHtml).join("\n")}
</div>
<p class="empty" id="none" hidden>${notes.length === 0 ? "The store has no notes yet." : "No notes match."}</p>
</div>
<main class="pane read" id="read">
${notes.map((note, n) => articleHtml(note, n, usage)).join("\n")}
</main>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

export function htmlPath(store: Store): string {
  return join(store.home, "index.html");
}

export function writeHtml(store: Store): string {
  const path = htmlPath(store);
  writeAtomic(path, renderHtml(store));
  return path;
}
