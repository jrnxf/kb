/*SESSION*/
const RAW = /*RANK*/;
const SCOPE = "github.com/jrnxf/kb";
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmt = (n) => n.toLocaleString("en-US");
const KSHADE = [88, 68, 50, 34, 22];
const kshade = (k) => `color-mix(in oklab, var(--ink) ${KSHADE[k]}%, var(--sunk))`;
const mkNotes = (n) => Array.from({ length: n }, (_, i) => { const [k, g, blk, ll] = RAW.notes[i % RAW.notes.length];
  return { id: "n" + String(i).padStart(4, "0"), kind: RAW.kinds[k], k, scope: g ? "global" : SCOPE, blk, line: "x".repeat(ll), last_used: String(9999 - i).padStart(4, "0"), verified: "" }; });
const runOn = (notes, chars, lines) => session({ kinds: RAW.kinds, save: RAW.save, budgets: { chars, lines }, notes }, SCOPE);
const DEF = { chars: 8192, lines: 60 };
const onView = (el, fn, opts) => new IntersectionObserver(([e]) => fn(e.isIntersecting), opts).observe(el);
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };

// ---------- terminal: a session start, typed line by line ----------
const TERM = [
  ["c-p", "$ claude"],
  ["c-dim", "SessionStart hook ran: kb context"],
  ["", " "],
  ["c-h", "# kb: saved knowledge for github.com/acme/shop"],
  ["c-dim", "These notes come from earlier sessions. Each is below once: with its body, or as an index line."],
  ["c-dim", "A stated rule goes to an instruction file, not to kb. Save what you learn with `kb add`."],
  ["", " "],
  ["c-h", "## Index"],
  ["c-dim", "### github.com/acme/shop (3)"],
  ["c-i", "- the-seed-users-share-one-password-hash-so [gotcha] ...tests that log in must use it"],
  ["c-i", "- money-is-integer-cents-everywhere-never [convention] ...floats"],
  ["c-i", "- why-orders-use-soft-delete-refunds-need-the [decision] ...old row"],
  ["c-dim", "### global (2)"],
  ["c-i", "- pnpm-install-in-ci-needs-the-frozen-lockfile [gotcha]"],
  ["c-i", "- the-dev-proxy-drops-websocket-upgrades-so-hmr [gotcha] ...needs port 5173"],
  ["", " "],
  ["c-h", "## Notes (2 of 5, by rank)"],
  ["c-b", "### finish-the-webhook-retry-the-handler-still [open-work] ...drops a 409"],
  ["c-dim", "verified 2026-11-12 at 4f2c9e1 | confidence high | anchors: api/webhooks.ts"],
  ["", "Retries work for 5xx. A 409 from the ledger is still treated as final. Next: retry it once after 2 s."],
  ["c-b", "### run-migrations-before-seeding-or-the-seed [gotcha] ...script fails on a missing table"],
  ["", "On a fresh database, run `bun db:migrate` first. The error looks like a connection problem."],
  ["", " "],
  ["c-dim", "`kb show <id>` prints one note. `kb search <words>` searches every note."],
];
function mountTerm(root) {
  root.classList.add("term");
  root.innerHTML = `<div class="term-bar"><i></i><i></i><i></i></div><div class="term-body">${TERM.map(([c, t]) => `<div class="${c}"></div>`).join("")}</div>`;
  const rows = [...root.querySelectorAll(".term-body div")];
  rows.forEach((r, i) => (r.textContent = TERM[i][1]));
  if (reduce) { rows.forEach((r) => r.classList.add("on")); return; }
  let timer, i = 0;
  const tick = () => { if (i < rows.length) { rows[i++].classList.add("on"); timer = setTimeout(tick, i < 3 ? 380 : 90); } else timer = setTimeout(() => { rows.forEach((r) => r.classList.remove("on")); i = 0; timer = setTimeout(tick, 600); }, 6000); };
  onView(root, (v) => { clearTimeout(timer); if (v) tick(); });
}

// ---------- loop ----------
function mountLoop(root) {
  root.classList.add("loop");
  root.innerHTML = `<div class="orbit"></div><div class="hub"><b>every session</b>also after /clear, resume, compaction and fork</div>
    <div class="node n-top" data-a="270"><span class="when">during a session</span><b>I learn a fact</b><code>kb add</code></div>
    <div class="node n-right" data-a="0"><span class="when">before /clear</span><b>Checkpoint</b><code>/kb:checkpoint</code></div>
    <div class="node n-bottom" data-a="90"><span class="when">on disk</span><b>One file per note</b><code>~/.kb/notes/&lt;scope&gt;/</code></div>
    <div class="node n-left" data-a="180"><span class="when">session start</span><b>The packer</b><code>kb context</code></div>
    <div class="comet" aria-hidden="true"></div>`;
  const comet = root.querySelector(".comet"), orbit = root.querySelector(".orbit"), nodes = [...root.querySelectorAll(".node")];
  const t0 = performance.now(), PERIOD = 9000; let live = false, raf;
  function frame(now) {
    const ob = orbit.getBoundingClientRect(), lb = root.getBoundingClientRect();
    const cx = ob.left - lb.left + ob.width / 2, cy = ob.top - lb.top + ob.height / 2;
    const a = -90 + ((now - t0) % PERIOD) / PERIOD * 360, r = a * Math.PI / 180;
    comet.style.transform = `translate(${cx + ob.width / 2 * Math.cos(r)}px, ${cy + ob.height / 2 * Math.sin(r)}px)`;
    const deg = ((a % 360) + 360) % 360;
    for (const n of nodes) n.classList.toggle("on", Math.abs(((deg - +n.dataset.a + 540) % 360) - 180) < 26);
    if (live) raf = requestAnimationFrame(frame);
  }
  // Place the dot on the orbit once, so it never waits at the corner before the loop starts.
  requestAnimationFrame(() => frame(t0));
  if (reduce) return;
  onView(root, (v) => { live = v; cancelAnimationFrame(raf); if (v) raf = requestAnimationFrame(frame); });
}

// ---------- body to index line ----------
function mountMorph(root) {
  root.innerHTML = `<div class="mcard"><div class="mline"><span class="dim swap pre">### </span>run-migrations-before-seeding-or-the-seed <span class="dim">[gotcha]</span><span class="swap rest"></span></div>
    <div class="mfold"><div><div class="mbody"><span class="dim">verified 2026-11-12 at 4f2c9e1 | confidence high | anchors: scripts/seed.ts</span><br><span class="txt">The seed script inserts into tables that only the latest migration creates. On a fresh database, run \`bun db:migrate\` first. The error is "relation users does not exist". It looks like a connection problem, but it is not.</span></div></div></div></div>
    <div class="mfoot"><div class="msize"><span class="w-tag t-body tag">full body</span><div class="track"><div class="fill" style="background:var(--body)"></div></div><b>0 ch</b></div><button class="w-btn" type="button">Shrink to index line</button></div>`;
  const card = root.querySelector(".mcard"), pre = root.querySelector(".pre"), rest = root.querySelector(".rest");
  const fill = root.querySelector(".fill"), out = root.querySelector(".msize b"), tag = root.querySelector(".tag"), btn = root.querySelector("button");
  const id = "run-migrations-before-seeding-or-the-seed [gotcha]";
  const F = { pre: "### ", rest: " Run migrations before seeding, or the seed script fails on a missing table" }, S = { pre: "- ", rest: " ...script fails on a missing table" };
  const body = root.querySelector(".mbody").textContent.trim();
  const fullLen = (F.pre + id + F.rest).length + 1 + body.length, shortLen = (S.pre + id + S.rest).length;
  rest.textContent = F.rest; out.textContent = fmt(fullLen) + " ch";
  let isShort = false, shown = fullLen, auto = true, timer;
  const count = (to) => { if (reduce) { out.textContent = fmt(to) + " ch"; return; } const from = shown, t0 = performance.now();
    const step = (now) => { const p = Math.min(1, (now - t0) / 520), e = p < .5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2; shown = Math.round(from + (to - from) * e); out.textContent = fmt(shown) + " ch"; if (p < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); };
  function set(s) {
    isShort = s; card.classList.toggle("short", s); [pre, rest].forEach((e) => e.classList.add("fade"));
    setTimeout(() => { const v = s ? S : F; pre.textContent = v.pre; rest.textContent = v.rest; [pre, rest].forEach((e) => e.classList.remove("fade")); }, reduce ? 0 : 170);
    fill.style.transform = `scaleX(${(s ? shortLen : fullLen) / fullLen})`; fill.style.background = s ? "var(--index)" : "var(--body)";
    tag.className = "w-tag tag " + (s ? "t-index" : "t-body"); tag.textContent = s ? "index line" : "full body";
    btn.textContent = s ? "Grow back to full body" : "Shrink to index line"; count(s ? shortLen : fullLen);
  }
  btn.addEventListener("click", () => { auto = false; clearInterval(timer); set(!isShort); });
  if (!reduce) onView(card, (v) => { clearInterval(timer); if (v && auto) timer = setInterval(() => set(!isShort), 2800); });
}

// ---------- packer ----------
function mountPacker(root) {
  const tune = root.dataset.tune !== "off";
  root.innerHTML = `<div class="p-ctrl"><button class="w-btn primary play" type="button">Play</button><button class="w-btn next" type="button">Next step</button><div class="p-dots" aria-label="Steps"></div></div>
    <div class="p-cap" aria-live="polite"><span class="n"></span><b></b><p></p></div>
    <div class="p-field"></div><div class="p-legend"></div><div class="p-read">Point at a square to see that note's numbers.</div>
    <div class="p-bars"><span class="lab">characters</span><div class="cbar-wrap"><div class="cbar"><div class="seg s-idx"></div><div class="seg s-body"></div><div class="seg s-ghost"></div><div class="edge"></div></div></div><span class="v cval"></span>
    <span class="lab">index lines</span><div class="ticks"></div><span class="v lval"></span></div><div class="p-tally"></div>
    ${tune ? `<div class="p-tune"><label><span>Character budget <output class="oc"></output></span><input class="bc" type="range" min="2048" max="20480" step="256" value="8192"></label><label><span>Index line budget <output class="ol"></output></span><input class="bl" type="range" min="10" max="79" step="1" value="60"></label></div>` : ""}`;
  const $ = (s) => root.querySelector(s);
  const NOTES = mkNotes(RAW.notes.length), R = NOTES.length, field = $(".p-field");
  const cells = NOTES.map((n, i) => { const c = document.createElement("div"); c.className = "cell"; c.style.setProperty("--k", kshade(n.k)); c.dataset.i = i; field.appendChild(c); return c; });
  const shuffle = (() => { const a = [...Array(R).keys()]; let s = 7; for (let i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor(s / 233280 * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; })();
  let slotOf = shuffle.slice(), geo = { cols: 20, size: 20, gap: 4 };
  const place = (c, slot) => { const { cols, size, gap } = geo; c.style.transform = `translate(${(slot % cols) * (size + gap)}px, ${Math.floor(slot / cols) * (size + gap)}px)`; };
  function layout() { const W = field.clientWidth, cols = W < 520 ? 12 : 20, gap = W < 520 ? 3 : 5, size = Math.min(+(root.dataset.max || 46), Math.floor((W - gap * (cols - 1)) / cols)); geo = { cols, size, gap };
    const rows = Math.ceil(R / cols); field.style.height = rows * size + (rows - 1) * gap + "px"; cells.forEach((c, i) => { c.style.width = c.style.height = size + "px"; place(c, slotOf[i]); }); }
  const B = { ...DEF }; let S = runOn(NOTES, B.chars, B.lines), phase = 0, playing = false, ptimer;
  const lenRaw = (listed) => { const L = [`# kb: saved knowledge for ${SCOPE}`.length, SENT.length, RAW.save]; if (listed.length) { L.push(0, 8);
      for (const sec of ["global", SCOPE]) { const s = listed.filter((n) => n.scope === sec); if (!s.length) continue; L.push(`### ${sec} (${s.length})`.length, ...s.map((n) => n.line.length)); }
      const hid = R - listed.length; if (hid > 0) L.push(`${hid} more index ${hid === 1 ? "line is" : "lines are"} over the index budget.`.length); }
    L.push(0); const d = listed.length; L.push((d ? `${d} ${d === 1 ? "note is" : "notes are"} in the index only, because the bodies did not fit. `.length : 0) + "`kb show <id>` prints one note. `kb search <words>` searches every note.".length);
    return L.reduce((a, b) => a + b, 0) + L.length; };
  const steps = () => { const b = S.bodies.length, k = S.listed.length, hd = S.hidden.length, nx = S.ranked[b];
    return [
      { t: `${R} notes, in no order`, d: `Every note a session in this repo could load: ${NOTES.filter((n) => n.scope === "global").length} global notes and ${NOTES.filter((n) => n.scope !== "global").length} of its own. The shade shows the kind.` },
      { t: "Rank them", d: "Open work first, then gotchas, conventions, decisions and how-tos. Inside a kind, repo notes come first, then the most recently used." },
      { t: `Reserve ${k} index lines`, d: `The packer plans the index first: up to ${B.lines} lines, and fewer if they alone go over ${fmt(B.chars)} characters.` },
      { t: b ? `Give the top ${b === 1 ? "note its" : b + " notes their"} full ${b === 1 ? "body" : "bodies"}` : "No body fits", d: b ? "A note with a body takes no index line. So the line window slides down by one for each body." : "The index alone fills the character budget." },
      nx ? { t: "The next body does not fit", d: `It needs ${fmt(nx.blk)} characters. About ${fmt(Math.max(0, B.chars - S.chars))} are left, so the packer stops here.` } : { t: "Every body fits", d: "The character budget holds every note in full." },
      { t: hd ? `${hd} notes reach no session` : "Every note reaches the session", d: hd ? `They rank below the ${k}-line window. The agent still finds them with kb search.` : "The budgets are big enough for every note in this repo." }]; };
  const dots = $(".p-dots"); dots.innerHTML = Array.from({ length: 6 }, (_, i) => `<button type="button" aria-label="Step ${i + 1}" data-p="${i}"></button>`).join("");
  const ticks = $(".ticks");
  function render(p, instant) {
    phase = p; const st = !reduce && !instant, b = S.bodies.length, k = S.listed.length;
    slotOf = p === 0 ? shuffle.slice() : [...Array(R).keys()];
    cells.forEach((c, i) => { place(c, slotOf[i]);
      const cls = p === 2 ? (i < k ? "index" : "") : p >= 3 ? (i < b ? "body" : i < b + k ? "index" : p >= 5 ? "gone" : "") : "";
      c.classList.remove("body", "index", "gone", "ghost"); if (cls) c.classList.add(cls);
      c.style.transitionDelay = !st ? "0ms" : p === 1 ? `${(i % 20) * 12}ms, 0ms, 0ms` : `0ms, ${p === 2 ? i * 9 : p === 5 ? Math.max(0, i - b - k) * 18 : 0}ms, 0ms`; });
    const ghost = p === 4 && b < R; if (ghost) { void cells[b].offsetWidth; cells[b].classList.add("ghost"); }
    const bodyPart = b ? S.bodies.reduce((a, n) => a + n.blk + 1, 0) + `## Notes (${b} of ${R}, by rank)`.length + 1 : 0;
    const idx = p < 3 ? lenRaw(NOTES.slice(0, k)) : S.chars - bodyPart, tot = p < 3 ? idx : S.chars, pct = (x) => x / B.chars;
    $(".s-idx").style.transform = `scaleX(${p >= 2 ? Math.min(1, pct(idx)) : 0})`;
    $(".s-body").style.left = Math.min(100, pct(idx) * 100) + "%"; $(".s-body").style.transform = `scaleX(${p >= 3 ? Math.max(0, pct(tot - idx)) : 0})`;
    const g = $(".s-ghost"); g.style.left = Math.min(100, pct(tot) * 100) + "%"; g.style.width = pct(S.ranked[b]?.blk ?? 0) * 100 + "%"; g.style.opacity = ghost ? 1 : 0;
    $(".cval").textContent = `${fmt(p >= 2 ? tot : 0)} / ${fmt(B.chars)}`;
    if (ticks.children.length !== B.lines) ticks.innerHTML = "<i></i>".repeat(B.lines);
    [...ticks.children].forEach((t, i) => { t.style.transitionDelay = st && p === 2 ? `${i * 8}ms` : "0ms"; t.classList.toggle("on", p >= 2 && i < k); });
    $(".lval").textContent = `${p >= 2 ? k : 0} / ${B.lines}`;
    const s = steps()[p]; $(".p-cap .n").textContent = `Step ${p + 1} of 6`; $(".p-cap b").textContent = s.t; $(".p-cap p").textContent = s.d;
    [...dots.children].forEach((d, i) => d.setAttribute("aria-current", i === p));
    $(".p-tally").innerHTML = p >= 5 ? `<span class="w-tag t-body">${b} full ${b === 1 ? "body" : "bodies"}</span><span class="w-tag t-index">${k} index lines</span><span class="w-tag t-gone">${S.hidden.length} reach no session</span>` : "";
    $(".next").textContent = p >= 5 ? "Start over" : "Next step";
  }
  const DUR = [1600, 2200, 2400, 2600, 3000];
  const stop = () => { playing = false; clearTimeout(ptimer); $(".play").textContent = phase >= 5 ? "Replay" : "Play"; };
  const play = () => { stop(); playing = true; $(".play").textContent = "Pause"; const go = (p) => { render(p); if (p < 5) ptimer = setTimeout(() => go(p + 1), reduce ? 1800 : DUR[p]); else stop(); }; go(phase >= 5 ? 0 : phase); };
  $(".play").addEventListener("click", () => (playing ? stop() : play()));
  $(".next").addEventListener("click", () => { stop(); render(phase >= 5 ? 0 : phase + 1); });
  dots.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { stop(); render(+b.dataset.p); } });
  $(".p-legend").innerHTML = RAW.kinds.map((k, i) => `<span><i style="background:${kshade(i)}"></i>${k}</span>`).join("") + `<span><i style="background:var(--body)"></i>full body</span><span><i style="background:var(--index)"></i>index line</span><span><i style="background:var(--gone)"></i>reaches no session</span>`;
  field.addEventListener("pointerover", (e) => { const c = e.target.closest(".cell"); cells.forEach((x) => x.classList.remove("hot")); if (!c) return; const i = +c.dataset.i, n = NOTES[i]; c.classList.add("hot");
    const b = S.bodies.length, k = S.listed.length, tier = phase < 3 ? "" : i < b ? ", full body" : i < b + k ? `, index line ${i - b + 1}` : phase >= 5 ? ", reaches no session" : "";
    $(".p-read").textContent = `rank ${i + 1}, ${n.kind}, ${n.scope === "global" ? "global" : "repo"}, body ${fmt(n.blk)} ch, line ${n.line.length} ch${tier}`; });
  field.addEventListener("pointerleave", () => cells.forEach((x) => x.classList.remove("hot")));
  if (tune) { const bc = $(".bc"), bl = $(".bl");
    const t = () => { B.chars = +bc.value; B.lines = +bl.value; $(".oc").textContent = fmt(B.chars) + (B.chars === 8192 ? " (default)" : ""); $(".ol").textContent = B.lines + (B.lines === 60 ? " (default)" : ""); S = runOn(NOTES, B.chars, B.lines); };
    [bc, bl].forEach((el) => el.addEventListener("input", () => { stop(); t(); render(5, true); })); t(); }
  layout(); render(0, true); new ResizeObserver(layout).observe(field);
  let played = false; onView(field, (v) => { if (v && !played) { played = true; setTimeout(play, 400); } }, { threshold: 0.4 });
}

// ---------- growth: the store grows, the session does not ----------
function mountGrowth(root) {
  root.innerHTML = `<div class="g-box"><canvas></canvas></div>
    <label style="display:grid;gap:6px;font-size:13.5px;color:var(--mute)"><span style="display:flex;justify-content:space-between">Notes in the store <output style="color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums"></output></span><input type="range" min="10" max="800" step="1" value="10"></label>
    <div class="g-stats"><div class="g-stat">in the store<b class="gs">0</b><div class="track"><div class="fill gsf" style="background:var(--mute)"></div></div></div>
    <div class="g-stat">in each session<b class="gc">0</b><div class="track"><div class="fill gcf" style="background:var(--index)"></div></div></div></div>`;
  const cv = root.querySelector("canvas"), inp = root.querySelector("input"), out = root.querySelector("output"), ctx = cv.getContext("2d");
  const ALL = mkNotes(800), MAXC = ALL.reduce((a, n) => a + n.blk, 0);
  let col = {};
  const readCol = () => { const cs = getComputedStyle(root); col = { body: cs.getPropertyValue("--body").trim(), index: cs.getPropertyValue("--index").trim(), gone: cs.getPropertyValue("--gone").trim(), ink: cs.getPropertyValue("--mute").trim() }; };
  function draw(n) {
    n = Math.round(n); const notes = ALL.slice(0, n), S = runOn(notes, DEF.chars, DEF.lines);
    const tier = new Map(); S.bodies.forEach((x) => tier.set(x, "body")); S.listed.forEach((x) => tier.set(x, "index")); S.hidden.forEach((x) => tier.set(x, "gone"));
    const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const pad = 14, cell = Math.max(3, Math.floor(Math.sqrt(((W - 2 * pad) * (H - 2 * pad)) / n))), cols = Math.max(1, Math.floor((W - 2 * pad) / cell)), gap = cell > 8 ? 2 : 1;
    S.ranked.forEach((x, i) => { ctx.fillStyle = col[tier.get(x)]; ctx.globalAlpha = tier.get(x) === "gone" ? 0.6 : 1; ctx.fillRect(pad + (i % cols) * cell, pad + Math.floor(i / cols) * cell, cell - gap, cell - gap); });
    ctx.globalAlpha = 1;
    const store = notes.reduce((a, x) => a + x.blk, 0);
    out.textContent = fmt(n); root.querySelector(".gs").textContent = fmt(store) + " ch"; root.querySelector(".gc").textContent = fmt(S.chars) + " ch";
    root.querySelector(".gsf").style.transform = `scaleX(${store / MAXC})`; root.querySelector(".gcf").style.transform = `scaleX(${S.chars / MAXC})`;
  }
  readCol(); draw(10);
  inp.addEventListener("input", () => draw(+inp.value));
  new ResizeObserver(() => draw(+inp.value)).observe(cv);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readCol(); draw(+inp.value); });
  let ran = false;
  onView(root, (v) => { if (!v || ran) return; ran = true; if (reduce) { inp.value = 400; draw(400); return; }
    const t0 = performance.now(); const step = (now) => { const p = Math.min(1, (now - t0) / 3200), e = 1 - (1 - p) ** 3, n = 10 + e * 390; inp.value = n; draw(n); if (p < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); }, { threshold: 0.5 });
}

const MOUNT = { term: mountTerm, loop: mountLoop, morph: mountMorph, packer: mountPacker, growth: mountGrowth };
document.querySelectorAll("[data-w]").forEach((el) => { el.classList.add("w"); MOUNT[el.dataset.w](el); });
