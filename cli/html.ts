// `kb html`: one self-contained page that shows the whole store. No server, no script dependency.

import { join } from "node:path";
import { rank } from "./context.ts";
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

/** A repo scope is host/owner/name. Show owner/name for GitHub, and link to the repo. */
function scopeLabel(scope: string): string {
  const parts = scope.split("/");
  if (parts.length < 2 || !parts[0]!.includes(".")) return esc(scope);
  const label = parts[0] === "github.com" ? parts.slice(1).join("/") : scope;
  return `<a href="https://${esc(scope)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
}

function noteHtml(note: StoredNote, usage: Map<string, Usage>): string {
  const used = usage.get(note.id);
  const meta = [
    `verified ${note.last_verified.slice(0, 10)}${note.verified_at_commit ? ` at ${esc(note.verified_at_commit)}` : ""}`,
    `confidence ${note.confidence}`,
    `${used?.uses ?? 0} ${used?.uses === 1 ? "use" : "uses"}${used?.last_used ? `, last ${used.last_used.slice(0, 10)}` : ""}`,
  ];
  if (!note.indexed) meta.push("not indexed");
  if (note.promoted_to) meta.push(`promoted to ${esc(note.promoted_to)}`);
  const anchors = note.anchors.length > 0 ? `<p class="anchors">${note.anchors.map((a) => `<code>${esc(a)}</code>`).join(" ")}</p>` : "";
  const haystack = esc(`${note.id} ${note.title} ${note.kind} ${note.scope} ${note.body}`.toLowerCase());
  return `<details class="note${note.archived ? " archived" : ""}" data-search="${haystack}">
<summary><span class="kind k-${note.kind}">${note.kind}</span><span class="title">${esc(note.title)}</span><span class="id">${esc(note.id)}</span></summary>
<div class="content"><p class="meta">${meta.join(" · ")}</p>${anchors}<div class="body">${renderBody(note.body)}</div></div>
</details>`;
}

export function renderHtml(store: Store): string {
  const usage = store.usage();
  const active = store.notes();
  const archived = store.notes({ archived: true });
  const all = [...active, ...archived];
  const scopes = [...new Set(all.map((n) => n.scope))].sort((a, b) => (a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b)));

  const sections = scopes
    .map((scope) => {
      const live = rank(active.filter((n) => n.scope === scope), usage);
      const old = rank(archived.filter((n) => n.scope === scope), usage);
      return `<section${live.length === 0 ? ' class="only-archived"' : ""}>
<h2>${scopeLabel(scope)} <span class="count">${live.length}</span></h2>
${[...live, ...old].map((n) => noteHtml(n, usage)).join("\n")}
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kb</title>
<style>
:root { --bg:#fbfbfa; --fg:#1c1c1a; --muted:#6f6f6a; --line:#e4e4df; --card:#fff; --accent:#2f5bd8; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --fg:#ececea; --muted:#96968f; --line:#2c2c2a; --card:#1c1c1b; --accent:#8aa6ff; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width:820px; margin:0 auto; padding:32px 16px 80px; }
header { display:flex; align-items:baseline; gap:12px; margin-bottom:16px; }
h1 { font-size:22px; margin:0; letter-spacing:-0.01em; }
.sub { color:var(--muted); font-size:13px; }
.bar { position:sticky; top:0; z-index:1; display:flex; gap:12px; align-items:center; padding:10px 0; background:var(--bg); }
input[type=search] { flex:1; min-width:0; height:36px; padding:0 12px; font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:8px; }
input[type=search]:focus { outline:2px solid var(--accent); outline-offset:-1px; }
label { color:var(--muted); font-size:13px; white-space:nowrap; display:flex; gap:6px; align-items:center; }
h2 { font-size:13px; font-weight:600; color:var(--muted); margin:28px 0 8px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
h2 a { color:inherit; text-decoration:none; }
h2 a:hover { color:var(--accent); text-decoration:underline; }
.count { font-weight:400; margin-left:4px; }
.note { background:var(--card); border:1px solid var(--line); border-radius:8px; margin-bottom:6px; }
summary { display:flex; gap:10px; align-items:baseline; padding:9px 12px; cursor:pointer; list-style:none; }
summary::-webkit-details-marker { display:none; }
.title { flex:1; min-width:0; font-weight:500; }
.id { color:var(--muted); font:12px ui-monospace, SFMono-Regular, Menlo, monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:40%; }
.kind { flex:none; width:82px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }
.k-open-work { color:#c2410c; } .k-gotcha { color:#b91c1c; } .k-convention { color:#15803d; } .k-decision { color:#6d28d9; } .k-how-to { color:#0369a1; }
@media (prefers-color-scheme: dark) { .k-open-work { color:#fb923c; } .k-gotcha { color:#f87171; } .k-convention { color:#4ade80; } .k-decision { color:#c4b5fd; } .k-how-to { color:#7dd3fc; } }
.content { padding:0 12px 12px 104px; }
.meta, .anchors { color:var(--muted); font-size:12.5px; margin:0 0 6px; }
.anchors { margin-bottom:10px; }
.body > :first-child { margin-top:6px; } .body > :last-child { margin-bottom:0; }
code { font:12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:1px 4px; }
pre { overflow-x:auto; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 12px; }
pre code { border:0; padding:0; background:none; }
.archived { opacity:0.6; }
body:not(.show-archived) .archived, body:not(.show-archived) .only-archived { display:none; }
.hidden { display:none !important; }
.empty { color:var(--muted); margin-top:32px; }
@media (max-width:560px) { .content { padding-left:12px; } .id { display:none; } }
</style>
</head>
<body>
<main>
<header><h1>kb</h1><span class="sub">${active.length} ${active.length === 1 ? "note" : "notes"} in ${new Set(active.map((n) => n.scope)).size} ${new Set(active.map((n) => n.scope)).size === 1 ? "scope" : "scopes"}, ${archived.length} archived</span></header>
<div class="bar"><input type="search" id="q" placeholder="Filter notes" autofocus><label><input type="checkbox" id="arch"> Show archived</label></div>
${sections || '<p class="empty">The store has no notes yet.</p>'}
</main>
<script>
const q = document.getElementById("q"), arch = document.getElementById("arch");
function apply() {
  const words = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
  document.body.classList.toggle("show-archived", arch.checked);
  for (const section of document.querySelectorAll("section")) {
    let shown = 0;
    for (const note of section.querySelectorAll(".note")) {
      const match = words.every((w) => note.dataset.search.includes(w));
      note.classList.toggle("hidden", !match);
      if (match && (arch.checked || !note.classList.contains("archived"))) shown++;
    }
    section.classList.toggle("hidden", shown === 0);
  }
}
q.addEventListener("input", apply);
arch.addEventListener("change", apply);
</script>
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
