import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeNote } from "../cli/note.ts";
import type { Store } from "../cli/store.ts";
import { ROOT, kb, logged, plain, putNote, tempDir, tempRepo, tempStore } from "./helpers.ts";

const HOOK = join(ROOT, "hooks", "tool-call.sh");
const READ_HOOK = join(ROOT, "hooks", "post-read.sh");
const START_HOOK = join(ROOT, "hooks", "session-start.sh");
const SCOPE = "github.com/acme/billing";

/** A repo with src/pay.ts and docs/a.md, and a store. */
function fixture() {
  const store = tempStore();
  const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "src/pay.ts"), "export function charge() {}\n");
  writeFileSync(join(repo, "docs/a.md"), "# a\n");
  return { store, repo };
}

interface Who {
  session?: string | null;
  agent?: string;
}

function run(hook: string, home: string, body: Record<string, unknown> | string) {
  const r = Bun.spawnSync([hook], {
    cwd: plain(),
    env: { ...process.env, KB_HOME: home, CLAUDE_CONFIG_DIR: tempDir("kb-claude-") },
    stdin: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString() };
}

/** The fields every hook input has, as Claude Code sends them. */
const base = (cwd: string, who: Who) => ({ ...(who.session === null ? {} : { session_id: who.session ?? "s1" }), ...(who.agent ? { agent_id: who.agent, agent_type: "Explore" } : {}), cwd, permission_mode: "default" });

/** What the hook answers: nothing, a note next to the call ("context"), or a refusal with the note as the reason ("deny"). */
function answer(home: string, body: Record<string, unknown>): { context?: string; deny?: string } {
  const r = run(HOOK, home, body);
  expect(r.code).toBe(0);
  if (!r.stdout) return {};
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  expect(out.hookEventName).toBe(body.hook_event_name);
  if (out.permissionDecision !== undefined) {
    expect(out.permissionDecision).toBe("deny");
    expect(out.additionalContext).toBeUndefined();
    return { deny: out.permissionDecisionReason };
  }
  return { context: out.additionalContext };
}

const bash = (home: string, cwd: string, command: string, who: Who = {}) =>
  answer(home, { ...base(cwd, who), hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "a command" }, tool_use_id: "toolu_1" });

const edit = (home: string, cwd: string, file: string, tool = "Edit", who: Who = {}) =>
  answer(home, { ...base(cwd, who), hook_event_name: "PreToolUse", tool_name: tool, tool_input: tool === "NotebookEdit" ? { notebook_path: file, new_source: "x" } : { file_path: file, content: "x" }, tool_use_id: "toolu_1" });

/** A tool call that failed. Claude Code sends the output of a failed Bash call as `error`, after "Exit code N". */
const failed = (home: string, cwd: string, error: string, who: Who = {}, more: Record<string, unknown> = {}) =>
  answer(home, { ...base(cwd, who), hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "zorp sync" }, tool_use_id: "toolu_1", error, is_interrupt: false, duration_ms: 12, ...more });

const start = (home: string, cwd: string, source: string, session = "s1") => expect(run(START_HOOK, home, { session_id: session, cwd, hook_event_name: "SessionStart", source }).code).toBe(0);

describe("a cmd trigger loads its note before the command", () => {
  test("the agent gets the id, the kind, the title and the body, and the command still runs", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "zorp-wipe", title: "zorp --wipe removes the cache of every project", triggers: ["cmd: zorp --wipe"], body: "Pass --project <name>.\nA wipe with no project takes ten minutes to rebuild." });
    expect(bash(store.home, repo, "cd src && sudo zorp -v --wipe")).toEqual({
      context: [
        "kb has a note for this command.",
        "",
        "### zorp-wipe [gotcha] zorp --wipe removes the cache of every project",
        "trigger cmd: zorp --wipe",
        "Pass --project <name>.",
        "A wipe with no project takes ten minutes to rebuild.",
      ].join("\n"),
    });
  });

  test("a command that matches no trigger gets nothing, and runs no git", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "zorp-wipe", triggers: ["cmd: zorp --wipe"] });
    putNote(store, { id: "on-file", scope: SCOPE, anchors: ["src/pay.ts"] });
    for (const command of ["git status", "zorp --list", "echo 'zorp --wipe'", "ls src", "bun test 2>&1 | tail -5", ""]) expect(bash(store.home, repo, command)).toEqual({});
    // A folder that is no repo, and that does not exist: the hook needs no repo to say nothing.
    expect(bash(store.home, join(plain(), "gone"), "git status")).toEqual({});
    expect(logged(store)).toEqual([]);
  });

  test("a note comes once per session, to each subagent once, and again after a compaction or a /clear", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "zorp-wipe", triggers: ["cmd: zorp --wipe"] });
    const got = (who: Who = {}) => bash(store.home, repo, "zorp --wipe", who).context?.includes("### zorp-wipe ") ?? false;
    expect(got()).toBe(true);
    expect(got()).toBe(false);
    expect(got({ session: "s2" })).toBe(true);
    expect(got({ agent: "agent-a1" })).toBe(true);
    expect(got({ agent: "agent-a1" })).toBe(false);
    expect(got({ agent: "agent-b2" })).toBe(true);
    start(store.home, repo, "resume");
    expect(got()).toBe(false);
    start(store.home, repo, "compact");
    expect(got()).toBe(true);
    expect(got()).toBe(false);
    start(store.home, repo, "clear");
    expect(got()).toBe(true);
    // With no session id nothing is recorded, so the note comes each time.
    expect(got({ session: null })).toBe(true);
    expect(got({ session: null })).toBe(true);
  });

  test("a repo note loads in its repo only, and a global note in every folder", () => {
    const { store, repo } = fixture();
    const other = tempRepo({ remote: "git@github.com:acme/web.git" });
    putNote(store, { id: "in-billing", scope: SCOPE, triggers: ["cmd: make deploy"] });
    putNote(store, { id: "in-web", scope: "github.com/acme/web", triggers: ["cmd: make deploy"] });
    putNote(store, { id: "everywhere", triggers: ["cmd: make deploy"] });
    const ids = (text: string | undefined) => [...(text ?? "").matchAll(/^### (\S+)/gm)].map((m) => m[1]);
    expect(ids(bash(store.home, repo, "make deploy").context)).toEqual(["everywhere", "in-billing"]);
    expect(ids(bash(store.home, other, "make deploy", { session: "s2" }).context)).toEqual(["everywhere", "in-web"]);
    expect(ids(bash(store.home, plain(), "make deploy", { session: "s3" }).context)).toEqual(["everywhere"]);
    // A command that starts with a cd runs in that folder, so the notes of that repo apply.
    expect(ids(bash(store.home, plain(), `cd ${other} && make deploy`, { session: "s4" }).context)).toEqual(["everywhere", "in-web"]);
  });

  test("at most three notes load for one call, and the rest at the next call that matches", () => {
    const { store, repo } = fixture();
    for (let i = 1; i <= 5; i++) putNote(store, { id: `n${i}`, triggers: ["cmd: zorp --wipe"] });
    const ids = () => [...(bash(store.home, repo, "zorp --wipe").context ?? "").matchAll(/^### (\S+)/gm)].map((m) => m[1]);
    expect(ids()).toEqual(["n1", "n2", "n3"]);
    expect(ids()).toEqual(["n4", "n5"]);
    expect(ids()).toEqual([]);
  });

  test("a long body is cut at 600 characters at the end of a word, with where the rest is", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "long", triggers: ["cmd: zorp --wipe"], body: "word ".repeat(400) });
    putNote(store, { id: "fits", triggers: ["cmd: zorp --wipe"], body: "x".repeat(600) });
    const text = bash(store.home, repo, "zorp --wipe").context!;
    const [, fits, long] = text.split("\n\n");
    expect(fits).toBe(`### fits [gotcha] Title of fits\ntrigger cmd: zorp --wipe\n${"x".repeat(600)}`);
    const lines = long!.split("\n");
    expect(lines.at(-1)).toBe("`kb show long` prints the rest.");
    expect(lines.at(-2)).toEndWith(" word...");
    expect(lines.at(-2)!.length).toBeLessThanOrEqual(603);
    expect(lines.at(-2)!.length).toBeGreaterThan(520);
  });

  test("each note is one fire in the log, with its trigger, and satisfies kb verdict not-needed", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "zorp-wipe", triggers: ["cmd: zorp --wipe"] });
    putNote(store, { id: "in-billing", scope: SCOPE, kind: "how-to", triggers: ["cmd: zorp --wipe"] });
    putNote(store, { id: "at-start" });
    bash(store.home, repo, "zorp --wipe", { agent: "agent-a1" });
    bash(store.home, repo, "zorp --wipe", { agent: "agent-a1" });
    expect(logged(store)).toEqual([
      { ev: "fire", session: "s1", agent: "agent-a1", scope: SCOPE, note: "zorp-wipe", kind: "cmd", form: "body", match: "zorp --wipe", tool: "Bash" },
      { ev: "fire", session: "s1", agent: "agent-a1", scope: SCOPE, note: "in-billing", kind: "cmd", form: "body", match: "zorp --wipe", tool: "Bash" },
    ]);
    expect(kb(store, ["log", "--session", "s1"], { cwd: repo }).stdout).toContain("zorp-wipe (Bash, cmd: zorp --wipe)  [agent agent-a1]");
    // not-needed is only for a note that a trigger loaded in the session. A fire of this hook is one.
    expect(kb(store, ["verdict", "not-needed", "zorp-wipe", "--session", "s1"], { cwd: repo }).code).toBe(0);
    expect(kb(store, ["verdict", "not-needed", "at-start", "--session", "s1"], { cwd: repo }).stderr).toContain("has no fire of: at-start");
  });
});

describe("a stop trigger refuses the command once", () => {
  test("the first run is refused with the note as the reason, and the same command then passes", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "frob-reset", title: "frobnicate reset drops the local database", triggers: ["stop: frobnicate reset"], body: "One run drops every table.\nTake a dump with `frobnicate dump` first." });
    expect(bash(store.home, repo, "frobnicate reset --yes")).toEqual({
      deny: [
        "kb stopped this command once, because a note says that one run can do damage. Read the note. If the command still applies, run it again: it passes the second time.",
        "",
        "### frob-reset [gotcha] frobnicate reset drops the local database",
        "trigger stop: frobnicate reset",
        "One run drops every table.",
        "Take a dump with `frobnicate dump` first.",
      ].join("\n"),
    });
    expect(bash(store.home, repo, "frobnicate reset --yes")).toEqual({});
    expect(bash(store.home, repo, "frobnicate reset --yes")).toEqual({});
    // Another session, and a subagent, have not read the note: each is stopped once.
    expect(bash(store.home, repo, "frobnicate reset", { session: "s2" }).deny).toContain("### frob-reset ");
    expect(bash(store.home, repo, "frobnicate reset", { agent: "agent-a1" }).deny).toContain("### frob-reset ");
    expect(bash(store.home, repo, "frobnicate reset", { agent: "agent-a1" })).toEqual({});
    // After a compaction the note is gone from the context, so the command is stopped once more.
    start(store.home, repo, "compact");
    expect(bash(store.home, repo, "frobnicate reset").deny).toContain("### frob-reset ");
    expect(bash(store.home, repo, "frobnicate reset")).toEqual({});
    expect(logged(store).filter((e) => e.ev === "fire").map((e) => [e.session, e.agent, e.kind, e.match])).toEqual([
      ["s1", undefined, "stop", "frobnicate reset"],
      ["s2", undefined, "stop", "frobnicate reset"],
      ["s1", "agent-a1", "stop", "frobnicate reset"],
      ["s1", undefined, "stop", "frobnicate reset"],
    ]);
  });

  test("with no record of the call, a stop never refuses: the note comes next to the command", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "frob-reset", triggers: ["stop: frobnicate reset"] });
    // No session id, so nothing says that the note was given. A refusal would come each time.
    for (let i = 0; i < 2; i++) {
      const got = bash(store.home, repo, "frobnicate reset", { session: null });
      expect(got.deny).toBeUndefined();
      expect(got.context).toStartWith("kb has a note for this command.\n\n### frob-reset [gotcha]");
      expect(got.context).toContain("trigger cmd: frobnicate reset");
    }
    expect(logged(store).map((e) => e.kind)).toEqual(["cmd", "cmd"]);
  });

  test("a session that has the note from another trigger is still stopped once, and gets the note no third time", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "frob-reset", scope: SCOPE, kind: "how-to", anchors: ["src/pay.ts"], triggers: ["stop: frobnicate reset", "err: database is gone"] });
    // The edit gave only the title. One run of the command does damage, so the stop must not rely on it.
    expect(edit(store.home, repo, join(repo, "src/pay.ts")).context).toContain("- frob-reset [how-to]");
    expect(bash(store.home, repo, "frobnicate reset").deny).toContain("### frob-reset [how-to]");
    expect(bash(store.home, repo, "frobnicate reset")).toEqual({});
    expect(failed(store.home, repo, "Exit code 1\nfatal: database is gone")).toEqual({});
    expect(edit(store.home, repo, join(repo, "src/pay.ts"))).toEqual({});
    expect(logged(store).map((e) => [e.kind, e.form, e.tool])).toEqual([["path", "title", "Edit"], ["stop", "body", "Bash"]]);
  });

  test("a stop comes first, and the other notes of the call come with it in the reason", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "a-cmd", triggers: ["cmd: frobnicate reset"] });
    putNote(store, { id: "b-stop", triggers: ["stop: frobnicate reset"] });
    putNote(store, { id: "c-path", scope: SCOPE, kind: "decision", anchors: ["docs"] });
    const got = bash(store.home, repo, "frobnicate reset docs/a.md");
    expect(got.deny).toStartWith("kb stopped this command once");
    expect([...got.deny!.matchAll(/^(?:### |- )(\S+)/gm)].map((m) => m[1])).toEqual(["b-stop", "a-cmd", "c-path"]);
    expect(bash(store.home, repo, "frobnicate reset docs/a.md")).toEqual({});
  });
});

describe("an err trigger loads its note after a failed call", () => {
  test("the note comes when the error holds the text, in any case, once per session", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "flux", title: "A flux underflow means the cache is from an older zorp", triggers: ["err: Flux capacitor underflow"], body: "Run `zorp cache clear`, then run the command again." });
    putNote(store, { id: "in-web", scope: "github.com/acme/web", triggers: ["err: flux capacitor underflow"] });
    expect(failed(store.home, repo, "Exit code 3\nok so far")).toEqual({});
    expect(failed(store.home, repo, "Exit code 3\nFATAL: flux   CAPACITOR\nunderflow at step 2")).toEqual({
      context: ["kb has a note for this error.", "", "### flux [gotcha] A flux underflow means the cache is from an older zorp", "trigger err: flux capacitor underflow", "Run `zorp cache clear`, then run the command again."].join("\n"),
    });
    expect(failed(store.home, repo, "Exit code 3\nflux capacitor underflow")).toEqual({});
    expect(logged(store)).toEqual([{ ev: "fire", session: "s1", scope: SCOPE, note: "flux", kind: "err", form: "body", match: "flux capacitor underflow", tool: "Bash" }]);
  });

  test("a call that the user stopped, and an input with no error text, load nothing", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "flux", triggers: ["err: flux capacitor underflow"] });
    expect(failed(store.home, repo, "flux capacitor underflow", {}, { is_interrupt: true })).toEqual({});
    expect(failed(store.home, repo, "", {}, { error: { message: "flux capacitor underflow" } })).toEqual({});
    expect(failed(store.home, repo, "flux capacitor underflow").context).toContain("### flux ");
  });
});

describe("an anchor loads its note when a tool call names the file", () => {
  test("Edit, Write and NotebookEdit: a gotcha whole, another kind as its title", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "cents", scope: SCOPE, title: "Amounts are integer cents", anchors: ["src/pay.ts#charge"], body: "A float gave totals that were off by one cent." });
    putNote(store, { id: "one-table", scope: SCOPE, kind: "decision", title: "src keeps its state in one table", anchors: ["src"] });
    putNote(store, { id: "global", anchors: ["src/pay.ts"] });
    putNote(store, { id: "moved", scope: SCOPE, anchors: ["src/pay.ts"], promoted_to: "CLAUDE.md" });
    const file = join(repo, "src/pay.ts");
    expect(edit(store.home, repo, file)).toEqual({
      context: [
        "kb has notes on src/pay.ts.",
        "",
        "### cents [gotcha] Amounts are integer cents",
        "anchor on src/pay.ts",
        "A float gave totals that were off by one cent.",
        "",
        "Read the notes that apply with `kb show <id>`:",
        "- one-table [decision] src keeps its state in one table",
      ].join("\n"),
    });
    expect(edit(store.home, repo, file)).toEqual({});
    expect(edit(store.home, repo, file, "Write", { session: "s2" }).context).toContain("### cents ");
    // A new file in an anchored folder, and a notebook, which names its file notebook_path.
    expect(edit(store.home, repo, join(repo, "src/new.ipynb"), "NotebookEdit", { session: "s3" }).context).toBe("kb has notes on src/new.ipynb. Read the notes that apply with `kb show <id>`:\n- one-table [decision] src keeps its state in one table");
    expect(edit(store.home, repo, join(repo, "README.md"), "Write", { session: "s4" })).toEqual({});
    expect(edit(store.home, repo, "src/pay.ts", "Edit", { session: "s4" })).toEqual({});
    expect(logged(store).slice(0, 2)).toEqual([
      { ev: "fire", session: "s1", scope: SCOPE, note: "cents", kind: "path", form: "body", match: "src/pay.ts", tool: "Edit" },
      { ev: "fire", session: "s1", scope: SCOPE, note: "one-table", kind: "path", form: "title", match: "src/pay.ts", tool: "Edit" },
    ]);
  });

  test("a shell command that names the path: relative, absolute, under a folder, after a cd", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "cents", scope: SCOPE, kind: "decision", anchors: ["src/pay.ts"] });
    putNote(store, { id: "docs-rule", scope: SCOPE, kind: "decision", anchors: ["docs/"] });
    let n = 0;
    /** The ids a command loads, each time for a new session. */
    const named = (command: string, cwd = repo) => [...(bash(store.home, cwd, command, { session: `c${n++}` }).context ?? "").matchAll(/^- (\S+)/gm)].map((m) => m[1]);
    expect(bash(store.home, repo, "sed -n 1,20p src/pay.ts", { session: "first" }).context).toBe("kb has notes on files that this command names. Read the ones that apply with `kb show <id>`:\n- cents [decision] Title of cents");
    expect(named(`cat ${repo}/src/pay.ts | head -3`)).toEqual(["cents"]);
    expect(named("git diff HEAD~1 -- ./src/pay.ts docs/a.md")).toEqual(["cents", "docs-rule"]);
    expect(named("git show HEAD:src/pay.ts")).toEqual(["cents"]);
    expect(named("echo x >> src/pay.ts")).toEqual(["cents"]);
    expect(named("ls docs")).toEqual(["docs-rule"]);
    expect(named("wc -l 'docs/a.md'")).toEqual(["docs-rule"]);
    expect(named("cat src/pay.ts", plain())).toEqual([]);
    expect(named(`cd ${repo} && cat src/pay.ts`, plain())).toEqual(["cents"]);
    // The path of the anchor is inside a longer name, or under another folder: it is another file.
    for (const command of ["cat src/pay.tsx", "cat src/pay.ts.bak", "cat vendor/src/pay.ts", "cat mydocs/a.md", "cat docs.md", "echo src/pay", "cat /home/user/other/src/pay.ts"]) expect(named(command)).toEqual([]);
    // The body of a heredoc is data: a note that is written must not load the notes on the files it names.
    expect(named("kb add --json <<'KB_NOTE'\n{\"anchors\": [\"src/pay.ts\"]}\nKB_NOTE")).toEqual([]);
  });

  test("the Read hook and this hook share one record, so a note comes once for a file", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "cents", scope: SCOPE, anchors: ["src/pay.ts"] });
    const file = join(repo, "src/pay.ts");
    const read = () => run(READ_HOOK, store.home, { ...base(repo, {}), hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: file }, tool_response: {} }).stdout;
    expect(JSON.parse(read()).hookSpecificOutput.additionalContext).toBe(`kb has notes on src/pay.ts.\n\n### cents [gotcha] Title of cents\nanchor on src/pay.ts\n${readNote(store, "cents")}`);
    expect(edit(store.home, repo, file)).toEqual({});
    expect(bash(store.home, repo, "cat src/pay.ts")).toEqual({});
    expect(read()).toBe("");
  });
});

/** The body of a note in the store. */
const readNote = (store: Store, id: string) => store.find(id)!.body;

describe("the trigger table", () => {
  const table = (store: Store) => JSON.parse(readFileSync(store.statePath("triggers.json"), "utf8")) as { sig: string; notes: { id: string }[] };
  const fires = (store: Store, repo: string, command: string, session: string) => [...(bash(store.home, repo, command, { session }).context ?? "").matchAll(/^### (\S+)/gm)].map((m) => m[1]);

  test("holds only the notes that can load at a trigger, and is built again when a note changes", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "zorp-wipe", triggers: ["cmd: zorp --wipe", "err: flux capacitor underflow"] });
    putNote(store, { id: "on-file", scope: SCOPE, anchors: ["src/pay.ts", "."] });
    putNote(store, { id: "plain" });
    putNote(store, { id: "root-only", scope: SCOPE, anchors: ["."] });
    putNote(store, { id: "moved", triggers: ["cmd: zorp --wipe"], promoted_to: "CLAUDE.md" });
    putNote(store, { id: "in-trash", triggers: ["cmd: zorp --wipe"] }, true);
    // A trigger that a later kb wrote, and one that a hand edit broke, load nothing.
    putNote(store, { id: "later", triggers: ["prompt: deploy", "cmd: ls"] });
    expect(existsSync(store.statePath("triggers.json"))).toBe(false);
    expect(fires(store, repo, "zorp --wipe", "s1")).toEqual(["zorp-wipe"]);
    const first = table(store);
    expect(first.notes).toEqual([
      { id: "on-file", scope: SCOPE, kind: "gotcha", cmd: [], stop: [], err: [], paths: ["src/pay.ts"] },
      { id: "zorp-wipe", scope: "global", kind: "gotcha", cmd: [["zorp", "--wipe"]], stop: [], err: ["flux capacitor underflow"], paths: [] },
    ] as never);
    // No note changed: the table stays as it is.
    bash(store.home, repo, "git status");
    expect(table(store).sig).toBe(first.sig);

    // A new note, as `kb add` or a pull from another machine writes it.
    expect(kb(store, ["add", "--json"], { cwd: repo, stdin: JSON.stringify({ title: "frob sync needs a token", kind: "gotcha", scope: "global", triggers: ["cmd: frob sync"], body: "Set FROB_TOKEN first." }) }).json.status).toBe("created");
    expect(fires(store, repo, "frob sync", "s2")).toEqual(["frob-sync-needs-a-token"]);
    expect(table(store).sig).not.toBe(first.sig);

    // An edit by hand: the trigger of the note is another command now.
    const note = store.find("zorp-wipe")!;
    writeFileSync(note.path, serializeNote({ ...note, triggers: ["cmd: zorp --purge"] }));
    expect(fires(store, repo, "zorp --wipe", "s3")).toEqual([]);
    expect(fires(store, repo, "zorp --purge", "s3")).toEqual(["zorp-wipe"]);

    // A note in the trash loads no more, and comes back with a restore.
    kb(store, ["trash", "zorp-wipe"]);
    expect(fires(store, repo, "zorp --purge", "s4")).toEqual([]);
    kb(store, ["restore", "zorp-wipe"]);
    expect(fires(store, repo, "zorp --purge", "s4")).toEqual(["zorp-wipe"]);
  });

  test("a table that is broken or gone is built again, and a note that is gone since loads nothing", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "zorp-wipe", triggers: ["cmd: zorp --wipe"] });
    expect(fires(store, repo, "zorp --wipe", "s1")).toEqual(["zorp-wipe"]);
    writeFileSync(store.statePath("triggers.json"), "{ not json");
    expect(fires(store, repo, "zorp --wipe", "s2")).toEqual(["zorp-wipe"]);
    rmSync(store.statePath("triggers.json"));
    expect(fires(store, repo, "zorp --wipe", "s3")).toEqual(["zorp-wipe"]);
    // A table that names a note with no file: the hook gives nothing, and records nothing for it.
    const saved = table(store);
    writeFileSync(store.statePath("triggers.json"), JSON.stringify({ ...saved, notes: [{ ...saved.notes[0], id: "ghost" }] }));
    expect(bash(store.home, repo, "zorp --wipe", { session: "s4" })).toEqual({});
    expect(existsSync(join(store.statePath("by-path"), "s4", "ghost"))).toBe(false);
  });

  test("the state of the table is not in git", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "zorp-wipe", triggers: ["cmd: zorp --wipe"] });
    bash(store.home, repo, "zorp --wipe");
    expect(readFileSync(join(store.home, ".gitignore"), "utf8").split("\n")).toContain(".state/");
  });
});

describe("the hook never breaks a tool call", () => {
  test("it prints nothing and exits 0 for odd input, an unknown event, a tool it does not know, and no store", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "zorp-wipe", triggers: ["cmd: zorp --wipe"] });
    const call = { ...base(repo, {}), hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "zorp --wipe" } };
    for (const body of ["", "not json", "null", "[]", "7", JSON.stringify({}), JSON.stringify({ ...call, tool_input: null }), JSON.stringify({ ...call, tool_input: { command: 7 } }), JSON.stringify({ ...call, hook_event_name: "PostToolUse" }), JSON.stringify({ ...call, hook_event_name: "PreToolUse", tool_name: "Glob" })]) {
      expect(run(HOOK, store.home, body)).toEqual({ code: 0, stdout: "" });
    }
    expect(run(HOOK, join(tempDir(), "none"), call)).toEqual({ code: 0, stdout: "" });
    // A session id that is no file name gives the note, and records nothing.
    expect(run(HOOK, store.home, { ...call, session_id: "../../x" }).stdout).toContain("zorp-wipe");
    // A store with a note file that does not parse still answers for the other notes.
    writeFileSync(join(store.home, "notes", "global", "broken.md"), "no frontmatter");
    expect(run(HOOK, store.home, { ...call, session_id: "s9" }).stdout).toContain("zorp-wipe");
  });
});
