// The page that `kb serve` shows: the whole store in one self-contained document, with no script dependency.

import { rank } from "./context.ts";
import { KINDS } from "./note.ts";
import type { Store, StoredNote, Usage } from "./store.ts";

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
  return `<button class="row k-${note.kind}${note.archived ? " archived" : ""}" data-n="${n}" data-id="${esc(note.id)}" data-scope="${esc(note.scope)}" data-kind="${note.kind}" data-search="${haystack}" tabindex="-1"><span class="dot"></span><span class="title">${esc(note.title)}</span></button>`;
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
  // An archived note is read-only until it is restored.
  const acts = note.archived
    ? `<button data-act="restore">Restore ${KEY("r")}</button>`
    : `<button data-act="edit">Edit ${KEY("e")}</button><button data-act="archive">Archive ${KEY("a")}</button>`;
  return `<article id="n-${n}" class="k-${note.kind}" data-id="${esc(note.id)}" hidden>
<p class="crumb"><span class="dot"></span><span class="kind">${note.kind}</span><span class="scope">${scopeLabel(note.scope)}</span><span class="acts">${acts}</span></p>
<h2>${esc(note.title)}</h2>
<p class="meta">${meta.join("")}</p>${anchors}
<div class="body">${renderBody(note.body)}</div>
</article>`;
}

const DARK = `--bg:#151514; --fg:#ececea; --muted:#96968f; --faint:#6b6b65; --line:#262624; --card:#1c1c1b; --hover:#1c1c1b; --sel:#262625; --ring:#3b3b38; --accent:#8aa6ff; --scrim:rgba(0,0,0,0.7);
  --k-open-work:#fb923c; --k-gotcha:#f87171; --k-convention:#4ade80; --k-decision:#c4b5fd; --k-how-to:#7dd3fc;`;

// The theme follows the system until the person picks one. The pick sits in data-theme on the root.
const STYLE = `
:root { --bg:#fbfbfa; --fg:#1c1c1a; --muted:#6f6f6a; --faint:#a3a39c; --line:#e7e7e2; --card:#fff; --hover:#f3f3f0; --sel:#eaeae6; --ring:#d3d3cd; --accent:#2f5bd8; --scrim:rgba(0,0,0,0.2);
  --k-open-work:#c2410c; --k-gotcha:#b91c1c; --k-convention:#15803d; --k-decision:#6d28d9; --k-how-to:#0369a1;
  --mono:ui-monospace, SFMono-Regular, Menlo, monospace; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { ${DARK} } }
:root[data-theme=dark] { ${DARK} color-scheme:dark; }
:root[data-theme=light] { color-scheme:light; }
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

.rail { display:flex; flex-direction:column; padding:28px 12px 16px 16px; border-right:1px solid var(--line); }
.rail header { display:flex; align-items:baseline; gap:10px; padding:0 8px; }
h1 { font-size:20px; margin:0; letter-spacing:-0.01em; }
.rail h3 { margin:22px 0 6px; padding:0 8px; font-size:11px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; color:var(--faint); }
.item { display:flex; align-items:center; gap:8px; width:100%; padding:4px 8px; border-radius:6px; font-size:13.5px; color:var(--muted); }
.item:hover { background:var(--hover); color:var(--fg); }
.item[aria-pressed=true] { background:var(--hover); color:var(--fg); font-weight:550; }
.item .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.item .num { font-size:12px; font-weight:400; }
.item.zero { opacity:0.4; }
/* The key of a kind sits next to its name, so the count at the right edge stays the only number there. */
.item kbd { flex:none; margin:0 auto 0 8px; }
.item:has(kbd) .name { flex:0 1 auto; }
.sep { height:1px; margin:6px 8px; border:0; background:var(--line); }
.foot { display:flex; gap:2px; margin-top:auto; padding:20px 2px 0; }
.tool { display:grid; place-items:center; width:30px; height:30px; border-radius:6px; color:var(--muted); }
.tool:hover { background:var(--hover); color:var(--fg); }
.tool svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.theme svg { display:none; }
:root:not([data-theme]) .theme .system, :root[data-theme=light] .theme .light, :root[data-theme=dark] .theme .dark { display:block; }
/* A key, as shadcn's Kbd draws it. Each key of a combination is its own kbd, side by side. */
kbd { display:inline-flex; align-items:center; justify-content:center; height:20px; min-width:20px; padding:0 4px; border-radius:4px; font:500 12px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--muted); background:var(--sel); pointer-events:none; user-select:none; -webkit-user-select:none; }
.keys { display:inline-flex; align-items:center; gap:4px; }

.list { border-right:1px solid var(--line); }
.top { position:sticky; top:0; z-index:1; background:var(--bg); padding:24px 16px 8px; }
.search { position:relative; }
.search input { width:100%; height:36px; padding:0 34px 0 12px; font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:8px; outline:0; }
.search input::placeholder { color:var(--faint); }
.search input:focus { border-color:var(--faint); }
.search kbd { position:absolute; right:9px; top:8px; pointer-events:none; }
.search input:focus + kbd { display:none; }
/* The cross that clears the field, in the colors of the page and not the bright one of the browser. */
.search input::-webkit-search-cancel-button { -webkit-appearance:none; width:16px; height:16px; margin:0 -24px 0 8px; cursor:pointer; background:var(--faint); -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.6' stroke-linecap='round'%3E%3Cpath d='M4.5 4.5l7 7M11.5 4.5l-7 7'/%3E%3C/svg%3E") center / 16px no-repeat; }
.search input::-webkit-search-cancel-button:hover { background:var(--fg); }
.where { margin-top:14px; font:12px var(--mono); color:var(--faint); }
#rows { padding:0 8px 24px; }
.row { display:flex; gap:10px; align-items:baseline; width:100%; padding:7px 8px; border-radius:6px; font-size:14px; line-height:1.4; scroll-margin:104px 0 16px; }
.row .dot { position:relative; top:-2px; }
.row .title { flex:1; min-width:0; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.row:hover { background:var(--hover); }
.row[aria-current=true] { background:var(--hover); }
.row.archived .title { color:var(--muted); }
/* The pane that has the keys marks its current item a little more. */
body[data-pane=list] .row[aria-current=true], body[data-pane=rail] .item.cur { background:var(--sel); box-shadow:inset 0 0 0 1px var(--ring); color:var(--fg); }
.empty { display:grid; justify-items:start; gap:10px; padding:2px 16px 24px; font-size:13.5px; color:var(--muted); }
.empty[hidden] { display:none; }
.empty button { padding:3px 9px; border-radius:6px; font-size:12.5px; box-shadow:inset 0 0 0 1px var(--line); }
.empty button:hover { background:var(--hover); color:var(--fg); }

.read { padding:48px 48px 80px; }
.back, .scrim { display:none; }
.behind { display:contents; }
article { max-width:660px; }
.crumb { display:flex; gap:10px; align-items:center; font-size:12.5px; color:var(--muted); margin:0 0 10px; }
.crumb .kind { color:var(--k); font-weight:550; }
.crumb a { color:inherit; text-decoration:none; }
.crumb a:hover { color:var(--fg); text-decoration:underline; }
.acts { display:flex; gap:6px; margin-left:auto; }
.acts button, .form button { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:6px; font-size:12.5px; color:var(--muted); box-shadow:inset 0 0 0 1px var(--line); }
.acts button:has(kbd), .form button:has(kbd) { padding:3px 3px 3px 9px; }
.acts button:hover, .form button:hover { background:var(--hover); color:var(--fg); }
/* The buttons of the note are brighter while their keys work, which is while the keys are in the list. */
body[data-pane=list] .acts button { color:var(--fg); }
body[data-pane=rail] .acts button, body[data-pane=rail] .acts kbd { color:var(--faint); }
body[data-pane] .acts button:hover { color:var(--fg); }
.form { display:grid; gap:14px; max-width:660px; }
.form label { display:grid; gap:5px; font-size:12px; color:var(--muted); }
.form input, .form select, .form textarea { width:100%; padding:8px 10px; font:inherit; color:var(--fg); background:var(--card); border:1px solid var(--line); border-radius:8px; outline:0; }
.form input:focus, .form select:focus, .form textarea:focus { border-color:var(--faint); }
.form select { appearance:none; -webkit-appearance:none; padding-right:34px; background:var(--card) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%238a8a84' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5'/%3E%3C/svg%3E") no-repeat right 12px center / 12px; }
.form textarea { min-height:260px; font:13.5px/1.6 var(--mono); resize:vertical; }
.form .pair { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.form .end { display:flex; align-items:center; justify-content:flex-end; gap:8px; }
.form .end button { padding:5px 12px; font-size:13px; }
.form .end button[type=submit] { background:var(--fg); color:var(--bg); box-shadow:none; }
.form .end button[type=submit]:hover { background:var(--fg); color:var(--bg); opacity:0.88; }
/* On the dark Save button the keys take a see-through ground, as shadcn's Kbd does in a dark tooltip. */
.form .end button[type=submit] kbd { color:inherit; background:color-mix(in srgb, var(--bg) 22%, transparent); }
.form .error { margin-right:auto; color:var(--k-gotcha); font-size:13px; }
.toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); display:flex; align-items:center; gap:10px; padding:8px 14px; font-size:13px; background:var(--card); border:1px solid var(--ring); border-radius:8px; box-shadow:0 6px 24px rgba(0,0,0,0.18); }
.toast button { color:var(--muted); } .toast button:hover { color:var(--fg); }
.toast button { display:inline-flex; align-items:center; gap:6px; }
.help { width:min(340px, calc(100vw - 32px)); margin:auto; outline:0; padding:18px 20px 20px; color:var(--fg); background:var(--card); border:1px solid var(--ring); border-radius:10px; box-shadow:0 12px 40px rgba(0,0,0,0.28); }
.help::backdrop { background:rgba(0,0,0,0.4); }
.help header { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:12px; font:600 13px var(--mono); }
.help dl { display:grid; grid-template-columns:auto 1fr; gap:9px 16px; margin:0; font-size:13.5px; }
.help dt { display:flex; gap:4px; align-items:center; color:var(--muted); font-size:12px; }
.help dd { margin:0; color:var(--muted); }
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
  .rail { display:block; position:relative; padding:20px 16px 12px; border-right:0; border-bottom:1px solid var(--line); }
  .foot { position:absolute; top:14px; right:12px; padding:0; }
  /* A strip runs to both edges of the screen, so a chip that is cut at the edge says that there are more. */
  .strip { display:flex; gap:6px; margin:10px -16px 0; padding:0 16px; overflow-x:auto; scrollbar-width:none; }
  .strip::-webkit-scrollbar { display:none; }
  .rail h3, .sep { display:none; }
  .item { flex:none; width:auto; border:1px solid var(--line); border-radius:999px; padding:4px 12px; scroll-margin:0 16px; }
  .item .name { overflow:visible; }
  .list { border-right:0; }
  .top { padding-top:14px; }
  /* A note opens only from a tap on its row, in a drawer that slides up over the list and stops
     short of the top. A pull down closes it. The script moves it while a finger drags it. */
  .scrim { display:block; position:fixed; inset:0; z-index:2; background:var(--scrim); opacity:0; pointer-events:none; }
  /* The drawer runs on below the bottom of the screen by the bleed, as in Base UI, so a pull up shows
     more drawer and never the list under it. Its content keeps clear of the part below the screen. */
  .read { --bleed:64px; position:fixed; left:0; right:0; bottom:calc(-1 * var(--bleed)); z-index:3; height:calc(82vh + var(--bleed)); height:calc(82dvh + var(--bleed)); padding:0 16px calc(60px + var(--bleed)); overflow-y:auto; overscroll-behavior:contain; background:var(--bg); border-radius:14px 14px 0 0; box-shadow:0 -1px 0 var(--line), 0 -10px 40px rgba(0,0,0,0.35); transform:translate3d(0,100%,0); visibility:hidden; will-change:transform; }
  .read.anim, .scrim.anim, .behind.anim { transition:transform 450ms cubic-bezier(0.32,0.72,0,1), opacity 450ms cubic-bezier(0.32,0.72,0,1), clip-path 450ms cubic-bezier(0.32,0.72,0,1); }
  /* Behind an open drawer the list shrinks back from the edges, as in Vaul. The script sets its scale. */
  /* At least a screen tall: while the drawer moves the page is black, and a short list must still cover it. */
  .behind { display:block; min-height:100dvh; background:var(--bg); }
  body[data-reading], body.closing { background:#000; }
  body[data-reading] { overflow:hidden; }
  body[data-reading] .scrim { pointer-events:auto; }
  body[data-reading] .read, body.closing .read { visibility:visible; }
  .back { display:block; position:sticky; top:0; z-index:1; margin:0 -16px 4px; padding:8px 16px; background:var(--bg); border-radius:14px 14px 0 0; touch-action:none; cursor:grab; user-select:none; -webkit-user-select:none; }
  .back::before { content:""; display:block; width:36px; height:5px; margin:0 auto; border-radius:3px; background:var(--faint); opacity:0.5; }
  /* Safari on a phone zooms into a field with smaller text, and does not zoom back. */
  .search input, .form input, .form select, .form textarea { font-size:16px; }
}
/* A screen without a keyboard does not show the keys. */
@media (hover:none) and (pointer:coarse) {
  .acts kbd, .form kbd, .search kbd, .item kbd, .toast kbd, .toast .keys, #keys { display:none; }
}
`;

// Runs in the page. String.raw keeps the regular expressions as written.
const SCRIPT = String.raw`
const q = document.getElementById("q"), read = document.getElementById("read"), where = document.getElementById("where"), none = document.getElementById("none"), clear = document.getElementById("clear");
const rows = [...document.querySelectorAll(".row")], items = [...document.querySelectorAll(".item")], articles = [...document.querySelectorAll("article")];
const kinds = items.filter((i) => i.dataset.kind).map((i) => i.dataset.kind);
const TOKEN = document.body.dataset.token;
let version = document.body.dataset.version;
const MAC = /Mac|iPhone|iPad/.test(navigator.platform), themeButton = document.getElementById("theme"), help = document.getElementById("help");
const state = { scope: null, kinds: new Set(), archived: false };
// cursor: where the keys are in the sidebar. held: the scope to go back to when the cursor walks past the scopes.
let pane = "list", current = null, shown = [], cursor = items[0], held = null, form = null;
const isScope = (item) => item.dataset.scope !== undefined;
const scopeItem = () => items.find((i) => isScope(i) && (state.scope || "*") === i.dataset.scope) || items[0];
const article = () => (current ? document.getElementById("n-" + current.dataset.n) : null);
const PHONE = matchMedia("(max-width: 900px)");
const reading = () => document.body.dataset.reading !== undefined;
// The drawer on a phone. y is how far it is moved down from open: 0 is open, its height is closed.
const scrim = document.getElementById("scrim"), bar = read.querySelector(".back"), behind = document.getElementById("behind");
let drag = null, closeMs = 0;
// The longest the drawer takes to close.
const CLOSE_MS = 500;
const BLEED = 64;
/** ms sets a shorter slide, after a fast flick. */
function place(y, animate, ms) {
  read.classList.toggle("anim", animate); scrim.classList.toggle("anim", animate);
  read.style.transitionDuration = scrim.style.transitionDuration = behind.style.transitionDuration = ms ? ms + "ms" : "";
  read.style.transform = "translate3d(0," + y + "px,0)";
  // The dim fades out as the drawer goes down.
  const p = Math.min(1, Math.max(0, 1 - y / read.offsetHeight));
  scrim.style.opacity = p;
  // The list shrinks toward the top of the screen, and only the part on screen shows, with round corners.
  behind.classList.toggle("anim", animate);
  const top = scrollY - behind.offsetTop, bottom = Math.max(0, behind.offsetHeight - top - innerHeight);
  behind.style.transformOrigin = "50% " + top + "px";
  behind.style.transform = "translate3d(0,calc((env(safe-area-inset-top) + 14px) * " + p + "),0) scale(" + (1 - (p * 16) / innerWidth) + ")";
  behind.style.clipPath = "inset(" + top + "px 0 " + bottom + "px 0 round " + 8 * p + "px)";
}
function unplace() {
  for (const el of [read, behind]) el.style.transform = "";
  behind.style.transformOrigin = behind.style.clipPath = "";
}
/** The open note gets a history entry, so the back gesture closes it. */
function openNote(push) {
  if (!current) return;
  document.body.dataset.reading = "";
  // What is behind the drawer takes no taps and no focus, and screen readers skip it.
  behind.inert = true;
  read.scrollTop = 0;
  place(read.offsetHeight, false);
  read.getBoundingClientRect();
  place(0, push);
  if (push) history.pushState({ reading: true }, "", location.href);
  remember();
}
function closeNote() {
  if (!reading()) return;
  if (form) closeForm();
  delete document.body.dataset.reading;
  behind.inert = false;
  document.body.classList.add("closing");
  place(read.offsetHeight, true, closeMs);
  closeMs = 0;
  setTimeout(() => { if (reading()) return; document.body.classList.remove("closing"); behind.classList.remove("anim"); unplace(); }, CLOSE_MS);
  remember();
}
/** Close the note. When the note has its own history entry, going back closes it, as the gesture does. */
function back() {
  if (history.state && history.state.reading) history.back();
  else closeNote();
}
// A drag moves the drawer with the finger. On release it closes after a pull a quarter of its
// height or a flick down, as in Vaul. Otherwise it springs back.
function dragStart(y) { drag = { y0: y, y, t: performance.now(), v: 0, pos: 0 }; }
function dragMove(y) {
  const now = performance.now();
  drag.v = 0.7 * ((y - drag.y) / Math.max(1, now - drag.t)) + 0.3 * drag.v;
  drag.y = y; drag.t = now;
  let pos = y - drag.y0;
  // Up past open it resists, as a rubber band, and stops before the bleed runs out.
  if (pos < 0) pos = -Math.min(BLEED * 0.75, Math.sqrt(-pos) * 2);
  drag.pos = pos;
  place(pos, false);
}
function dragEnd() {
  if (!drag) return;
  const { pos, v } = drag;
  drag = null;
  // A faster flick slides the rest of the way faster, as in Base UI: from 450 ms down to 150 ms.
  const ms = Math.round(450 * Math.min(1, Math.max(1 / 3, 0.5 / Math.abs(v || 0.01))));
  if (pos > read.offsetHeight * 0.25 || (v > 0.4 && pos > 10)) { closeMs = ms; back(); } else place(0, true, ms);
}
// The bar is only a handle, so it takes the pointer at once.
bar.addEventListener("pointerdown", (e) => { if (reading()) { bar.setPointerCapture(e.pointerId); dragStart(e.clientY); } });
bar.addEventListener("pointermove", (e) => { if (drag) dragMove(e.clientY); });
bar.addEventListener("pointerup", dragEnd);
bar.addEventListener("pointercancel", dragEnd);
// In the note, a pull down at its start moves the drawer. Every other swipe scrolls the note.
// An open form keeps its own touches.
let touchY = null;
read.addEventListener("touchstart", (e) => { touchY = reading() && !form && !bar.contains(e.target) ? e.touches[0].clientY : null; }, { passive: true });
read.addEventListener("touchmove", (e) => {
  const y = e.touches[0].clientY;
  if (!drag && touchY !== null && Math.abs(y - touchY) > 4 && read.scrollTop <= 0 && y > touchY) dragStart(touchY);
  if (drag && touchY !== null) { e.preventDefault(); dragMove(y); }
}, { passive: false });
for (const type of ["touchend", "touchcancel"]) read.addEventListener(type, () => { if (touchY !== null) dragEnd(); touchY = null; });
scrim.addEventListener("click", back);

// The address keeps the view, so a reload after a change comes back to the same place.
function remember(noteId) {
  const view = new URLSearchParams();
  if (state.scope) view.set("scope", state.scope);
  if (state.kinds.size) view.set("kind", [...state.kinds].join(","));
  if (state.archived) view.set("archived", "1");
  if (q.value) view.set("q", q.value);
  const id = noteId !== undefined ? noteId : current && current.dataset.id;
  if (id) view.set("note", id);
  if (pane === "rail") view.set("pane", pane);
  if (reading()) view.set("read", "1");
  history.replaceState(history.state, "", "#" + view);
}
function paint() {
  document.body.dataset.pane = pane;
  for (const item of items) item.classList.toggle("cur", item === cursor);
  remember();
}
function show(row, scroll) {
  if (form) closeForm();
  current = row || null;
  for (const r of rows) r.setAttribute("aria-current", r === current);
  for (const a of articles) a.hidden = !current || a.id !== "n-" + current.dataset.n;
  if (current && scroll) current.scrollIntoView({ block: "nearest" });
  read.scrollTop = 0;
}
function render() {
  if (!rows.some((r) => r.classList.contains("archived"))) state.archived = false;
  const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
  const byScope = new Map(), byKind = new Map();
  let anyScope = 0;
  shown = [];
  for (const row of rows) {
    const base = words.every((w) => row.dataset.search.includes(w)) && state.archived === row.classList.contains("archived");
    const inScope = !state.scope || row.dataset.scope === state.scope, inKind = state.kinds.size === 0 || state.kinds.has(row.dataset.kind);
    if (base && inKind) { anyScope++; byScope.set(row.dataset.scope, (byScope.get(row.dataset.scope) || 0) + 1); }
    if (base && inScope) byKind.set(row.dataset.kind, (byKind.get(row.dataset.kind) || 0) + 1);
    row.hidden = !(base && inScope && inKind);
    if (!row.hidden) shown.push(row);
  }
  for (const item of items) {
    if (item.dataset.archived !== undefined) {
      const count = rows.filter((r) => r.classList.contains("archived")).length;
      item.querySelector(".num").textContent = count;
      item.hidden = document.getElementById("archived-sep").hidden = count === 0;
      item.setAttribute("aria-pressed", state.archived);
      continue;
    }
    const count = isScope(item) ? (item.dataset.scope === "*" ? anyScope : byScope.get(item.dataset.scope) || 0) : byKind.get(item.dataset.kind) || 0;
    item.querySelector(".num").textContent = count;
    item.classList.toggle("zero", count === 0);
    item.setAttribute("aria-pressed", isScope(item) ? (state.scope || "*") === item.dataset.scope : state.kinds.has(item.dataset.kind));
  }
  // The sidebar already says which scope and kind are picked. The list says only how many notes that is.
  where.textContent = shown.length + (shown.length === 1 ? " note" : " notes");
  // An empty list says so once, and offers the shortest way to notes: the other scopes when
  // the same search finds notes there, otherwise the list without the search and the kinds.
  where.hidden = shown.length === 0;
  none.hidden = shown.length > 0;
  const elsewhere = state.scope ? anyScope : 0;
  if (rows.length) none.firstChild.textContent = elsewhere ? "no notes match in this scope" : "no notes match";
  clear.dataset.way = elsewhere ? "scopes" : "filters";
  clear.textContent = elsewhere ? "show " + elsewhere + " in all scopes" : "clear filters";
  clear.hidden = !elsewhere && !q.value && state.kinds.size === 0;
  show(shown.includes(current) ? current : shown[0], true);
  paint();
}
function setScope(item) { state.scope = item.dataset.scope === "*" ? null : item.dataset.scope; }
/** Kinds add up: no kind picked shows every kind, and each picked kind adds its notes. */
function toggleKind(kind) { if (!state.kinds.delete(kind)) state.kinds.add(kind); }
/** A click or Enter on a sidebar item. A scope chosen this way is held. */
function activate(item) {
  if (isScope(item)) { setScope(item); held = state.scope; }
  else if (item.dataset.kind) toggleKind(item.dataset.kind);
  else state.archived = !state.archived;
  render();
}
/** system, light or dark. Only a pick that is not "system" is kept. */
function setTheme(theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme; else root.dataset.theme = theme;
  try { if (theme === "system") localStorage.removeItem("kb-theme"); else localStorage.setItem("kb-theme", theme); } catch {}
  themeButton.title = "Theme: " + theme + " (t)";
  themeButton.setAttribute("aria-label", themeButton.title);
}
const nextTheme = () => setTheme({ system: "light", light: "dark", dark: "system" }[document.documentElement.dataset.theme || "system"]);
const toggleHelp = () => (help.open ? help.close() : help.showModal());
function step(list, from, by) { return list[Math.max(0, Math.min(list.length - 1, list.indexOf(from) + by))]; }

// ---- changes: every one goes to the server, then the page loads again ----

// changing: changes made in this page that are still on the way. made: a count of every change
// this page started. The check for outside changes skips a turn when either says the page changed it.
let changing = 0, made = 0;
async function busy(run) {
  changing++; made++;
  try { return await run(); } finally { changing--; }
}
function api(method, path, body) {
  return busy(async () => {
    const response = await fetch(path, { method, headers: { "content-type": "application/json", "x-kb-token": TOKEN }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "kb answered " + response.status);
    return data;
  });
}
/** A key combination, one kbd per key: ⌘ and Z on a Mac, ctrl and Z elsewhere. */
const combo = (key) => el("span", { className: "keys" }, el("kbd", null, MAC ? "⌘" : "ctrl"), el("kbd", null, key));
function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props || {});
  node.append(...children);
  return node;
}
function toast(text, action, run, ms = 7000) {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const node = el("div", { className: "toast" }, text);
  if (action) node.append(el("button", { type: "button", onclick: run }, ...action));
  document.body.append(node);
  setTimeout(() => node.remove(), ms);
}
function closeForm() {
  if (!form) return;
  for (const child of form.parentElement.children) child.hidden = false;
  form.remove();
  form = null;
}
async function edit() {
  const host = article();
  if (!host || form || !host.querySelector("[data-act=edit]")) return;
  let note;
  try { note = await api("GET", "/api/notes/" + host.dataset.id); } catch (error) { return toast(error.message); }
  const select = (name, options, value) => el("select", { name }, ...options.map((o) => el("option", { value: o, selected: o === value }, o)));
  const error = el("span", { className: "error" });
  form = el("form", { className: "form" },
    el("label", null, "Title", el("input", { name: "title", value: note.title, autocomplete: "off" })),
    el("div", { className: "pair" }, el("label", null, "Kind", select("kind", kinds, note.kind)), el("label", null, "Confidence", select("confidence", ["high", "medium", "low"], note.confidence))),
    el("label", null, "Body", el("textarea", { name: "body", value: note.body, spellcheck: true })),
    el("div", { className: "end" }, error, el("button", { type: "button", onclick: closeForm }, "Cancel", el("kbd", null, "esc")), el("button", { type: "submit" }, "Save", combo(MAC ? "↵" : "enter"))));
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      await api("PUT", "/api/notes/" + note.id, data);
      await swapNote(note.id);
    } catch (problem) { error.textContent = problem.message; }
  };
  for (const child of host.children) child.hidden = true;
  host.append(form);
  form.elements.body.focus();
}
/**
 * Puts a changed note into the page in place, so a change does not load the whole page again and flicker.
 * The row and the article keep their elements, and so their place and their number.
 * The page takes the new version, so the check for changes does not load the page again for this change.
 */
async function swapNote(id) {
  const fresh = new DOMParser().parseFromString(await busy(async () => (await fetch("/")).text()), "text/html");
  const freshRow = [...fresh.querySelectorAll(".row")].find((r) => r.dataset.id === id);
  const freshArticle = [...fresh.querySelectorAll("article")].find((a) => a.dataset.id === id);
  const row = rows.find((r) => r.dataset.id === id), host = row && document.getElementById("n-" + row.dataset.n);
  if (!freshRow || !freshArticle || !row || !host) return location.reload();
  if (form) closeForm();
  row.className = freshRow.className;
  for (const key of ["kind", "search"]) row.dataset[key] = freshRow.dataset[key];
  row.innerHTML = freshRow.innerHTML;
  host.className = freshArticle.className;
  host.innerHTML = freshArticle.innerHTML;
  version = fresh.body.dataset.version;
  render();
}
// The note of the last archive, while its toast still offers the undo.
let undoId = null, undoTimer = 0;
const UNDO_MS = 5000;
/**
 * Archive the open note, or restore it with restore set. Each works only on a note it fits.
 * The note leaves the list in place, and a toast offers the undo of an archive.
 */
async function archive(restore = false) {
  const host = article();
  if (!host || form || !host.querySelector(restore ? "[data-act=restore]" : "[data-act=archive]")) return;
  const id = host.dataset.id;
  try {
    await api("POST", "/api/notes/" + id + (restore ? "/restore" : "/archive"));
  } catch (error) { return toast(error.message); }
  // The note leaves the list it is in: the live list for an archive, the archive for a restore.
  if (restore === state.archived) {
    // On a phone the drawer closes first, with the archived note still in it. The list changes after.
    if (PHONE.matches && reading()) {
      back();
      await new Promise((done) => setTimeout(done, CLOSE_MS));
    }
    // Land on the next note in the list, or the one before when this was the last.
    current = shown[shown.indexOf(current) + 1] || shown[shown.indexOf(current) - 1] || null;
  }
  await swapNote(id);
  if (restore) return;
  undoId = id;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => (undoId = null), UNDO_MS);
  toast("Archived.", ["Undo", combo("Z")], undo, UNDO_MS);
}
async function undo() {
  const id = undoId;
  if (!id) return;
  undoId = null;
  clearTimeout(undoTimer);
  document.querySelector(".toast")?.remove();
  try { await api("POST", "/api/notes/" + id + "/restore"); } catch (error) { return toast(error.message); }
  current = rows.find((r) => r.dataset.id === id) || current;
  await swapNote(id);
}

q.addEventListener("input", render);
document.addEventListener("click", (event) => {
  const copy = event.target.closest("[data-copy]"), act = event.target.closest("[data-act]"), item = event.target.closest(".item"), row = event.target.closest(".row");
  // The keys belong to the page, not to the button that took the click.
  if ((item || row || event.target.closest(".tool")) && document.activeElement !== q) document.activeElement.blur();
  if (event.target.closest("#keys")) toggleHelp();
  else if (event.target === clear) {
    if (clear.dataset.way === "scopes") { state.scope = held = null; cursor = scopeItem(); }
    else { q.value = ""; state.kinds.clear(); }
    render();
  }
  // A click outside the box lands on the dialog itself, which is the backdrop.
  else if (event.target === help) help.close();
  else if (event.target.closest("#theme")) nextTheme();
  else if (copy) {
    if (navigator.clipboard) navigator.clipboard.writeText(copy.dataset.copy);
    const id = copy.textContent;
    copy.textContent = "copied";
    setTimeout(() => (copy.textContent = id), 900);
  } else if (act) {
    pane = "list";
    paint();
    if (act.dataset.act === "edit") edit(); else archive(act.dataset.act === "restore");
  } else if (item) {
    pane = "rail"; cursor = item;
    activate(item);
  } else if (row) {
    pane = "list";
    show(row);
    paint();
    if (PHONE.matches) openNote(true);
  }
});
document.addEventListener("keydown", (event) => {
  const key = event.key;
  if (form) {
    if (key === "Escape") closeForm();
    else if (key === "Enter" && (MAC ? event.metaKey : event.ctrlKey)) form.requestSubmit();
    return;
  }
  // ⌘Z undoes an archive while its toast shows. In the filter it stays the field's own undo.
  if (key.toLowerCase() === "z" && (MAC ? event.metaKey : event.ctrlKey) && !event.shiftKey && undoId && document.activeElement !== q) {
    event.preventDefault();
    undo();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  // The open list of keys takes every key. The browser closes it on Escape.
  if (help.open) {
    if (key === "?") { event.preventDefault(); help.close(); }
    return;
  }
  if (key === "Escape" && reading()) { event.preventDefault(); back(); return; }
  if (document.activeElement === q) {
    if (key === "Escape") { q.value = ""; q.blur(); render(); }
    else if (key === "ArrowDown" || key === "Enter") { event.preventDefault(); q.blur(); pane = "list"; paint(); }
    return;
  }
  const by = key === "ArrowDown" || key === "j" ? 1 : key === "ArrowUp" || key === "k" ? -1 : 0;
  if (key === "/") { q.focus(); q.select(); }
  else if (key === "ArrowLeft" || key === "h") {
    if (pane === "list") { cursor = scopeItem(); held = state.scope; pane = "rail"; }
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
  // On a phone the note is in a drawer. Enter or space on a row opens it, as a tap does. In the open drawer space scrolls.
  else if ((key === "Enter" || key === " ") && pane === "list" && PHONE.matches && current && !reading()) openNote(true);
  // The note has no keys of its own. Space pages through it from the list.
  else if (key === " ") read.scrollBy({ top: (event.shiftKey ? -0.8 : 0.8) * read.clientHeight });
  else if (key === "e" && pane === "list") {
    // On a phone the form is in the drawer, so the drawer opens with it.
    if (PHONE.matches && current && !reading()) openNote(true);
    edit();
  }
  else if (key === "a" && pane === "list") archive();
  else if (key === "r" && pane === "list") archive(true);
  else if (key === "t") nextTheme();
  else if (key === "?") toggleHelp();
  else if (kinds[Number(key) - 1]) { toggleKind(kinds[Number(key) - 1]); render(); }
  else return;
  event.preventDefault();
  paint();
});

// Come back to the view in the address.
const view = new URLSearchParams(location.hash.slice(1));
if (items.some((i) => i.dataset.scope === view.get("scope"))) state.scope = view.get("scope");
for (const kind of (view.get("kind") || "").split(",")) if (kinds.includes(kind)) state.kinds.add(kind);
state.archived = view.has("archived") && rows.some((r) => r.classList.contains("archived"));
q.value = view.get("q") || "";
current = rows.find((r) => r.dataset.id === view.get("note")) || null;
if (view.get("pane") === "rail") pane = "rail";
addEventListener("popstate", () => { if (!(history.state && history.state.reading)) closeNote(); });
// A phone that turns wide shows the note in its pane, so the cover goes away.
PHONE.addEventListener("change", () => { if (!PHONE.matches) { closeNote(); unplace(); } });

setTheme(document.documentElement.dataset.theme || "system");
// The list of keys is written with the Mac key. Other systems undo with ctrl.
if (!MAC) for (const k of help.querySelectorAll("kbd")) if (k.textContent === "⌘") k.textContent = "ctrl";
cursor = scopeItem(); held = state.scope;
render();
// A reload, after an edit or a change by an agent, keeps the open note open.
if (view.has("read") && PHONE.matches) openNote(false);
// On a phone the scopes are one row that scrolls sideways. Start with the picked scope in view.
cursor.parentElement.scrollLeft = cursor.offsetLeft - cursor.parentElement.offsetLeft - (cursor.parentElement.clientWidth - cursor.offsetWidth) / 2;
// A note that an agent adds or changes shows without a manual reload. An open form is never thrown away.
setInterval(async () => {
  if (document.hidden || form || changing) return;
  const before = made;
  try {
    const now = await (await fetch("/api/state")).json();
    if (made === before && !changing && now.version !== version) location.reload();
  } catch {}
}, 3000);
`;

/** Changes whenever a note, the archive or a usage counter changes. The page reloads when it differs. */
export function storeVersion(store: Store): string {
  const strip = ({ path: _path, ...note }: StoredNote) => note;
  return Bun.hash(JSON.stringify([store.notes().map(strip), store.notes({ archived: true }).map(strip), [...store.usage()]])).toString(36);
}

/** `token` goes into the page, and the page sends it back with every change. */
export function renderHtml(store: Store, token: string): string {
  const usage = store.usage();
  const active = store.notes();
  const archived = store.notes({ archived: true });
  const scopes = [...new Set([...active, ...archived].map((n) => n.scope))].sort((a, b) => (a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b)));
  // The list reads scope by scope, live notes before archived ones, each in rank order.
  const notes = scopes.flatMap((scope) => [...rank(active.filter((n) => n.scope === scope), usage), ...rank(archived.filter((n) => n.scope === scope), usage)]);

  const item = (attrs: string, name: string, cls = "") => `<button class="item${cls}" ${attrs} aria-pressed="false" tabindex="-1">${name}<span class="num"></span></button>`;
  const SEP = '<hr class="sep">';
  // "all" and "global" are in every store. The line sets them apart from the repos, which change.
  const repos = scopes.filter((scope) => scope !== "global");
  // On a phone each strip is one row that scrolls sideways: the scopes, then the kinds and the archive.
  const rail = [
    '<h3>Scopes</h3>\n<div class="strip">',
    item('data-scope="*"', '<span class="name">all</span>'),
    ...(scopes.includes("global") ? [item('data-scope="global" title="global"', '<span class="name">global</span>')] : []),
    ...(repos.length > 0 ? [SEP] : []),
    ...repos.map((scope) => item(`data-scope="${esc(scope)}" title="${esc(scope)}"`, `<span class="name">${esc(scopeName(scope))}</span>`)),
    '</div>\n<div class="strip">\n<h3>Kinds</h3>',
    // The number is the key that turns the kind on or off.
    ...KINDS.map((kind, i) => item(`data-kind="${kind}"`, `<span class="dot"></span><span class="name">${kind}</span>${KEY(String(i + 1))}`, ` k-${kind}`)),
    // The archive is always in the page, so an archive made in the page can show it. It hides while it is empty.
    `<hr class="sep" id="archived-sep"${archived.length === 0 ? " hidden" : ""}>`,
    `<button class="item" data-archived aria-pressed="false" tabindex="-1"${archived.length === 0 ? " hidden" : ""}><span class="name">archived</span><span class="num">${archived.length}</span></button>`,
    "</div>",
  ].join("\n");

  const keys: [string[], string][] = [
    [["&uarr;", "&darr;"], "move"],
    [["&larr;", "&rarr;"], "sidebar or list"],
    [["enter"], "pick in the sidebar"],
    [["1", String(KINDS.length)], "kinds on or off"],
    [["/"], "filter"],
    [["space"], "scroll the note"],
    [["enter"], "open the note on a narrow screen, as space does"],
    [["e"], "edit"],
    [["a"], "archive"],
    [["r"], "restore an archived note"],
    [["⌘", "Z"], "undo an archive"],
    [["t"], "theme"],
    [["?"], "this list"],
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kb</title>
<script>try { const theme = localStorage.getItem("kb-theme"); if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme; } catch {}</script>
<style>${STYLE}</style>
</head>
<body data-pane="list" data-token="${esc(token)}" data-version="${storeVersion(store)}">
<div class="page">
<div class="behind" id="behind">
<aside class="pane rail">
<header><h1>kb</h1></header>
<nav>
${rail}
</nav>
<div class="foot"><button class="tool theme" id="theme" type="button"><svg class="system" viewBox="0 0 16 16"><rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.5"/><path d="M5.5 13.8h5M8 11v2.8"/></svg><svg class="light" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"/></svg><svg class="dark" viewBox="0 0 16 16"><path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z"/></svg></button><button class="tool" id="keys" type="button" title="Keys (?)" aria-label="Keys (?)"><svg viewBox="0 0 16 16"><rect x="1.5" y="3.8" width="13" height="8.4" rx="1.5"/><path d="M4.4 6.7h.01M6.8 6.7h.01M9.2 6.7h.01M11.6 6.7h.01M5.4 9.4h5.2"/></svg></button></div>
</aside>
<div class="pane list">
<div class="top"><div class="search"><input type="search" id="q" placeholder="Filter notes" autocomplete="off"><kbd>/</kbd></div><div class="where" id="where"></div></div>
<div id="rows">
${notes.map(rowHtml).join("\n")}
</div>
<div class="empty" id="none" hidden><span>${notes.length === 0 ? "the store has no notes yet" : "no notes match"}</span><button type="button" id="clear">clear filters</button></div>
</div>
</div>
<div class="scrim" id="scrim"></div>
<main class="pane read" id="read">
<div class="back" aria-hidden="true"></div>
${notes.map((note, n) => articleHtml(note, n, usage)).join("\n")}
</main>
</div>
<dialog class="help" id="help" aria-label="Keys">
<header><span>keys</span>${KEY("esc")}</header>
<dl>
${keys.map(([names, what]) => `<dt>${names.map(KEY).join(names[0] === "1" ? '<span class="num">to</span>' : "")}</dt><dd>${what}</dd>`).join("\n")}
</dl>
</dialog>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
