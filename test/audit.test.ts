import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, chromium } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyAudit, auditData, openAudits, proposeAudit, readAudit } from "../cli/audit.ts";
import { AGENT_ENV, auditPrompt, runState, startRun, waitRun } from "../cli/audit-run.ts";
import { buildContext } from "../cli/context.ts";
import { auditableScopes, rememberRepo, repoRoot } from "../cli/repos.ts";
import type { RepoInfo } from "../cli/scope.ts";
import { type Served, runningPort, serve } from "../cli/serve.ts";
import type { Store } from "../cli/store.ts";
import type { AuditCard } from "../cli/wire.ts";
import { choices, freed, steps, summary, toPicks } from "../web/src/lib/audit.ts";
import { MAIN, putNote, sh, tempDir, tempRepo, tempStore } from "./helpers.ts";

const SCOPE = "example.com/team/app";
const repo = (head = "abc1234"): RepoInfo => ({ scope: SCOPE, root: null, head });

/** A store in git with notes in the repo scope and in global. */
function setup(): Store {
  const store = tempStore();
  sh(store.home, "git", "init", "-q", "-b", "main");
  for (const id of ["v", "r", "keepme", "m", "m2", "t", "d", "ask"]) putNote(store, { id, scope: SCOPE, body: `body of ${id}` });
  putNote(store, { id: "g", body: "a global note" });
  putNote(store, { id: "other", scope: "example.com/team/other" });
  sh(store.home, "git", "add", "-A");
  sh(store.home, "git", "commit", "-q", "-m", "init");
  return store;
}

const ITEMS = [
  { id: "v", action: "verify", why: "still true", reason: "anchor-changed" },
  { id: "r", action: "rewrite", why: "drifted", body: "the new body" },
  { id: "m", action: "merge", why: "one idea", merge: ["m2"], body: "merged body" },
  { id: "t", action: "trash", why: "done" },
  { id: "d", action: "demote", why: "rare. Or trash it." },
  { id: "ask", action: "verify", why: "probably true" },
  { id: "keepme", action: "keep", why: "a rule", group: "conventions" },
  { id: "g", action: "verify", why: "still true" },
];

describe("kb audit propose", () => {
  test("saves the proposal for the scope, and the scope is open until Apply", () => {
    const store = setup();
    proposeAudit(store, { items: ITEMS }, repo());
    expect(readAudit(store, SCOPE)!.items.map((i) => i.id)).toEqual(ITEMS.map((i) => i.id));
    expect(openAudits(store)).toEqual([SCOPE]);
  });

  test.each([
    [{ items: [] }, "no items"],
    [{ items: [{ id: "nope", action: "verify", why: "x" }] }, 'no active note "nope"'],
    [{ items: [{ id: "other", action: "verify", why: "x" }] }, "belongs to example.com/team/other"],
    [{ items: [{ id: "v", action: "delete", why: "x" }] }, "action: must be one of"],
    [{ items: [{ id: "v", action: "verify" }] }, "why: required"],
    [{ items: [{ id: "v", action: "verify", why: "x".repeat(141) }] }, "why: 141 characters, at most 140"],
    [{ items: [{ id: "r", action: "rewrite", why: "x" }] }, "a rewrite needs the new title or body"],
    [{ items: [{ id: "v", action: "verify", why: "x", body: "new" }] }, "only a rewrite or a merge has new text"],
    [{ items: [{ id: "m", action: "merge", why: "x" }] }, "a merge names the notes"],
    [{ items: [{ id: "m", action: "merge", why: "x", merge: ["m"] }] }, 'no other active note "m"'],
    [{ items: [{ id: "v", action: "trash", why: "x", merge: ["m2"] }] }, "only a merge has it"],
    [{ items: [{ id: "m", action: "merge", why: "x", merge: ["m2"] }, { id: "m2", action: "trash", why: "x" }] }, "m2 is in the audit twice"],
  ])("refuses a bad proposal: %j", (input, message) => {
    const store = setup();
    expect(() => proposeAudit(store, input, repo())).toThrow(message);
    expect(readAudit(store, SCOPE)).toBeUndefined();
  });

  test("the command reads stdin, prints the page link, and kb audit shows what is open", () => {
    const store = setup();
    const dir = tempRepo({ remote: "https://example.com/team/app.git" });
    const env = { ...process.env, KB_HOME: store.home };
    const run = (args: string[], stdin?: string) => Bun.spawnSync(["bun", MAIN, ...args], { cwd: dir, env, stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    const proposed = run(["audit", "propose", "--json"], JSON.stringify({ items: [ITEMS[0]] }));
    expect(proposed.stderr.toString()).toBe("");
    expect(JSON.parse(proposed.stdout.toString())).toMatchObject({ scope: SCOPE, cards: 1, url: expect.stringContaining(`#audit=${encodeURIComponent(SCOPE)}`) });
    expect(run(["audit"]).stdout.toString()).toContain(`#audit=${encodeURIComponent(SCOPE)}`);
  });
});

describe("the audit page data", () => {
  test("shows each card with its note as it is now, and drops a card whose note left", () => {
    const store = setup();
    proposeAudit(store, { items: ITEMS }, repo());
    store.move(store.find("t")!, true, "2026-01-02T00:00:00Z");
    const data = auditData(store, SCOPE, "tok");
    expect(data.cards.map((c) => c.id)).toEqual(["v", "r", "m", "d", "ask", "keepme", "g"]);
    const card = (id: string) => data.cards.find((c) => c.id === id)!;
    expect(card("r").proposed).toEqual({ title: "Title of r", body: "the new body" });
    expect(card("m").merge!.map((n) => n.id)).toEqual(["m2"]);
    expect(card("v").note.body).toBe("body of v");
  });
});

describe("Apply", () => {
  test("makes every pick in one commit, and records the requests for the agent", () => {
    const store = setup();
    proposeAudit(store, { items: ITEMS }, repo("abc1234"));
    const before = Number(sh(store.home, "git", "rev-list", "--count", "HEAD"));
    const result = applyAudit(store, SCOPE, {
      picks: [
        { id: "v", action: "verify" },
        { id: "r", action: "rewrite" },
        { id: "m", action: "merge" },
        { id: "t", action: "trash" },
        { id: "d", action: "demote" },
        { id: "ask", action: "ask", request: "the code moved" },
        { id: "keepme", action: "keep" },
        { id: "g", action: "rewrite", title: "Your title", body: "your body" },
      ],
    });
    expect(result).toMatchObject({ verified: ["v"], rewritten: ["r", "g"], merged: [{ kept: "m", trashed: ["m2"] }], trashed: ["t"], demoted: ["d"], kept: ["keepme"], requests: [{ id: "ask", request: "the code moved" }] });
    expect(Number(sh(store.home, "git", "rev-list", "--count", "HEAD"))).toBe(before + 1);
    expect(sh(store.home, "git", "log", "-1", "--format=%s")).toBe(`kb: apply the audit of ${SCOPE}`);
    expect(store.find("v")!.verified_at_commit).toBe("abc1234");
    expect(store.find("r")!.body).toBe("the new body");
    expect(store.find("g")).toMatchObject({ title: "Your title", body: "your body" });
    // A global note has no commit of this repo to be verified at.
    expect(store.find("g")!.verified_at_commit).toBeUndefined();
    expect(store.find("m")).toMatchObject({ body: "merged body", supersedes: ["m2"] });
    expect(store.notes().map((n) => n.id)).not.toContain("m2");
    expect(store.notes().map((n) => n.id)).not.toContain("t");
    expect(store.find("d")!.indexed).toBe(false);
    expect(store.find("ask")!.body).toBe("body of ask");
    expect(openAudits(store)).toEqual([]);
    expect(() => applyAudit(store, SCOPE, { picks: [] })).toThrow("applied already");
  });

  test("a keep and an ask alone make no commit", () => {
    const store = setup();
    proposeAudit(store, { items: ITEMS.slice(5, 7) }, repo());
    applyAudit(store, SCOPE, { picks: [{ id: "ask", action: "ask", request: "why" }, { id: "keepme", action: "keep" }] });
    expect(sh(store.home, "git", "log", "-1", "--format=%s")).toBe("init");
  });

  test.each([
    [[{ id: "nope", action: "keep" }], "nope is not in this audit"],
    [[{ id: "v", action: "keep" }, { id: "v", action: "trash" }], "v is picked twice"],
    [[{ id: "v", action: "merge" }], "merge is not an action for v"],
    [[{ id: "ask", action: "ask" }], "say what is wrong with ask"],
    [[{ id: "v", action: "rewrite" }], "v has no new text"],
  ])("refuses bad picks before any change: %j", (picks, message) => {
    const store = setup();
    proposeAudit(store, { items: ITEMS }, repo());
    expect(() => applyAudit(store, SCOPE, { picks: [{ id: "t", action: "trash" }, ...picks] })).toThrow(message);
    expect(store.find("t")).toBeDefined();
    expect(sh(store.home, "git", "log", "-1", "--format=%s")).toBe("init");
    expect(readAudit(store, SCOPE)!.result).toBeUndefined();
  });

  test("refuses a pick for a note that left after the proposal", () => {
    const store = setup();
    proposeAudit(store, { items: ITEMS }, repo());
    store.move(store.find("m2")!, true, "2026-01-02T00:00:00Z");
    expect(() => applyAudit(store, SCOPE, { picks: [{ id: "m", action: "merge" }] })).toThrow("m2 is no longer an active note");
  });

  test("refuses a merge partner from another repo", () => {
    const store = setup();
    expect(() => proposeAudit(store, { items: [{ id: "m", action: "merge", why: "w", merge: ["other"] }] }, repo())).toThrow("other belongs to example.com/team/other");
  });

  test("a note edited after the proposal leaves the page, and Apply never writes the old text over the edit", () => {
    const store = setup();
    proposeAudit(store, { items: [ITEMS[1]!] }, repo());
    putNote(store, { id: "r", scope: SCOPE, body: "edited by the user" });
    expect(auditData(store, SCOPE, "tok").cards).toEqual([]);
    expect(openAudits(store)).toEqual([]);
    expect(() => applyAudit(store, SCOPE, { picks: [{ id: "r", action: "rewrite" }] })).toThrow("r changed after the agent proposed it");
    expect(store.find("r")!.body).toBe("edited by the user");
  });

  test("checks every resulting note before the first change, so a bad pick changes nothing", () => {
    const store = setup();
    proposeAudit(store, { items: ITEMS }, repo());
    expect(() => applyAudit(store, SCOPE, { picks: [{ id: "t", action: "trash" }, { id: "r", action: "rewrite", body: "  " }] })).toThrow("picks[1]: r:");
    expect(store.find("t")).toBeDefined();
    expect(readAudit(store, SCOPE)!.result).toBeUndefined();
  });

  test("puts a demoted note back in the index", () => {
    const store = setup();
    putNote(store, { id: "d", scope: SCOPE, indexed: false });
    proposeAudit(store, { items: [{ id: "d", action: "keep", why: "demoted earlier", group: "demoted" }] }, repo());
    expect(auditData(store, SCOPE, "tok").cards[0]!.note.indexed).toBe(false);
    expect(applyAudit(store, SCOPE, { picks: [{ id: "d", action: "index" }] }).indexed).toEqual(["d"]);
    expect(store.find("d")!.indexed).toBe(true);
  });

  test("refuses to put back a note that is in the index", () => {
    const store = setup();
    proposeAudit(store, { items: [ITEMS[0]!] }, repo());
    expect(() => applyAudit(store, SCOPE, { picks: [{ id: "v", action: "index" }] })).toThrow("index is not an action for v");
  });
});

const FAKE = join(import.meta.dir, "fixtures", "fake-audit-agent.sh");
const REMOTE = "https://example.com/team/app.git";

/** Run the CLI in a checkout of the repo, with the fake agent in place of claude. */
function cli(store: Store, dir: string, fake: string, args: string[]) {
  const out = tempDir();
  const r = Bun.spawnSync(["bun", MAIN, ...args], {
    cwd: dir,
    env: { ...process.env, KB_HOME: store.home, [AGENT_ENV]: FAKE, FAKE_AUDIT: fake, FAKE_OUT: out, FAKE_ITEMS: JSON.stringify({ items: [ITEMS[0]] }) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), out };
}

describe("kb audit starts an agent", () => {
  test("waits for the agent's proposal and prints the page link, and the agent's own kb audit only reports", () => {
    const store = setup();
    const dir = tempRepo({ remote: REMOTE });
    const r = cli(store, dir, "propose", ["audit"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`#audit=${encodeURIComponent(SCOPE)}`);
    expect(r.stdout).toContain("proposed 1 cards");
    expect(readAudit(store, SCOPE)!.items.map((i) => i.id)).toEqual(["v"]);
    expect(readFileSync(join(r.out, "status.txt"), "utf8")).toContain(`no audit for ${SCOPE}`);
    // The page can now start an audit of this repo too.
    expect(repoRoot(store, SCOPE)).toBe(dir);
  });

  test("an audit that waits for picks opens as it is, with no new agent", () => {
    const store = setup();
    const dir = tempRepo({ remote: REMOTE });
    proposeAudit(store, { items: [ITEMS[0]] }, repo());
    const r = cli(store, dir, "fail", ["audit"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("waits for your picks");
    expect(runState(store, SCOPE)).toBeUndefined();
  });

  test("says when the agent found nothing to change, and shows its last lines when it fails", () => {
    const store = setup();
    const dir = tempRepo({ remote: REMOTE });
    const nothing = cli(store, dir, "nothing", ["audit"]);
    expect(nothing.code).toBe(0);
    expect(nothing.stdout).toContain("found nothing to change");
    expect(nothing.stdout).toContain("every note still holds");
    const failed = cli(store, dir, "fail", ["audit"]);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain("boom");
  });

  test("starts one agent per repo: a second start while it runs returns the same run", async () => {
    const store = setup();
    const dir = tempRepo({ remote: REMOTE });
    const env = { [AGENT_ENV]: FAKE, FAKE_AUDIT: "slow", FAKE_OUT: tempDir(), KB_HOME: store.home };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      const first = startRun(store, SCOPE, dir);
      expect(runState(store, SCOPE)!.status).toBe("running");
      expect(startRun(store, SCOPE, dir).started).toBe(first.started);
      const runs = JSON.parse(readFileSync(store.statePath("audit-runs.json"), "utf8"));
      process.kill(-runs[SCOPE].pid, "SIGTERM");
      expect((await waitRun(store, SCOPE, 50)).status).toBe("failed");
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });

  test("outside a repo it refuses, since global notes are in every repo's audit", () => {
    const store = setup();
    const r = cli(store, tempDir(), "propose", ["audit"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("run it inside one");
  });

  test("a session start records where the repo is checked out", () => {
    const store = setup();
    const dir = tempRepo({ remote: REMOTE });
    buildContext(store, dir);
    expect(auditableScopes(store)).toEqual([SCOPE]);
    rememberRepo(store, "example.com/team/gone", join(tempDir(), "missing"));
    expect(auditableScopes(store)).toEqual([SCOPE]);
  });

  test("the headless prompt is the skill without its frontmatter, and starts with the sent-back notes", () => {
    const prompt = auditPrompt();
    expect(prompt).not.toContain("disable-model-invocation");
    expect(prompt).toContain("kb audit status");
    expect(prompt).toContain("kb audit propose");
  });
});

describe("the page link", () => {
  test("goes to the port the running kb serve recorded", async () => {
    const store = setup();
    const up = serve(store, { port: 0 });
    try {
      expect(await runningPort(store)).toBe(up.port);
    } finally {
      up.stop();
    }
    expect(await runningPort(store)).toBeUndefined();
  });
});

describe("the deck", () => {
  const card = (fields: Partial<AuditCard>): AuditCard => ({ id: "x", action: "verify", why: "w", note: { id: "x", title: "T", kind: "gotcha", scope: SCOPE, body: "b", uses: 0, indexed: true, place: "index" }, ...fields });

  test("puts loose cards first, then each group after its divider", () => {
    const cards = [card({ id: "a", group: "G" }), card({ id: "b" }), card({ id: "c", group: "G" })];
    expect(steps(cards).map((s) => (s.type === "card" ? s.card.id : `| ${s.group}`))).toEqual(["b", "| G", "a", "c"]);
  });

  test("offers demote only while notes reach no session, and never on open work", () => {
    expect(choices(card({}), false)).not.toContain("demote");
    expect(choices(card({}), true)).toContain("demote");
    expect(choices(card({ note: { ...card({}).note, kind: "open-work" } }), true)).not.toContain("demote");
    expect(choices(card({ merge: [card({}).note] }), true)).toEqual(["merge", "edit", "keep"]);
  });

  test("offers a demoted note a way back into the index, and no demote", () => {
    const demoted = card({ note: { ...card({}).note, indexed: false, place: "hidden" } });
    expect(choices(demoted, true)).toContain("index");
    expect(choices(demoted, true)).not.toContain("demote");
    expect(choices(card({}), true)).not.toContain("index");
  });

  test("counts the notes the picks take out of the index", () => {
    const cards = [card({}), card({}), card({ merge: [card({}).note, card({}).note] }), card({})];
    expect(freed(cards, [{ action: "trash" }, { action: "demote" }, { action: "merge" }, { action: "verify" }])).toBe(4);
  });

  test("counts no line for a note that had none, and one line less for a note put back", () => {
    const out = card({ note: { ...card({}).note, place: "hidden" } });
    const demoted = card({ note: { ...card({}).note, indexed: false, place: "hidden" } });
    expect(freed([out, demoted], [{ action: "trash" }, { action: "trash" }])).toBe(0);
    expect(freed([card({}), demoted], [{ action: "trash" }, { action: "index" }])).toBe(0);
  });

  test("sends every card to Apply, keep too, with the user's text", () => {
    const cards = [card({ id: "a" }), card({ id: "b" })];
    expect(toPicks(cards, [{ action: "keep" }, { action: "rewrite", body: "mine" }])).toEqual([
      { id: "a", action: "keep" },
      { id: "b", action: "rewrite", body: "mine" },
    ]);
    expect(summary(cards, [{ action: "keep" }, { action: "ask", request: "r" }]).map((g) => g.label)).toEqual(["sent back to the agent to rewrite", "keep"]);
  });
});

describe("the audit page in a browser", () => {
  let browser: Browser;
  let served: Served | undefined;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterEach(() => served?.stop());
  afterAll(async () => {
    await browser?.close();
  });

  test("keys pick, edit, undo and apply, and the store changes", async () => {
    const store = setup();
    proposeAudit(store, { items: [ITEMS[0], ITEMS[1], ITEMS[3], ITEMS[6]] }, repo());
    served = serve(store, { port: 0 });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(3000);
    await page.goto(`${served.url}#audit=${encodeURIComponent(SCOPE)}`);
    await page.locator('[data-card="v"]').waitFor();
    await page.keyboard.press("t"); // v: trash
    await page.locator('[data-card="r"]').waitFor();
    await page.keyboard.press("z"); // undo: back to v
    await page.locator('[data-card="v"]').waitFor();
    await page.keyboard.press("Enter"); // v: the agent's verify
    await page.locator('[data-card="r"]').waitFor();
    await page.keyboard.press("e");
    await page.getByLabel("Body").fill("typed in the page");
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.locator('[data-card="t"]').waitFor();
    // The next card starts with its keys, and no box keeps the focus.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    await page.keyboard.press("k"); // t: keep, not the agent's trash
    await page.getByRole("heading", { name: "conventions" }).waitFor();
    await page.keyboard.press("a"); // keep the whole group
    await page.getByRole("heading", { name: "Ready to apply" }).waitFor();
    expect(await page.locator("[data-card]").count()).toBe(0);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Applied" }).waitFor();
    expect(store.find("v")!.verified_at_commit).toBe("abc1234");
    expect(store.find("r")!.body).toBe("typed in the page");
    expect(store.find("t")).toBeDefined();
    expect(readAudit(store, SCOPE)!.result).toMatchObject({ verified: ["v"], rewritten: ["r"], kept: ["t", "keepme"] });
    await page.close();
  });

  test("the Audit button starts an agent for the project, then opens its cards", async () => {
    const store = setup();
    const dir = tempRepo({ remote: REMOTE });
    rememberRepo(store, SCOPE, dir);
    const env = { [AGENT_ENV]: FAKE, FAKE_AUDIT: "propose", FAKE_OUT: tempDir(), FAKE_ITEMS: JSON.stringify({ items: [ITEMS[0]] }), KB_HOME: store.home };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      served = serve(store, { port: 0 });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(15000);
      await page.goto(served.url);
      await page.locator(`[data-rail="scope:${SCOPE}"]`).click();
      await page.locator('[data-audit-start="start"]').click();
      await page.locator('[data-card="v"]').waitFor();
      expect(await page.evaluate(() => location.hash)).toBe(`#audit=${encodeURIComponent(SCOPE)}`);
      // Back on the notes, the button opens the audit that waits for the picks.
      await page.getByTitle("Back to the notes").click();
      await page.locator(`[data-rail="scope:${SCOPE}"]`).click();
      await page.locator('[data-audit-start="open"]').waitFor();
      await page.close();
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  }, 30000);

  test("the sidebar links to an open audit, and the page goes there and back", async () => {
    const store = setup();
    proposeAudit(store, { items: [ITEMS[0]] }, repo());
    served = serve(store, { port: 0 });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(3000);
    await page.goto(served.url);
    await page.getByRole("heading", { level: 1, name: "kb" }).waitFor();
    await page.locator(`[data-audit="${SCOPE}"]`).click();
    await page.locator('[data-card="v"]').waitFor();
    expect(await page.evaluate(() => location.hash)).toBe(`#audit=${encodeURIComponent(SCOPE)}`);
    await page.getByTitle("Back to the notes").click();
    await page.getByRole("heading", { level: 1, name: "kb" }).waitFor();
    await page.close();
  });
});
