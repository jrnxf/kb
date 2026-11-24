/*SESSION*/
const RAW = /*RANK*/;
/*STORE*/
const { fmt, kshade, mkNotes, runOn, tiersOf, steps, legend, tally, packerCap, packerBars, briefCount, budgetCount, GROWTH_START, GROWTH_MAX, growthAt } = demo(RAW, session);
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const onView = (el, fn, opts) => new IntersectionObserver(([e]) => fn(e.isIntersecting), opts).observe(el);

// ---------- terminal: a session start, typed line by line ----------
// The rows are in the HTML, so the whole session start reads without JavaScript.
function mountTerm(root) {
  const rows = [...root.querySelectorAll(".term-body div")];
  if (reduce) return;
  // The rows hide only from here on, so a page where this code never runs (or a print, or a crawler) shows them all.
  // If the observer has not reported within 3 s, the rows show again.
  root.classList.add("term-anim");
  let timer, i = 0;
  const giveUp = setTimeout(() => root.classList.remove("term-anim"), 3000);
  const tick = () => { if (i < rows.length) { rows[i++].classList.add("on"); timer = setTimeout(tick, i < 3 ? 380 : 90); } else timer = setTimeout(() => { rows.forEach((r) => r.classList.remove("on")); i = 0; timer = setTimeout(tick, 600); }, 6000); };
  onView(root, (v) => { clearTimeout(giveUp); clearTimeout(timer); if (v) tick(); });
}

// ---------- loop ----------
function mountLoop(root) {
  // The orbit and the four steps are in the HTML. Only the dot that goes round needs JavaScript.
  root.insertAdjacentHTML("beforeend", `<div class="comet" aria-hidden="true"></div>`);
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
  // The note is in the HTML. The size and the button need JavaScript, so they show only with it.
  root.querySelector(".mfoot").hidden = false;
  const card = root.querySelector(".mcard"), pre = root.querySelector(".pre"), rest = root.querySelector(".rest");
  const fill = root.querySelector(".fill"), out = root.querySelector(".msize b"), tag = root.querySelector(".tag"), btn = root.querySelector("button");
  const id = "run-migrations-before-seeding-or-the-seed-script [gotcha]";
  const F = { pre: "### ", rest: " Run migrations before seeding, or the seed script fails on a missing table" }, S = { pre: "- ", rest: " ...fails on a missing table" };
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

// ---------- the header meter: what kb loads at session start, out of the hard budget. It follows the budget slider. ----------
const meterEl = document.querySelector(".meter");
function meter(S, notesBudget) {
  // The budget card header says the same numbers.
  const bn = document.querySelector(".bud-notes"), bc = document.querySelector(".bud-count");
  if (bn) bn.textContent = fmt(notesBudget);
  if (bc) bc.textContent = budgetCount(S);
  // The session start header and the turn after /clear say the same number as the meter.
  for (const el of document.querySelectorAll(".live-chars")) el.textContent = fmt(S.chars);
  if (!meterEl) return;
  meterEl.querySelector(".mv").textContent = `${fmt(S.chars)} / ${fmt(S.budget)}`;
  meterEl.style.setProperty("--fill", S.chars / S.budget);
}

// ---------- packer ----------
function mountPacker(root) {
  const tune = root.dataset.tune !== "off";
  const NOTES = mkNotes(RAW.notes.length), R = NOTES.length, S0 = runOn(NOTES, RAW.chars);
  root.innerHTML = `<div class="p-ctrl"><button class="w-btn primary play" type="button">Play</button><button class="w-btn next" type="button">Next step</button><div class="p-dots" aria-label="Steps"></div></div>
    <div aria-live="polite">${packerCap(steps(S0, NOTES, RAW.chars)[0], 0)}</div>
    <div class="p-field"></div><div class="p-legend"></div><div class="p-read">Point at a square to see that note's numbers.</div>
    <div class="p-bars">${packerBars(S0, 0)}</div><div class="p-tally"></div>
    ${tune ? `<div class="p-tune"><label><span>Character budget for the notes <output class="oc"></output></span><input class="bc" type="range" min="2000" max="8400" step="100" value="${RAW.chars}"></label></div>` : ""}`;
  const $ = (s) => root.querySelector(s);
  const field = $(".p-field");
  const cells = NOTES.map((n, i) => { const c = document.createElement("div"); c.className = "cell"; c.style.setProperty("--k", kshade(n.k)); c.dataset.i = i; field.appendChild(c); return c; });
  const shuffle = (() => { const a = [...Array(R).keys()]; let s = 7; for (let i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor(s / 233280 * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; })();
  let slotOf = shuffle.slice(), geo = { cols: 20, size: 20, gap: 4 };
  const place = (c, slot) => { const { cols, size, gap } = geo; c.style.transform = `translate(${(slot % cols) * (size + gap)}px, ${Math.floor(slot / cols) * (size + gap)}px)`; };
  function layout() { const W = field.clientWidth, cols = W < 520 ? 12 : 20, gap = W < 520 ? 3 : 5, size = Math.min(+(root.dataset.max || 46), Math.floor((W - gap * (cols - 1)) / cols)); geo = { cols, size, gap };
    const rows = Math.ceil(R / cols); field.style.height = rows * size + (rows - 1) * gap + "px"; cells.forEach((c, i) => { c.style.width = c.style.height = size + "px"; place(c, slotOf[i]); }); }
  const B = { chars: RAW.chars }; let S = S0, tier = tiersOf(S), phase = 0, playing = false, ptimer;
  // The rank does not depend on the budget, so each note keeps its place while the budget moves.
  const rankOf = NOTES.map((n) => S.ranked.indexOf(n));
  // The step at which a note shows what it gets.
  const FROM = { body: 2, wait: 3, index: 4, gone: 5 };
  const dots = $(".p-dots"); dots.innerHTML = Array.from({ length: 6 }, (_, i) => `<button type="button" aria-label="Step ${i + 1}" data-p="${i}"></button>`).join("");
  function render(p, instant) {
    phase = p; const st = !reduce && !instant;
    slotOf = p === 0 ? shuffle.slice() : rankOf.slice();
    cells.forEach((c, i) => { place(c, slotOf[i]);
      const t = tier.get(NOTES[i]), r = rankOf[i];
      c.classList.remove("body", "index", "gone", "wait"); if (p >= FROM[t]) c.classList.add(t);
      c.style.transitionDelay = !st ? "0ms" : p === 1 ? `${(r % 20) * 12}ms, 0ms, 0ms` : `0ms, ${p === FROM[t] && (t === "index" || t === "gone") ? Math.min(r, 80) * 9 : 0}ms, 0ms`; });
    const by = S.by, tot = p >= 4 ? S.chars : p >= 2 ? by.fixed + by.briefs : 0, pct = (x) => Math.min(1, x / S.budget);
    $(".s-fix").style.width = (p >= 2 ? pct(by.fixed) * 100 : 0) + "%";
    $(".s-body").style.left = pct(by.fixed) * 100 + "%"; $(".s-body").style.transform = `scaleX(${p >= 2 ? pct(by.briefs) : 0})`;
    $(".s-idx").style.left = pct(by.fixed + by.briefs) * 100 + "%"; $(".s-idx").style.transform = `scaleX(${p >= 4 ? pct(by.index) : 0})`;
    $(".cval").textContent = `${fmt(tot)} / ${fmt(S.budget)}`;
    const s = steps(S, NOTES, B.chars)[p]; $(".p-cap .n").textContent = `Step ${p + 1} of 6`; $(".p-cap b").textContent = s.t; $(".p-cap p").textContent = s.d;
    [...dots.children].forEach((d, i) => d.setAttribute("aria-current", i === p));
    $(".p-tally").innerHTML = p >= 5 ? tally(S) : "";
    $(".next").textContent = p >= 5 ? "Start over" : "Next step";
  }
  const DUR = [1600, 2200, 2400, 2600, 3000];
  const stop = () => { playing = false; clearTimeout(ptimer); $(".play").textContent = phase >= 5 ? "Replay" : "Play"; };
  const play = () => { stop(); playing = true; $(".play").textContent = "Pause"; const go = (p) => { render(p); if (p < 5) ptimer = setTimeout(() => go(p + 1), reduce ? 1800 : DUR[p]); else stop(); }; go(phase >= 5 ? 0 : phase); };
  $(".play").addEventListener("click", () => (playing ? stop() : play()));
  $(".next").addEventListener("click", () => { stop(); render(phase >= 5 ? 0 : phase + 1); });
  dots.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { stop(); render(+b.dataset.p); } });
  $(".p-legend").innerHTML = legend();
  const GETS = { body: (n) => `, brief ${fmt(n.brief)} ch`, index: (n) => `, index line ${n.line.length} ch`, wait: () => ", waits for its trigger", gone: () => ", reaches no session" };
  field.addEventListener("pointerover", (e) => { const c = e.target.closest(".cell"); cells.forEach((x) => x.classList.remove("hot")); if (!c) return; const i = +c.dataset.i, n = NOTES[i], t = tier.get(n); c.classList.add("hot");
    $(".p-read").textContent = `rank ${rankOf[i] + 1}, ${n.kind}, ${n.scope === "global" ? "global" : "repo"}, note ${fmt(n.blk)} ch${phase >= FROM[t] ? GETS[t](n) : ""}`; });
  field.addEventListener("pointerleave", () => cells.forEach((x) => x.classList.remove("hot")));
  if (tune) { const bc = $(".bc");
    const t = () => { B.chars = +bc.value; $(".oc").textContent = fmt(B.chars) + (B.chars === RAW.chars ? " (default)" : ""); S = runOn(NOTES, B.chars); tier = tiersOf(S); meter(S, B.chars); };
    bc.addEventListener("input", () => { stop(); t(); render(5, true); }); t(); }
  layout(); render(0, true); new ResizeObserver(layout).observe(field);
  let played = false; onView(field, (v) => { if (v && !played) { played = true; setTimeout(play, 400); } }, { threshold: 0.4 });
}

// ---------- growth: the store grows, the session does not ----------
function mountGrowth(root) {
  // The build wrote the widget at its first state, in its final size. The canvas and the slider start to work here.
  const cv = root.querySelector("canvas"), inp = root.querySelector("input"), out = root.querySelector("output"), ctx = cv.getContext("2d");
  const MAXC = GROWTH_MAX;
  inp.disabled = false;
  let col = {};
  const readCol = () => { const cs = getComputedStyle(root); col = { body: cs.getPropertyValue("--body").trim(), index: cs.getPropertyValue("--index").trim(), gone: cs.getPropertyValue("--gone").trim(), wait: cs.getPropertyValue("--mute").trim() }; };
  function draw(n) {
    n = Math.round(n); const { notes, S, store } = growthAt(n), tier = tiersOf(S);
    const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const pad = 14, cell = Math.max(3, Math.floor(Math.sqrt(((W - 2 * pad) * (H - 2 * pad)) / n))), cols = Math.max(1, Math.floor((W - 2 * pad) / cell)), gap = cell > 8 ? 2 : 1;
    S.ranked.forEach((x, i) => { ctx.fillStyle = col[tier.get(x)]; ctx.globalAlpha = { gone: 0.6, wait: 0.4 }[tier.get(x)] ?? 1; ctx.fillRect(pad + (i % cols) * cell, pad + Math.floor(i / cols) * cell, cell - gap, cell - gap); });
    ctx.globalAlpha = 1;
    out.textContent = fmt(n); root.querySelector(".gs").textContent = fmt(store) + " ch"; root.querySelector(".gc").textContent = fmt(S.chars) + " ch";
    root.querySelector(".gsf").style.transform = `scaleX(${store / MAXC})`; root.querySelector(".gcf").style.transform = `scaleX(${S.chars / MAXC})`;
  }
  readCol(); draw(GROWTH_START);
  inp.addEventListener("input", () => draw(+inp.value));
  new ResizeObserver(() => draw(+inp.value)).observe(cv);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readCol(); draw(+inp.value); });
  let ran = false;
  onView(root, (v) => { if (!v || ran) return; ran = true; if (reduce) { inp.value = 400; draw(400); return; }
    const t0 = performance.now(); const step = (now) => { const p = Math.min(1, (now - t0) / 3200), e = 1 - (1 - p) ** 3, n = 10 + e * 390; inp.value = n; draw(n); if (p < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); }, { threshold: 0.5 });
}

const MOUNT = { term: mountTerm, loop: mountLoop, morph: mountMorph, packer: mountPacker, growth: mountGrowth };
document.querySelectorAll("[data-w]").forEach((el) => { el.classList.add("w"); MOUNT[el.dataset.w](el); });
