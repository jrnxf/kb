import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordUnsaved } from "../cli/session.ts";
import type { Store } from "../cli/store.ts";
import { readConversation, worthRecovering } from "../hooks/transcript.ts";
import { ROOT, kb, putNote, sh, tempDir, tempRepo, tempStore } from "./helpers.ts";

const write = (lines: unknown[]) => {
  const path = join(tempDir("kb-transcript-"), "s1.jsonl");
  writeFileSync(path, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
  return path;
};
const user = (content: unknown, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const agent = (content: unknown[], extra = {}) => ({ type: "assistant", message: { role: "assistant", content }, ...extra });
const says = (text: string) => agent([{ type: "text", text }]);
// A slash command, as Claude Code writes it: a built-in command, and a skill.
const command = (name: string, args = "") => user(`<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`);
const skill = (name: string, args = "") => user(`<command-message>${name}</command-message>\n<command-name>/${name}</command-name>${args ? `\n<command-args>${args}</command-args>` : ""}`);

// /kb:recover hands this text to a subagent. A tool result can hold a secret, so it must never get through.
describe("the transcript reader", () => {
  const path = write([
    { type: "summary", summary: "a title" },
    user("Fix the login bug <system-reminder>harness text</system-reminder>"),
    agent([{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "I will look." }]),
    agent([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat .env" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "API_KEY=SECRET123" }]),
    says("The cookie had no SameSite."),
    user([{ type: "text", text: "Why?" }, { type: "image", source: {} }]),
    user("sidechain prompt", { isSidechain: true }),
    agent([{ type: "text", text: "subagent work" }], { isSidechain: true }),
    user("Summary of the earlier part", { isCompactSummary: true }),
    user("<local-command-stdout>output of /cost</local-command-stdout>"),
    user("Caveat: ...", { isMeta: true }),
    user("<task-notification><status>completed</status><result>background result</result></task-notification>"),
    "{not json",
    // A line that parses to no object must not stop the read.
    "null",
    "7",
    says("Because the proxy drops it."),
  ]);

  test("keeps what the user and the agent said, one heading per turn", () => {
    const text = "## user\n\nFix the login bug\n\n## agent\n\nI will look.\n\nThe cookie had no SameSite.\n\n## user\n\nWhy?\n\n## agent\n\nBecause the proxy drops it.\n";
    expect(readConversation(path)).toEqual({ prompts: 2, chars: "Fix the login bugI will look.The cookie had no SameSite.Why?Because the proxy drops it.".length, text });
  });

  test("leaves out tool calls, tool output, thinking, subagents and harness text", () => {
    const { text } = readConversation(path);
    for (const left of ["SECRET123", ".env", "private reasoning", "subagent work", "harness text", "/cost", "Summary of the earlier part", "Caveat", "background result"]) expect(text).not.toContain(left);
  });

  // A `!` command is a shell command, and its output is tool output.
  test("leaves out a ! shell command and its output", () => {
    const read = readConversation(
      write([
        user("Deploy it"),
        user("<bash-input>cat .env</bash-input>"),
        user("<bash-stdout>API_KEY=SECRET123</bash-stdout><bash-stderr>warn: TOKEN=SECRET456</bash-stderr>"),
        // Output that holds its own closing tag, such as a file that names the tag.
        user("<bash-stdout>const tag = '</bash-stdout>';\nTOKEN=SECRET789</bash-stdout><bash-stderr></bash-stderr>"),
        user("<local-command-stdout>a </local-command-stdout> b SECRET000</local-command-stdout>"),
        says("Done."),
      ]),
    );
    expect(read).toEqual({ prompts: 1, chars: "Deploy itDone.".length, text: "## user\n\nDeploy it\n\n## agent\n\nDone.\n" });
  });

  test("a slash command with no arguments is a short marker, and no prompt", () => {
    const read = readConversation(write([command("clear"), user("<local-command-stdout></local-command-stdout>"), user("Fix the login bug"), says("Done."), skill("billing:deploy"), says("Deployed.")]));
    expect(read.prompts).toBe(1);
    expect(read.chars).toBe("Fix the login bugDone.Deployed.".length);
    expect(read.text).toBe("## user\n\n(the user ran /clear)\n\nFix the login bug\n\n## agent\n\nDone.\n\n## user\n\n(the user ran /billing:deploy)\n\n## agent\n\nDeployed.\n");
    // A prompt that only names the tags is still a prompt.
    expect(readConversation(write([user("Why does <command-name>/clear</command-name> show in the file?")])).prompts).toBe(1);
  });

  // A custom command gets the user's whole instruction as its arguments. Those are the user's words.
  test("the arguments of a slash command are a prompt, with the command name in front", () => {
    const task = "Move the rate table to the config file.\nKeep the old keys for one release.";
    const read = readConversation(write([skill("billing:task", task), says("Moved."), command("model", "sonnet"), skill("billing:deploy", "staging now"), says("Deployed.")]));
    expect(read.prompts).toBe(3);
    // The name of the command is not the user's own words, so it does not count.
    expect(read.chars).toBe(`${task}Moved.sonnetstaging nowDeployed.`.length);
    expect(read.text).toBe(`## user\n\n/billing:task ${task}\n\n## agent\n\nMoved.\n\n## user\n\n/model sonnet\n\n/billing:deploy staging now\n\n## agent\n\nDeployed.\n`);
  });

  test("a stop by the user is no prompt", () => {
    const read = readConversation(write([user("Run the tests"), user([{ type: "text", text: "[Request interrupted by user for tool use]" }]), user("Only the unit tests")]));
    expect(read.prompts).toBe(2);
    expect(read.chars).toBe("Run the testsOnly the unit tests".length);
    expect(read.text).toContain("[Request interrupted by user for tool use]");
  });

  // The words the user types into a permission prompt or a question are corrections. They arrive in a tool result.
  describe("the user's own words in a tool result", () => {
    const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
    const rejected = (id: string, rest: string) => user([{ type: "tool_result", tool_use_id: id, is_error: true, content: `${REJECTED} ${rest}` }], { toolUseResult: "Error: rejected", toolDenialKind: "user-rejected" });
    const path = write([
      user("Deploy the site"),
      agent([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "deploy --prod" } }]),
      rejected("t1", "To tell you how to proceed, the user said:\nNever deploy from a branch. Use the preview.\n\nNote: The user's next message may contain a correction or preference. Pay close attention."),
      agent([{ type: "tool_use", id: "t2", name: "Bash", input: { command: "deploy --preview" } }]),
      rejected("t2", "STOP what you are doing and wait for the user to tell you how to proceed."),
      agent([{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which region?" }, { question: "Keep the old build?" }] } }]),
      user([{ type: "tool_result", tool_use_id: "q1", content: 'User has answered your questions: "Which region?"="Lisbon". You can now continue.' }], {
        toolUseResult: { questions: [{ question: "Which region?" }, { question: "Keep the old build?" }], answers: { "Which region?": "Lisbon", "Keep the old build?": "No" }, annotations: { "Keep the old build?": { notes: "It is broken." } } },
      }),
      // Another tool cannot pass its output as an answer or as a reason.
      agent([{ type: "tool_use", id: "t3", name: "mcp__forms__read", input: {} }]),
      user([{ type: "tool_result", tool_use_id: "t3", content: "form output" }], { toolUseResult: { answers: { "Token?": "SECRET123" } } }),
      agent([{ type: "tool_use", id: "t4", name: "Read", input: { file_path: "notes.txt" } }]),
      user([{ type: "tool_result", tool_use_id: "t4", content: `${REJECTED} To tell you how to proceed, the user said:\nSECRET456` }]),
      says("Deployed to the preview."),
    ]);

    test("keeps the reason for a rejected tool call and the answer to a question", () => {
      const { text, prompts } = readConversation(path);
      expect(text).toBe(
        "## user\n\nDeploy the site\n\n(the user rejected a tool call and said)\nNever deploy from a branch. Use the preview.\n\n(the user answered a question)\nQ: Which region?\nA: Lisbon\n\nQ: Keep the old build?\nA: No\nNote: It is broken.\n\n## agent\n\nDeployed to the preview.\n",
      );
      expect(prompts).toBe(3);
    });

    test("keeps nothing else from a tool result", () => {
      const { text } = readConversation(path);
      for (const left of ["SECRET", "form output", "STOP what you are doing", "was rejected", "next message", "deploy --prod", "User has answered"]) expect(text).not.toContain(left);
    });
  });

  // A session that only ran /kb:recover holds the report on another session, which is saved already.
  describe("a /kb:recover turn", () => {
    const report = `**Recovered the session of 2026-01-05 in /home/user/shop** - 3 saved\n${"A note about the shop. ".repeat(200)}`;
    const recover = [
      skill("kb:recover"),
      user([{ type: "text", text: "# kb recover\nThe skill text." }], { isMeta: true }),
      says("I will read the session."),
      agent([{ type: "tool_use", id: "a1", name: "Agent", input: { prompt: "Do its checkpoint now." } }]),
      user([{ type: "tool_result", tool_use_id: "a1", content: report }]),
      says(report),
      agent([{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Does this rule still hold: no deploy on a Friday?" }] } }]),
      user([{ type: "tool_result", tool_use_id: "q1", content: "User has answered your questions." }], { toolUseResult: { questions: [], answers: { "Does this rule still hold: no deploy on a Friday?": "Still holds" } } }),
      says("I wrote the rule. This session still needs its own /kb:checkpoint if it did other work."),
    ];

    test("counts for nothing and leaves no text", () => {
      expect(readConversation(write([command("clear"), ...recover]))).toEqual({ prompts: 0, chars: 0, text: "## user\n\n(the user ran /clear)\n" });
      // Its argument is no prompt of the session either.
      expect(readConversation(write([command("clear"), skill("kb:recover", "forget"), says("I forgot 2 sessions.")]))).toEqual({ prompts: 0, chars: 0, text: "## user\n\n(the user ran /clear)\n" });
    });

    test("ends at the next prompt, so the work around it still counts", () => {
      const read = readConversation(write([user("Fix the cart total"), says("The tax was added twice."), ...recover, user("Now fix the rounding"), says("Rounded to cents.")]));
      expect(read.prompts).toBe(2);
      expect(read.text).toBe("## user\n\nFix the cart total\n\n## agent\n\nThe tax was added twice.\n\n## user\n\nNow fix the rounding\n\n## agent\n\nRounded to cents.\n");
      expect(read.chars).toBe("Fix the cart totalThe tax was added twice.Now fix the roundingRounded to cents.".length);
    });
  });

  test("a file that cannot be read has no size, which is not the size 0", () => {
    expect(worthRecovering(join(tempDir(), "missing.jsonl"))).toBeNull();
    expect(worthRecovering(write([]))).toEqual({ prompts: 0, chars: 0 });
    if (process.getuid?.() === 0) return; // root reads every file
    chmodSync(path, 0o000);
    try {
      expect(worthRecovering(path)).toBeNull();
    } finally {
      chmodSync(path, 0o600);
    }
    expect(worthRecovering(path)).toEqual({ prompts: 2, chars: expect.any(Number) });
  });
});

// What a session said can hold a secret the user typed. The file is private, and it does not stay.
describe("kb-transcript", () => {
  const run = (store: Store, ...args: string[]) => {
    const r = Bun.spawnSync([join(ROOT, "bin", "kb-transcript"), ...args], { cwd: tempDir(), env: { ...process.env, KB_HOME: store.home }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const lost = (store: Store, session: string, cwd: string, ended = new Date().toISOString()) => {
    const transcript = write([user("Fix the login bug"), says("The cookie had no SameSite.")]);
    recordUnsaved(store, { session, transcript, cwd, ended });
    return transcript;
  };
  const recoverFile = (store: Store, session: string) => join(store.home, ".state", "recover", `${session}.md`);

  test("writes the conversation to a private file in the store's state folder, under the commits made since", () => {
    const store = tempStore();
    const repo = tempRepo();
    const first = sh(repo, "git", "rev-parse", "--short", "HEAD");
    lost(store, "s1", repo, "2020-01-01T00:00:00.000Z");
    const r = run(store, "s1");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toEqual({ file: recoverFile(store, "s1"), prompts: 1, chars: expect.any(Number) });
    expect(readFileSync(out.file, "utf8")).toBe(`# Session that ended 2020-01-01T00:00:00.000Z in ${repo}\n\nCommits in that directory since it ended:\n${first} init\n\nNotes that an earlier /kb:recover of this session saved:\nnone\n\n## user\n\nFix the login bug\n\n## agent\n\nThe cookie had no SameSite.\n`);
    expect(statSync(out.file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(out.file)).mode & 0o777).toBe(0o700);
    // .state/ is never committed.
    expect(readFileSync(join(store.home, ".gitignore"), "utf8")).toContain(".state/");

    // A session that ended after the last commit, or outside a repo, has no commit to show.
    lost(store, "s2", repo, new Date(Date.now() + 60_000).toISOString());
    lost(store, "s3", tempDir());
    for (const session of ["s2", "s3"]) expect(readFileSync(JSON.parse(run(store, session).out).file, "utf8")).toContain("since it ended:\nnone\n\nNotes that");
  });

  // A search can miss a note that says the same fact in other words. The list cannot.
  test("names the notes that an earlier recovery of the session saved, so a second one adds no twin", () => {
    const store = tempStore();
    const dir = tempDir();
    const ended = "2020-01-01T00:00:00.500Z";
    lost(store, "s1", dir, ended);
    lost(store, "s2", dir, ended);
    // The titles here share most of their words. "new" says that each note is its own fact.
    const add = (flags: string[], note: object) => kb(store, ["add", "--json", ...flags], { stdin: JSON.stringify({ kind: "gotcha", body: "x", scope: "global", new: true, ...note }), cwd: dir });
    const from = (session: string, note: object) => add(["--as-of", ended, "--recovered-from", session], note);
    const retries = from("s1", { title: "The provider retries a webhook for 3 days" }).json.id;
    const retired = from("s1", { title: "The old queue drops a job" }).json.id;
    const deleted = from("s1", { title: "A note that is deleted later" }).json.id;
    // The same time of the same day proves nothing: only the flag records a note.
    from("s2", { title: "A note from the recovery of another session" });
    add(["--as-of", ended], { title: "A note with the same time and no session" });
    putNote(store, { id: "checked-later", last_verified: "2021-01-01T00:00:00Z" });
    // A note that exists already, or that somebody checked later, is not a note of this recovery.
    expect(from("s1", { title: "A note with the same time and no session" }).json.status).toBe("exists");
    expect(from("s1", { id: "checked-later", body: "old text" }).json.status).toBe("newer");
    // An update is: the recovery added a fact to it.
    putNote(store, { id: "an-older-note", last_verified: "2019-01-01T00:00:00Z" });
    expect(from("s1", { id: "an-older-note", body: "with the fact of the session" }).json.status).toBe("updated");
    expect(from("s1", { id: "an-older-note", body: "with one more fact" }).json.status).toBe("updated");

    // A later check or edit moves the note's time. The list must still hold it.
    kb(store, ["verify", retries], { cwd: dir });
    kb(store, ["add", "--json"], { stdin: JSON.stringify({ id: retries, body: "edited today" }), cwd: dir });
    kb(store, ["trash", retired]);
    kb(store, ["delete", deleted]);
    expect(store.find(retries)!.last_verified > "2026").toBe(true);

    const text = readFileSync(JSON.parse(run(store, "s1").out).file, "utf8");
    expect(text).toContain(
      `Notes that an earlier /kb:recover of this session saved:\n${retries} | The provider retries a webhook for 3 days\n${retired} (in the trash) | The old queue drops a job\nan-older-note | Title of an-older-note\n\n## user`,
    );
  });

  test("--recovered-from needs an unsaved session, and writes nothing without one", () => {
    const store = tempStore();
    const dir = tempDir();
    const note = JSON.stringify({ title: "Never written", kind: "gotcha", body: "x", scope: "global" });
    const result = kb(store, ["add", "--json", "--recovered-from", "nobody"], { stdin: note, cwd: dir });
    expect(result).toMatchObject({ code: 1, json: { error: "no unsaved session nobody. `kb unsaved` lists them." } });
    expect(kb(store, ["add", "--recovered-from"], { stdin: note })).toMatchObject({ code: 1, stderr: "--recovered-from needs a value\n" });
    expect(store.notes()).toEqual([]);
    // The mark keeps its age, so a record of a note does not keep the session for 7 more days.
    lost(store, "s1", dir);
    const mark = join(store.home, ".state", "unsaved-s1.json");
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(mark, threeDaysAgo, threeDaysAgo);
    expect(kb(store, ["add", "--json", "--recovered-from", "s1"], { stdin: note, cwd: dir }).json.status).toBe("created");
    expect(JSON.parse(readFileSync(mark, "utf8")).notes).toEqual(["never-written"]);
    expect(Math.abs(statSync(mark).mtimeMs - threeDaysAgo.getTime())).toBeLessThan(1000);
  });

  test("reads only a session that has a mark", () => {
    const store = tempStore();
    expect(run(store, "nobody")).toEqual({ code: 1, out: '{"error":"no unsaved session nobody. `kb unsaved` lists them."}\n', err: "" });
    expect(run(store)).toMatchObject({ code: 1, out: "" });
    expect(existsSync(join(store.home, ".state", "recover"))).toBe(false);
  });

  // A stack trace names the raw transcript, and an agent that sees it can go and read the tool output there.
  test("a transcript that cannot be read gives one JSON error, with no path and no stack", () => {
    if (process.getuid?.() === 0) return; // root reads every file
    const store = tempStore();
    const dir = tempDir();
    const transcript = lost(store, "locked", dir);
    chmodSync(transcript, 0o000);
    try {
      const r = run(store, "locked");
      expect(r).toEqual({ code: 1, out: '{"error":"the conversation of session locked cannot be read now (EACCES). Its mark stays."}\n', err: "" });
      expect(existsSync(recoverFile(store, "locked"))).toBe(false);
      expect(kb(store, ["unsaved", "--json"], { cwd: dir }).json).toMatchObject([{ session: "locked" }]);
    } finally {
      chmodSync(transcript, 0o600);
    }
    expect(run(store, "locked").code).toBe(0);
  });

  test("the file goes when the session is marked or forgotten, when its transcript is gone, and after 7 days", () => {
    const store = tempStore();
    const dir = tempDir();
    const file = (session: string) => {
      lost(store, session, dir);
      return JSON.parse(run(store, session).out).file as string;
    };
    const marked = file("marked");
    const forgotten = file("forgotten");
    expect(existsSync(marked) && existsSync(forgotten)).toBe(true);
    kb(store, ["checkpointed", "marked"]);
    expect(existsSync(marked)).toBe(false);
    expect(existsSync(forgotten)).toBe(true);
    kb(store, ["unsaved", "--forget", "forgotten"]);
    expect(existsSync(forgotten)).toBe(false);

    const transcript = lost(store, "no-transcript", dir);
    const orphan = JSON.parse(run(store, "no-transcript").out).file as string;
    const old = file("old");
    const fresh = file("fresh");
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    // The record of the day the user was told about unsaved sessions ages the same way.
    const told = ["told-0123456789abcdef-2020-01-01", "told-0123456789abcdef-2020-01-02"].map((name) => join(store.home, ".state", name));
    for (const path of told) writeFileSync(path, "");
    utimesSync(told[0]!, eightDaysAgo, eightDaysAgo);
    writeFileSync(transcript, "");
    sh(dir, "rm", transcript);
    // Each session start lists the unsaved sessions, and so does `kb unsaved`.
    kb(store, ["unsaved"], { cwd: dir });
    expect([orphan, old, fresh].map((path) => existsSync(path))).toEqual([false, false, true]);
    expect(told.map((path) => existsSync(path))).toEqual([false, true]);
  });
});
