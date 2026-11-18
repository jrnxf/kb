import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, chromium } from "playwright";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyAudit, auditData, openAudits, proposeAudit, readAudit } from "../cli/audit.ts";
import { AGENT_ENV, auditPrompt, runState, startRun, waitRun } from "../cli/audit-run.ts";
import { buildContext, contextFor } from "../cli/context.ts";
import { auditableScopes, rememberRepo, repoRoot } from "../cli/repos.ts";
import type { RepoInfo } from "../cli/scope.ts";
import { type Served, runningPort, serve } from "../cli/serve.ts";
import type { Store } from "../cli/store.ts";
import type { AuditCard } from "../cli/wire.ts";
import { changes, choiceForKey, choiceLabel, choices, freed, steps, summary, toPicks } from "../web/src/lib/audit.ts";
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
  { id: "v", action: "keep", checked: true, why: "still true", reason: "anchor-changed" },
  { id: "r", action: "rewrite", why: "drifted", body: "the new body" },
  { id: "m", action: "merge", why: "one idea", merge: ["m2"], body: "merged body" },
  { id: "t", action: "trash", why: "done" },
  { id: "d", action: "keep", why: "could not check it" },
  { id: "ask", action: "keep", why: "probably true" },
  { id: "keepme", action: "keep", why: "a rule", group: "conventions" },
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
    [{ items: [{ id: "nope", action: "keep", why: "x" }] }, 'no active note "nope"'],
    [{ items: [{ id: "other", action: "keep", why: "x" }] }, "belongs to example.com/team/other"],
    [{ items: [{ id: "g", action: "keep", why: "x" }] }, "belongs to global. Run the global audit outside any repo"],
    [{ items: [{ id: "v", action: "archive", why: "x" }] }, "action: must be one of"],
    [{ items: [{ id: "v", action: "trash", checked: true, why: "x" }] }, "checked: only a keep has it"],
    [{ items: [{ id: "v", action: "keep", checked: "yes", why: "x" }] }, "checked: must be true or false"],
    [{ items: [{ id: "v", action: "delete", why: "x" }] }, "action: must be one of"],
    [{ items: [{ id: "v", action: "keep" }] }, "why: required"],
    [{ items: [{ id: "v", action: "keep", why: "x".repeat(141) }] }, "why: 141 characters, at most 140"],
    [{ items: [{ id: "r", action: "rewrite", why: "x" }] }, "a rewrite needs the new title or body"],
    [{ items: [{ id: "v", action: "keep", why: "x", body: "new" }] }, "only a rewrite or a merge has new text"],
    [{ items: [{ id: "m", action: "merge", why: "x" }] }, "a merge names the notes"],
    [{ items: [{ id: "m", action: "merge", why: "x", merge: ["m"] }] }, 'no other active note "m"'],
    [{ items: [{ id: "v", action: "trash", why: "x", merge: ["m2"] }] }, "only a merge or a promote has it"],
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
    expect(data.cards.map((c) => c.id)).toEqual(["v", "r", "m", "d", "ask", "keepme"]);
    const card = (id: string) => data.cards.find((c) => c.id === id)!;
    expect(card("r").proposed).toEqual({ title: "Title of r", body: "the new body" });
    expect(card("m").merge!.map((n) => n.id)).toEqual(["m2"]);
    expect(card("v").note.body).toBe("body of v");
  });
});

describe("Apply", () => {
  test("trash on a merge card takes both notes", () => {
    const store = setup();
    proposeAudit(store, { items: [ITEMS[2]!] }, repo());
    expect(applyAudit(store, SCOPE, { picks: [{ id: "m", action: "trash" }] }).trashed).toEqual(["m", "m2"]);
    expect([store.find("m")!.trashed_at, store.find("m2")!.trashed_at]).toEqual([expect.any(String), expect.any(String)]);
  });

  test("makes every pick in one commit, and records the requests for the agent", () => {
    const store = setup();
    proposeAudit(store, { items: ITEMS }, repo("abc1234"));
    const before = Number(sh(store.home, "git", "rev-list", "--count", "HEAD"));
    const result = applyAudit(store, SCOPE, {
      picks: [
        { id: "v", action: "keep" },
        { id: "r", action: "rewrite" },
        { id: "m", action: "merge" },
        { id: "t", action: "trash" },
        { id: "d", action: "keep", checked: true },
        { id: "ask", action: "ask", request: "the code moved" },
        { id: "keepme", action: "keep" },
      ],
    });
    expect(result).toMatchObject({ rewritten: ["r"], merged: [{ kept: "m", trashed: ["m2"] }], trashed: ["t"], checked: ["v", "d"], kept: ["keepme"], requests: [{ id: "ask", request: "the code moved" }] });
    expect(Number(sh(store.home, "git", "rev-list", "--count", "HEAD"))).toBe(before + 1);
    expect(sh(store.home, "git", "log", "-1", "--format=%s")).toBe(`kb: apply the audit of ${SCOPE}`);
    // The agent checked v, and the user kept d on its card: both record the check, at the repo's HEAD.
    expect(store.find("v")!.verified_at_commit).toBe("abc1234");
    expect(store.find("d")!.verified_at_commit).toBe("abc1234");
    // Nobody looked at keepme: a keep from a group or an unopened card records nothing.
    expect(store.find("keepme")).toMatchObject({ last_verified: "2026-01-01T00:00:00Z" });
    expect(store.find("keepme")!.verified_at_commit).toBeUndefined();
    expect(store.find("r")!.body).toBe("the new body");
    expect(store.find("m")).toMatchObject({ body: "merged body", supersedes: ["m2"] });
    expect(store.notes().map((n) => n.id)).not.toContain("m2");
    expect(store.notes().map((n) => n.id)).not.toContain("t");
    expect(store.find("ask")!.body).toBe("body of ask");
    expect(openAudits(store)).toEqual([]);
    expect(() => applyAudit(store, SCOPE, { picks: [] })).toThrow("applied already");
  });

  test("an ask and an unchecked keep make no commit", () => {
    const store = setup();
    proposeAudit(store, { items: ITEMS.slice(5, 7) }, repo());
    applyAudit(store, SCOPE, { picks: [{ id: "ask", action: "ask", request: "why" }, { id: "keepme", action: "keep" }] });
    expect(sh(store.home, "git", "log", "-1", "--format=%s")).toBe("init");
  });

  test("keep both on a merge card changes neither note", () => {
    const store = setup();
    proposeAudit(store, { items: [ITEMS[2]!] }, repo("abc1234"));
    const before = store.find("m")!.last_verified;
    expect(applyAudit(store, SCOPE, { picks: [{ id: "m", action: "keep" }] }).kept).toEqual(["m"]);
    expect(store.find("m")!.last_verified).toBe(before);
    expect(sh(store.home, "git", "log", "-1", "--format=%s")).toBe("init");
  });

  test("a card with an action this kb does not know drops out", () => {
    const store = setup();
    proposeAudit(store, { items: [ITEMS[0]!, ITEMS[3]!] }, repo());
    const path = store.statePath("audits.json");
    writeFileSync(path, readFileSync(path, "utf8").replace('"action": "trash"', '"action": "archive"'));
    expect(auditData(store, SCOPE, "tok").cards.map((c) => c.id)).toEqual(["v"]);
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
});

describe("the global audit", () => {
  const GLOBAL = { scope: null, root: null, head: null } as unknown as RepoInfo;
  const RULES = "# Rules\n\n## Style\n\n- Never use the em dash.\n\n## Tools\n\n- Use gh-axi for GitHub.\n";

  /** A store whose global instructions file is a link, as a dotfiles manager makes it. */
  function globalSetup() {
    const store = setup();
    putNote(store, { id: "g2", kind: "convention", body: "short sentences" });
    putNote(store, { id: "g3", kind: "convention", body: "active voice" });
    const dir = tempDir();
    const real = join(dir, "AGENTS.md");
    writeFileSync(real, RULES);
    symlinkSync(real, join(dir, "CLAUDE.md"));
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ globalInstructions: join(dir, "CLAUDE.md") }));
    sh(store.home, "git", "add", "-A");
    sh(store.home, "git", "commit", "-q", "-m", "global");
    return { store, real, link: join(dir, "CLAUDE.md") };
  }
  const MOVE = { id: "g2", action: "promote", why: "a rule the user stated", rule: "- Write short sentences in the active voice.", section: "Style", merge: ["g3"] };

  test("covers the global notes only, and refuses a repo note", () => {
    const { store } = globalSetup();
    expect(() => proposeAudit(store, { items: [{ id: "v", action: "keep", why: "x" }] }, GLOBAL)).toThrow(`belongs to ${SCOPE}. Run the audit inside that repo`);
    expect(() => proposeAudit(store, { items: [{ id: "g", action: "promote", why: "x" }] }, GLOBAL)).toThrow("a promote needs the text");
    expect(() => proposeAudit(store, { items: [{ id: "g", action: "keep", why: "x", rule: "r" }] }, GLOBAL)).toThrow("only a promote has a rule");
    proposeAudit(store, { items: [{ id: "g", action: "keep", why: "x" }] }, GLOBAL);
    expect(openAudits(store)).toEqual(["global"]);
  });

  test("the card shows the lines Apply adds, at the end of the section, and nothing is written yet", () => {
    const { store, real } = globalSetup();
    proposeAudit(store, { items: [MOVE] }, GLOBAL);
    const [card] = auditData(store, "global", "tok").cards;
    expect(card!.merge!.map((n) => n.id)).toEqual(["g3"]);
    expect(card!.promote).toEqual({ file: expect.stringContaining("CLAUDE.md"), path: expect.stringContaining("AGENTS.md"), link: true, section: "Style", above: ["## Style", "", "- Never use the em dash."], added: ["- Write short sentences in the active voice."], rule: MOVE.rule });
    expect(readFileSync(real, "utf8")).toBe(RULES);
  });

  test("Apply writes the rule through the link, marks the notes moved, and sessions stop loading them", () => {
    const { store, real, link } = globalSetup();
    proposeAudit(store, { items: [MOVE, { id: "g", action: "keep", why: "x" }] }, GLOBAL);
    const before = Number(sh(store.home, "git", "rev-list", "--count", "HEAD"));
    const result = applyAudit(store, "global", { picks: [{ id: "g2", action: "promote", rule: "- Use short sentences." }, { id: "g", action: "keep" }] });
    expect(result.promoted).toEqual(["g2", "g3"]);
    expect(readFileSync(real, "utf8")).toBe("# Rules\n\n## Style\n\n- Never use the em dash.\n- Use short sentences.\n\n## Tools\n\n- Use gh-axi for GitHub.\n");
    expect(Bun.spawnSync(["test", "-L", link]).exitCode).toBe(0);
    expect(store.find("g2")!.promoted_to).toBe("CLAUDE.md");
    expect(store.find("g3")!.promoted_to).toBe("CLAUDE.md");
    expect(Number(sh(store.home, "git", "rev-list", "--count", "HEAD"))).toBe(before + 1);
    expect(contextFor(store, null).text).not.toContain("g2");
  });

  test("two rules for one new section: the second card shows the heading the first one adds", () => {
    const { store } = globalSetup();
    const one = { id: "g2", action: "promote", why: "x", rule: "- One.", section: "Writing" };
    const two = { id: "g3", action: "promote", why: "x", rule: "- Two.", section: "Writing" };
    proposeAudit(store, { items: [one, two] }, GLOBAL);
    const [first, second] = auditData(store, "global", "tok").cards;
    expect(first!.promote!.added).toEqual(["", "## Writing", "", "- One."]);
    expect(second!.promote!.above).toEqual(["", "## Writing", "", "- One."].slice(-3));
    expect(second!.promote!.added).toEqual(["- Two."]);
  });

  test("a rule the file holds already is not added twice, so a failed Apply can run again", () => {
    const { store, real } = globalSetup();
    proposeAudit(store, { items: [MOVE] }, GLOBAL);
    // As if the last Apply wrote the file and then failed before the notes changed.
    const written = RULES.replace("- Never use the em dash.\n", `- Never use the em dash.\n${MOVE.rule}\n`);
    writeFileSync(real, written);
    applyAudit(store, "global", { picks: [{ id: "g2", action: "promote" }] });
    expect(readFileSync(real, "utf8")).toBe(written);
    expect(store.find("g2")!.promoted_to).toBe("CLAUDE.md");
  });

  test("a card whose rule the file holds already says Apply adds nothing", () => {
    const { store } = globalSetup();
    proposeAudit(store, { items: [{ ...MOVE, rule: "- Never use the em dash." }] }, GLOBAL);
    expect(auditData(store, "global", "tok").cards[0]!.promote!.present).toBe(true);
  });

  test("a missing instructions file stops Apply before any change", () => {
    const { store } = globalSetup();
    proposeAudit(store, { items: [MOVE] }, GLOBAL);
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ globalInstructions: join(tempDir(), "missing.md") }));
    expect(() => applyAudit(store, "global", { picks: [{ id: "g2", action: "promote" }] })).toThrow("does not exist");
    expect(store.find("g2")!.promoted_to).toBeUndefined();
    expect(readAudit(store, "global")!.result).toBeUndefined();
  });

  test("trash on a promote card takes every note on it, and the file stays as it was", () => {
    const { store, real } = globalSetup();
    proposeAudit(store, { items: [MOVE] }, GLOBAL);
    expect(() => applyAudit(store, "global", { picks: [{ id: "g2", action: "keep", rule: "x" }] })).toThrow("only a promote has it");
    expect(applyAudit(store, "global", { picks: [{ id: "g2", action: "trash" }] }).trashed).toEqual(["g2", "g3"]);
    expect([store.find("g2")!.trashed_at, store.find("g3")!.trashed_at]).toEqual([expect.any(String), expect.any(String)]);
    expect(readFileSync(real, "utf8")).toBe(RULES);
  });
});

describe("a repo audit moves a rule to the repo's own file", () => {
  const MOVE = { id: "v", action: "promote", why: "a rule for anyone in this repo", rule: "- Run the build before you commit.", section: "Build", merge: ["keepme"] };

  /** A store with a proposal to move v and keepme, and a checkout that kb knows. */
  function repoSetup(files: (root: string) => void = () => {}) {
    const store = setup();
    const root = tempDir();
    files(root);
    rememberRepo(store, SCOPE, root);
    proposeAudit(store, { items: [MOVE] }, { scope: SCOPE, root, head: "abc1234" });
    return { store, root };
  }

  test("creates CLAUDE.md when the repo has no instruction file, and the notes stop loading", () => {
    const { store, root } = repoSetup();
    expect(auditData(store, SCOPE, "tok").cards[0]!.promote).toMatchObject({ file: "CLAUDE.md", create: true, link: false, added: ["## Build", "", MOVE.rule] });
    expect(applyAudit(store, SCOPE, { picks: [{ id: "v", action: "promote" }] }).promoted).toEqual(["v", "keepme"]);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(`## Build\n\n${MOVE.rule}\n`);
    expect([store.find("v")!.promoted_to, store.find("keepme")!.promoted_to]).toEqual(["CLAUDE.md", "CLAUDE.md"]);
    expect(contextFor(store, SCOPE).text).not.toContain("body of v");
  });

  test("writes AGENTS.md when the repo has only that, and the file behind a CLAUDE.md link", () => {
    const only = repoSetup((root) => writeFileSync(join(root, "AGENTS.md"), "# Agents\n"));
    expect(auditData(only.store, SCOPE, "tok").cards[0]!.promote).toMatchObject({ file: "AGENTS.md", link: false });
    expect(auditData(only.store, SCOPE, "tok").cards[0]!.promote!.create).toBeUndefined();
    applyAudit(only.store, SCOPE, { picks: [{ id: "v", action: "promote" }] });
    expect(readFileSync(join(only.root, "AGENTS.md"), "utf8")).toBe(`# Agents\n\n## Build\n\n${MOVE.rule}\n`);
    expect(existsSync(join(only.root, "CLAUDE.md"))).toBe(false);

    const linked = repoSetup((root) => {
      writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
      symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    });
    expect(auditData(linked.store, SCOPE, "tok").cards[0]!.promote).toMatchObject({ file: "CLAUDE.md", link: true, path: expect.stringContaining("AGENTS.md") });
    applyAudit(linked.store, SCOPE, { picks: [{ id: "v", action: "promote" }] });
    expect(readFileSync(join(linked.root, "AGENTS.md"), "utf8")).toContain(MOVE.rule);
  });

  test("a checkout that kb does not know stops the page and Apply before any change", () => {
    const store = setup();
    proposeAudit(store, { items: [MOVE] }, repo());
    expect(() => auditData(store, SCOPE, "tok")).toThrow(`the checkout of ${SCOPE} is not on this machine`);
    expect(() => applyAudit(store, SCOPE, { picks: [{ id: "v", action: "promote" }] })).toThrow("is not on this machine");
    expect(store.find("v")!.promoted_to).toBeUndefined();
  });
});

const FAKE = join(import.meta.dir, "fixtures", "fake-audit-agent.sh");
const REMOTE = "https://example.com/team/app.git";

/** Run the CLI in a checkout of the repo, with the fake agent in place of claude. */
function cli(store: Store, dir: string, fake: string, args: string[], items: object[] = [ITEMS[0]!]) {
  const out = tempDir();
  const r = Bun.spawnSync(["bun", MAIN, ...args], {
    cwd: dir,
    env: { ...process.env, KB_HOME: store.home, [AGENT_ENV]: FAKE, FAKE_AUDIT: fake, FAKE_OUT: out, FAKE_ITEMS: JSON.stringify({ items }) },
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

  test("outside a repo it audits the global notes, in an empty folder that no repo reaches", () => {
    const store = setup();
    const r = cli(store, tempDir(), "propose", ["audit"], [{ id: "g", action: "keep", why: "still true" }]);
    expect(r.stderr).toContain("an agent audits the global notes");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`#audit=global`);
    expect(readAudit(store, "global")!.items.map((i) => i.id)).toEqual(["g"]);
    const cwd = readFileSync(join(r.out, "cwd.txt"), "utf8").trim();
    expect(cwd).toContain("kb-audit-global-");
    expect(readFileSync(join(r.out, "git.txt"), "utf8").trim()).toBe("none");
    // The folder is removed when the agent ends.
    expect(existsSync(cwd)).toBe(false);
  });

  test("a session start records where the repo is checked out", () => {
    const store = setup();
    const dir = tempRepo({ remote: REMOTE });
    buildContext(store, dir);
    expect(auditableScopes(store)).toEqual(["global", SCOPE]);
    rememberRepo(store, "example.com/team/gone", join(tempDir(), "missing"));
    // A repo with no remote whose folder is named global is not listed twice.
    rememberRepo(store, "global", dir);
    expect(auditableScopes(store)).toEqual(["global", SCOPE]);
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
  const card = (fields: Partial<AuditCard>): AuditCard => ({ id: "x", action: "keep", why: "w", note: { id: "x", title: "T", kind: "gotcha", scope: SCOPE, body: "b", uses: 0, place: "index" }, ...fields });

  test("puts loose cards first, then each group after its divider", () => {
    const cards = [card({ id: "a", group: "G" }), card({ id: "b" }), card({ id: "c", group: "G" })];
    expect(steps(cards).map((s) => (s.type === "card" ? s.card.id : `| ${s.group}`))).toEqual(["b", "| G", "a", "c"]);
  });

  test("puts the agent's pick first, then each other pick once", () => {
    expect(choices(card({}))).toEqual(["keep", "trash"]);
    expect(choices(card({ action: "trash" }))).toEqual(["trash", "keep"]);
    expect(choices(card({ action: "rewrite", proposed: { title: "T", body: "new" } }))).toEqual(["rewrite", "keep", "trash"]);
    expect(choices(card({ action: "merge", merge: [card({}).note] }))).toEqual(["merge", "keep", "trash"]);
    const promote = { file: "~/.claude/CLAUDE.md", path: "~/dotfiles/AGENTS.md", link: true, above: [], added: ["- r"], rule: "- r" };
    expect(choices(card({ action: "promote", promote }))).toEqual(["promote", "keep", "trash"]);
    expect(choices(card({ action: "promote", promote, merge: [card({}).note] }))).toEqual(["promote", "keep", "trash"]);
    expect(choiceForKey(card({ action: "promote", promote, merge: [card({}).note] }), "r")).toBe("ask");
  });

  test("a takes the agent's pick, and the text keys sit beside the buttons", () => {
    const trash = card({ action: "trash" });
    expect(choiceForKey(trash, "a")).toBe("trash");
    expect(choiceForKey(trash, "k")).toBe("keep");
    expect(choiceForKey(trash, "e")).toBe("edit");
    expect(choiceForKey(trash, "r")).toBe("ask");
    expect(choiceForKey(card({ action: "merge", merge: [card({}).note] }), "r")).toBeUndefined();
  });

  test("counts the notes the picks take out of the index", () => {
    const cards = [card({}), card({}), card({ merge: [card({}).note, card({}).note] }), card({})];
    expect(freed(cards, [{ action: "trash" }, { action: "trash" }, { action: "merge" }, { action: "keep" }])).toBe(4);
  });

  test("a moved rule takes its notes and the notes that move with it out of the index", () => {
    const promote = { file: "~/.claude/CLAUDE.md", path: "~/dotfiles/AGENTS.md", link: true, above: [], added: ["- r"], rule: "- r" };
    const moving = card({ action: "promote", promote, merge: [card({}).note, { ...card({}).note, place: "hidden" }] });
    expect(freed([moving], [{ action: "promote" }])).toBe(2);
    // The summary counts notes, not cards: the move changes all three notes on its card.
    expect(changes([moving, card({})], [{ action: "promote" }, { action: "keep" }])).toEqual({ changed: 3, total: 4 });
    expect(changes([moving], [{ action: "keep" }])).toEqual({ changed: 0, total: 3 });
    expect(summary([moving], [{ action: "promote", rule: "mine" }]).map((g) => g.label)).toEqual(["move to CLAUDE.md with your text"]);
    expect(toPicks([moving], [{ action: "promote", rule: "mine" }])).toEqual([{ id: "x", action: "promote", rule: "mine" }]);
  });

  test("trash on a card with several notes takes, counts and names every note on it", () => {
    const two = card({ action: "merge", merge: [{ ...card({}).note, id: "y", title: "U" }] });
    const three = card({ action: "merge", merge: [card({}).note, { ...card({}).note, place: "hidden" }] });
    expect([two, three].map((c) => choiceLabel(c, "trash"))).toEqual(["trash both", "trash all 3"]);
    expect(freed([three], [{ action: "trash" }])).toBe(2);
    expect(changes([two, three], [{ action: "trash" }, { action: "keep" }])).toEqual({ changed: 2, total: 5 });
    expect(summary([two], [{ action: "trash" }])).toMatchObject([{ label: "trash", titles: ["T", "U"] }]);
  });

  test("counts no line for a note that had none", () => {
    const out = card({ note: { ...card({}).note, place: "hidden" } });
    expect(freed([out, card({})], [{ action: "trash" }, { action: "trash" }])).toBe(1);
  });

  test("sends every card to Apply, keep too, with the user's text", () => {
    const cards = [card({ id: "a" }), card({ id: "b" })];
    expect(toPicks(cards, [{ action: "keep", checked: true }, { action: "rewrite", body: "mine" }])).toEqual([
      { id: "a", action: "keep", checked: true },
      { id: "b", action: "rewrite", body: "mine" },
    ]);
    expect(summary(cards, [{ action: "keep" }, { action: "ask", request: "r" }]).map((g) => g.label)).toEqual(["sent back to the agent to rewrite", "keep as is"]);
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
    await page.keyboard.press("Enter"); // v: the agent's keep
    await page.locator('[data-card="r"]').waitFor();
    await page.keyboard.press("e");
    await page.getByLabel("Body").fill("typed in the page");
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.locator('[data-card="t"]').waitFor();
    // The next card starts with its keys, and no box keeps the focus.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    await page.keyboard.press("k"); // t: keep, not the agent's trash
    await page.getByRole("heading", { name: "conventions" }).waitFor();
    await page.keyboard.press("k"); // keep the whole group
    await page.getByRole("heading", { name: "Ready to apply" }).waitFor();
    expect(await page.locator("[data-card]").count()).toBe(0);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Applied" }).waitFor();
    expect(store.find("v")!.verified_at_commit).toBe("abc1234");
    expect(store.find("r")!.body).toBe("typed in the page");
    expect(store.find("t")).toBeDefined();
    expect(readAudit(store, SCOPE)!.result).toMatchObject({ rewritten: ["r"], checked: ["v", "t"], kept: ["keepme"] });
    // keepme went with its group: nobody looked, so it records no check.
    expect(store.find("keepme")!.verified_at_commit).toBeUndefined();
    await page.close();
  });

  test("accept the rest takes the agent's pick on every card not picked yet, and keeps the user's picks", async () => {
    const store = setup();
    proposeAudit(store, { items: [ITEMS[0], ITEMS[3], ITEMS[6]] }, repo());
    served = serve(store, { port: 0 });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(3000);
    await page.goto(`${served.url}#audit=${encodeURIComponent(SCOPE)}`);
    await page.locator('[data-card="v"]').waitFor();
    await page.keyboard.press("t"); // v: trash, not the agent's keep
    await page.locator('[data-card="t"]').waitFor();
    expect(await page.locator("[data-accept-rest]").textContent()).toContain("accept the rest (2)");
    await page.keyboard.press("Shift+A");
    await page.getByRole("heading", { name: "Ready to apply" }).waitFor();
    expect(await page.locator("[data-accept-rest]").count()).toBe(0);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Applied" }).waitFor();
    // keepme was never opened: its keep records no check.
    expect(readAudit(store, SCOPE)!.result).toMatchObject({ trashed: ["v", "t"], kept: ["keepme"], checked: [] });
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

  test("the global notes have an Audit button too, and the agent runs outside any repo", async () => {
    const store = setup();
    const out = tempDir();
    const env = { [AGENT_ENV]: FAKE, FAKE_AUDIT: "propose", FAKE_OUT: out, FAKE_ITEMS: JSON.stringify({ items: [{ id: "g", action: "keep", why: "still true" }] }), KB_HOME: store.home };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      served = serve(store, { port: 0 });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(15000);
      await page.goto(served.url);
      await page.locator('[data-rail="scope:global"]').click();
      await page.locator('[data-audit-start="start"]').click();
      await page.locator('[data-card="g"]').waitFor();
      expect(await page.evaluate(() => location.hash)).toBe("#audit=global");
      expect(readFileSync(join(out, "git.txt"), "utf8").trim()).toBe("none");
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
