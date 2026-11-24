import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIEF_BODY_CHARS, BRIEF_NEXT_CHARS, FORMAT_LINE, MAX_BRIEFS, SAVE_RULE, briefBlock, budgetOf, buildBudget, buildContext, contextBudget, contextFor, indexLine } from "../cli/context.ts";
import { OLD_GLOBAL_NOTES, OLD_INDEX_LINES, inHoldback } from "../cli/holdback.ts";
import { rememberRepo } from "../cli/repos.ts";
import { slugify } from "../cli/note.ts";
import { HARD_CONTEXT_CAP, type StoredNote } from "../cli/store.ts";
import { ROOT, kb, logAt, otherMachine, plain, putNote, sh, tempDir, tempRepo, tempStore } from "./helpers.ts";

const REMOTE = "git@github.com:acme/billing.git";
const SCOPE = "github.com/acme/billing";
const POINTER = "`kb show <id>` prints one note. `kb search <words>` searches every note.";
// Noon, so the day is the same in every time zone that a test machine can have.
const NOON = "2026-03-02T12:00:00Z";

function setConfig(home: string, config: Record<string, unknown>) {
  writeFileSync(join(home, "kb.config.json"), JSON.stringify(config));
}

describe("kb context ranking", () => {
  test("orders repo notes before global ones, then by kind, then last activity, then last_verified", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "howto", kind: "how-to", scope: SCOPE });
    putNote(store, { id: "decision", kind: "decision", scope: SCOPE });
    putNote(store, { id: "convention", kind: "convention", scope: SCOPE });
    putNote(store, { id: "gotcha-global", kind: "gotcha" });
    putNote(store, { id: "gotcha-old", kind: "gotcha", scope: SCOPE, last_verified: "2026-02-01T00:00:00Z" });
    putNote(store, { id: "gotcha-new", kind: "gotcha", scope: SCOPE, last_verified: "2026-03-01T00:00:00Z" });
    putNote(store, { id: "gotcha-used", kind: "gotcha", scope: SCOPE });
    putNote(store, { id: "open", kind: "open-work", scope: SCOPE });
    logAt(store, "2026-05-01T00:00:00Z", { ev: "show", note: "gotcha-used", why: "task" });

    const result = buildContext(store, repo);
    expect(result.scope).toBe(SCOPE);
    expect(result.briefs).toEqual(["open"]);
    expect(result.index).toEqual(["gotcha-used", "gotcha-new", "gotcha-old", "convention", "decision", "howto", "gotcha-global"]);
    expect(result).toMatchObject({ hidden: [], triggerOnly: [], bodies: [], holdback: false });
  });

  test("among repo notes of one kind the newest activity goes first: a show for a task, a fire, a verdict helped, or the roll-up of another machine", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    for (const id of ["a-quiet", "b-checked", "c-shown", "d-fired", "e-helped", "f-legacy", "g-not-needed"]) putNote(store, { id, scope: SCOPE });
    logAt(store, "2026-05-01T00:00:00Z", { ev: "show", note: "c-shown", why: "task" });
    logAt(store, "2026-05-02T00:00:00Z", { ev: "fire", kind: "path", form: "title", note: "d-fired", tool: "Read", match: "src/a.ts" });
    logAt(store, "2026-05-03T00:00:00Z", { ev: "verdict", note: "e-helped", verdict: "helped" });
    otherMachine(store, "old", { "f-legacy": { last: "2026-05-04T00:00:00Z" } });
    // A check and a verdict that the note had no bearing are no activity.
    logAt(store, "2026-06-01T00:00:00Z", { ev: "show", note: "b-checked", why: "check" });
    logAt(store, "2026-06-01T00:00:00Z", { ev: "verdict", note: "g-not-needed", verdict: "not-needed" });
    expect(buildContext(store, repo).index).toEqual(["f-legacy", "e-helped", "d-fired", "c-shown", "a-quiet", "b-checked", "g-not-needed"]);
  });

  test("global notes come after the repo's notes, and none is left out: open work first, then last activity, then kind, then last verified", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "repo-note", kind: "how-to", scope: SCOPE });
    putNote(store, { id: "g-howto", kind: "how-to" });
    putNote(store, { id: "g-rule-old", kind: "convention", last_verified: "2026-02-01T00:00:00Z" });
    putNote(store, { id: "g-rule-new", kind: "convention", last_verified: "2026-03-01T00:00:00Z" });
    putNote(store, { id: "g-trap", kind: "gotcha" });
    putNote(store, { id: "g-trap-new", kind: "gotcha", last_verified: "2026-03-01T00:00:00Z" });
    putNote(store, { id: "g-open", kind: "open-work" });
    // A how-to that sessions open keeps its place before the gotchas that no session opened.
    for (const day of ["01", "02", "03"]) logAt(store, `2026-05-${day}T00:00:00Z`, { ev: "show", note: "g-howto", why: "task" });
    // The newest activity counts, not the number of reads: one use on a later day goes first.
    otherMachine(store, "old", { "g-howto": { last: "2026-05-01T00:00:00Z" }, "g-rule-old": { last: "2026-05-04T00:00:00Z" } });
    const result = buildContext(store, repo);
    // The notes with no activity come after those with some: by kind, then the newest check.
    expect(result.index).toEqual(["repo-note", "g-open", "g-rule-old", "g-howto", "g-trap-new", "g-trap", "g-rule-new"]);
    expect(result.hidden).toEqual([]);
    expect(result.text).not.toContain("left out");
  });

  test("a budget that kb does not know is ignored, and a wrong value falls back", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    setConfig(store.home, { budgets: { indexLines: 2, globalIndexLines: 1, contextChars: 8000 } });
    expect(store.config()).toMatchObject({ budgets: { contextChars: 8000, briefChars: 1500 }, holdback: 0.1 });
    // No count of lines holds: every note gets a line.
    for (let i = 0; i < 4; i++) putNote(store, { id: `r-${i}`, scope: SCOPE });
    for (let i = 0; i < 4; i++) putNote(store, { id: `g-${i}` });
    expect(buildContext(store, repo)).toMatchObject({ index: ["r-0", "r-1", "r-2", "r-3", "g-0", "g-1", "g-2", "g-3"], hidden: [] });
    setConfig(store.home, { budgets: { globalIndexLines: null, contextChars: "many", briefChars: -1 }, holdback: 5 });
    expect(store.config()).toMatchObject({ budgets: { contextChars: 8000, briefChars: 1500 }, holdback: 0.1 });
    // 0 is a choice for both: no briefs, and no hold-back arm.
    setConfig(store.home, { budgets: { briefChars: 0 }, holdback: 0 });
    expect(store.config()).toMatchObject({ budgets: { contextChars: 8000, briefChars: 0 }, holdback: 0 });
  });

  test("an index line keeps the words of the title that the id cut", () => {
    const line = (id: string, title: string) => indexLine({ id, title, kind: "gotcha" } as StoredNote);
    // The gotcha is in the last word. The id alone would lose it.
    const title = "The deploy CLI exits 0 when the upload was rejected";
    expect(slugify(title)).toBe("the-deploy-cli-exits-0-when-the-upload-was");
    expect(line(slugify(title), title)).toBe("- the-deploy-cli-exits-0-when-the-upload-was [gotcha] ...rejected");
    const long = "Never run the migration tool against the shared staging database (it is shared)";
    expect(line(slugify(long), long)).toBe("- never-run-the-migration-tool-against-the-shared [gotcha] ...staging database (it is shared)");
    // An id that is the whole title stands alone: the title would say it twice.
    expect(line("amounts-are-integer-cents", "Amounts are integer cents!")).toBe("- amounts-are-integer-cents [gotcha]");
    // A mark that the id holds without loss does not bring the title, and the cut words still follow.
    expect(line("it-s-fine-today", "It’s fine — today →")).toBe("- it-s-fine-today [gotcha]");
    expect(line("the-deploy-cli-exits-0-when-the-upload-was", "The deploy CLI exits 0 when the upload was rejected → 🚀")).toBe("- the-deploy-cli-exits-0-when-the-upload-was [gotcha] ...rejected → 🚀");
    // A word that the id lost brings the whole title.
    expect(line("v2-12345678", "v2 の問題")).toBe("- v2-12345678 [gotcha] v2 の問題");
    // An id that does not come from the title gets the whole title.
    expect(line("two", "A global fact")).toBe("- two [gotcha] A global fact");
    expect(line("amounts-are-integer-cents-2", "Amounts are integer cents")).toBe("- amounts-are-integer-cents-2 [gotcha] Amounts are integer cents");
  });
});

describe("what a session start gives", () => {
  test("the fixed text, the open work of the repo in short form, the index, then the pointer", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "work", kind: "open-work", scope: SCOPE, title: "Ship the export", last_verified: NOON, body: "State: the cursor works.\nNext: write the pager.\nDone when an export pages." });
    putNote(store, { id: "three", kind: "how-to", scope: SCOPE, title: "A repo fact" });
    putNote(store, { id: "two", kind: "convention", title: "A global fact" });
    const result = buildContext(store, repo);
    expect(result.text).toBe(
      [
        `# kb: saved knowledge for ${SCOPE}`,
        FORMAT_LINE,
        // The write path comes before the notes, so the budget can never cut it.
        SAVE_RULE,
        "",
        "## Open work",
        "### work [open-work] Ship the export",
        "Next: write the pager.",
        "Verified 2026-03-02. `kb show work` prints the rest.",
        "",
        "## Index",
        // The repo's own notes come first, so global notes never crowd them out.
        `### ${SCOPE} (1)`,
        "- three [how-to] A repo fact",
        "### global (1)",
        "- two [convention] A global fact",
        "",
        POINTER,
        "",
      ].join("\n"),
    );
    expect(result).toMatchObject({ briefs: ["work"], index: ["three", "two"], triggerOnly: [], hidden: [], bodies: [], holdback: false });
    // The parts add up to the text.
    const { fixed, briefs, index, bodies } = result.charsBy;
    expect(briefs).toBe("\n## Open work\n### work [open-work] Ship the export\nNext: write the pager.\nVerified 2026-03-02. `kb show work` prints the rest.\n".length);
    expect(bodies).toBe(0);
    expect(fixed + briefs + index).toBe(result.chars);
    expect(result.chars).toBe(result.text.length);
  });

  test("no gotcha, convention, decision or how-to gets its body: each is one index line", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    const kinds = ["gotcha", "convention", "decision", "how-to"] as const;
    for (const kind of kinds) {
      putNote(store, { id: `repo-${kind}`, kind, scope: SCOPE, body: `BODY of the repo ${kind}` });
      putNote(store, { id: `global-${kind}`, kind, body: `BODY of the global ${kind}` });
    }
    const result = buildContext(store, repo);
    expect(result.text).not.toContain("BODY");
    expect(result.text).not.toContain("## Notes");
    expect(result.text).not.toContain("## Open work");
    expect(result.bodies).toEqual([]);
    expect(result.index).toHaveLength(8);
    for (const kind of kinds) for (const where of ["repo", "global"]) expect(result.text).toContain(`\n- ${where}-${kind} [${kind}]`);
  });

  test("the fixed text is three lines: the scope, how to read the notes, and the write path", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "one", scope: SCOPE });
    expect(buildContext(store, repo).text).toStartWith(`# kb: saved knowledge for ${SCOPE}\n${FORMAT_LINE}\n${SAVE_RULE}\n\n## Index`);
    // Every session pays for these lines, so they stay short. The write path keeps its three parts.
    expect(FORMAT_LINE).toContain("once");
    expect(FORMAT_LINE).toContain('"..."');
    expect(FORMAT_LINE.length).toBeLessThanOrEqual(100);
    // `--file` is in the rule, because a shell policy can refuse the JSON in a heredoc.
    for (const part of ["/kb:note", "`kb add --file`", "`kb search`"]) expect(SAVE_RULE).toContain(part);
    expect(FORMAT_LINE.length + SAVE_RULE.length).toBeLessThanOrEqual(400);
  });

  test("a note is printed once: as a brief or as an index line", () => {
    const store = tempStore();
    const ids = Array.from({ length: 12 }, (_, i) => `note-${String(i).padStart(2, "0")}`);
    ids.forEach((id, i) => putNote(store, { id, kind: i < 5 ? "open-work" : "gotcha", last_verified: `2026-01-${String(28 - i).padStart(2, "0")}T12:00:00Z` }));
    const result = buildContext(store, plain());
    expect(result.briefs).toEqual(ids.slice(0, 3));
    expect(result.index).toEqual(ids.slice(3));
    for (const id of ids) {
      const brief = result.text.includes(`\n### ${id} [`);
      expect(brief).toBe(result.briefs.includes(id));
      expect(result.text.includes(`\n- ${id} [`)).toBe(!brief);
    }
  });
});

describe("open work briefs", () => {
  const note = (body: string, id = "work") => ({ id, kind: "open-work" as const, title: "Ship the export", body, last_verified: NOON });
  const HEAD = "### work [open-work] Ship the export\n";
  const REST = "Verified 2026-03-02. `kb show work` prints the rest.";

  test("a brief is the id, the kind and the title, then the Next line, then a pointer to the rest", () => {
    expect(briefBlock(note("State: half done.\nNext: write the pager, then run the suite.\nDone when it pages."))).toBe(`${HEAD}Next: write the pager, then run the suite.\n${REST}`);
    // The first such line counts, and a brief that holds the whole body has no pointer.
    expect(briefBlock(note("Next: merge it.\nNext: never shown."))).toBe(`${HEAD}Next: merge it.\n${REST}`);
    expect(briefBlock(note("Next: merge it."))).toBe(`${HEAD}Next: merge it.\nVerified 2026-03-02.`);
  });

  // The step that a brief shows for a body, or null when the body has no next step and the brief gives its start.
  test.each<[string, string | null]>([
    // The label is "Next", "Next step" or "Next steps", in any case, and a colon follows it.
    ["Next: do b", "Next: do b"],
    ["State.\nnext step: do b", "next step: do b"],
    ["NEXT STEPS: do b, then c", "NEXT STEPS: do b, then c"],
    ["Next : do b", "Next : do b"],
    // A list mark, a number, a checkbox, a quote and bold or italic marks may come first.
    ["- Next: do b", "- Next: do b"],
    ["* Next: do b", "* Next: do b"],
    ["1. Next: do b", "1. Next: do b"],
    ["2) Next: do b", "2) Next: do b"],
    ["- [ ] Next: do b", "- [ ] Next: do b"],
    ["- [x] Next: do b", "- [x] Next: do b"],
    ["1. [ ] **Next:** do b", "1. [ ] **Next:** do b"],
    ["- **Next:** merge it.", "- **Next:** merge it."],
    ["**Next**: merge it.", "**Next**: merge it."],
    ["_Next steps:_ merge it.", "_Next steps:_ merge it."],
    ["> Next: do b", "> Next: do b"],
    // A heading mark goes, so no heading is inside the open-work section.
    ["## Next: do b", "Next: do b"],
    // A sentence that starts with the word is no next step. A real one further down is.
    ["Next.js upgrade is half done.\nNext: do b", "Next: do b"],
    ["Next week the vendor ships.\n- [ ] Next: do b", "- [ ] Next: do b"],
    ["next, after the review: merge it.\n1. Next: do b", "1. Next: do b"],
    ["Next steps for the vendor: call them.\nNext step: do b", "Next step: do b"],
    ["Next.js upgrade is half done.", null],
    ["Next week the vendor ships.", null],
    ["Nextcloud: the sync is down.\nThe next step is not clear.", null],
    ["Next step is to merge: do it.", null],
    ["Next steps", null],
    // A label with no step on its line takes the list or the paragraph below it, after any empty lines.
    ["State.\nNext:\n1. Point the reports at the new table.\n2. Drop the old one.\n\nDone when no query names it.", "Next:\n1. Point the reports at the new table.\n2. Drop the old one."],
    ["## Next steps\n\n- merge it\n- tag it\n\n## Done when\nThe tag is out.", "Next steps\n- merge it\n- tag it"],
    ["### Next\n\n\nWrite the pager,\nthen run the suite.\n## Files\nsrc/a.ts", "Next\nWrite the pager,\nthen run the suite."],
    ["**Next steps:**\n\n- [ ] merge it", "**Next steps:**\n- [ ] merge it"],
    ["## Next step:\nmerge it", "Next step:\nmerge it"],
    // A heading with more words is no label. A label with nothing below it is no next step.
    ["## Next release\n\n- merge it", null],
    ["State.\n## Next steps\n\n## Done when\nIt pages.", null],
    ["State.\nNext:", null],
    ["## Next steps\n\n## Files\nsrc/a.ts\nNext: do b", "Next: do b"],
  ])("the next step of %j is %j", (body, step) => {
    const lines = briefBlock(note(body)).split("\n");
    expect(lines[0]).toBe(HEAD.trimEnd());
    expect(lines.at(-1)).toStartWith("Verified 2026-03-02.");
    const shown = lines.slice(1, -1).join("\n");
    if (step !== null) expect(shown).toBe(step);
    // With no next step the brief gives the start of the body, with no heading marks.
    else expect(shown).toBe(body.replace(/^#+ /gm, ""));
    expect(shown).not.toMatch(/^\s*#/m);
  });

  test("a brief shows no heading, and a line in a code block keeps its #", () => {
    expect(briefBlock(note("## State\nHalf done.\n```sh\n# reset first\nmake db-reset\n```\n### Files\nsrc/a.ts"))).toBe(`${HEAD}State\nHalf done.\n\`\`\`sh\n# reset first\nmake db-reset\n\`\`\`\nFiles\nsrc/a.ts\nVerified 2026-03-02.`);
    // A label and the list below it are the whole body: no pointer, also with an empty line between them.
    expect(briefBlock(note("## Next steps\n\n- merge it"))).toBe(`${HEAD}Next steps\n- merge it\nVerified 2026-03-02.`);
  });

  test("a body with no Next line gives its first 240 characters, and a brief that holds the whole body has no pointer", () => {
    const long = "word ".repeat(100).trim();
    expect(BRIEF_BODY_CHARS).toBe(240);
    expect(briefBlock(note(long))).toBe(`${HEAD}${long.slice(0, 240).trimEnd()}...\n${REST}`);
    expect(briefBlock(note("Blocked on the keychain export."))).toBe(`${HEAD}Blocked on the keychain export.\nVerified 2026-03-02.`);
    // One long Next line is cut, so it cannot take the room of the other briefs.
    const next = `Next: ${"step ".repeat(200).trim()}`;
    expect(briefBlock(note(next))).toBe(`${HEAD}${next.slice(0, BRIEF_NEXT_CHARS).trimEnd()}...\n${REST}`);
  });

  test("at most 3 open-work notes get a brief, the newest verified first, and the others get an index line", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    expect(MAX_BRIEFS).toBe(3);
    // Activity ranks a note in the index. The briefs go by the newest check alone.
    const days = { "w-oldest": "01", "w-old": "02", "w-mid": "03", "w-new": "04", "w-newest": "05" };
    for (const [id, day] of Object.entries(days)) putNote(store, { id, kind: "open-work", scope: SCOPE, last_verified: `2026-03-${day}T12:00:00Z`, body: `Next: finish ${id}.` });
    logAt(store, "2026-05-01T00:00:00Z", { ev: "show", note: "w-oldest", why: "task" });
    putNote(store, { id: "trap", scope: SCOPE });
    const result = buildContext(store, repo);
    expect(result.briefs).toEqual(["w-newest", "w-new", "w-mid"]);
    expect(result.index).toEqual(["w-oldest", "w-old", "trap"]);
    expect(result.text).toContain("\n- w-old [open-work] Title of w-old\n");
    expect(result.text).not.toContain("finish w-old.");
    expect(result.text.match(/^### w-/gm)).toHaveLength(3);
  });

  test("the briefs stay under their character budget: the first one that does not fit ends the list", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    const body = `Next: ${"step ".repeat(60).trim()}`;
    for (const day of ["01", "02", "03"]) putNote(store, { id: `w-${day}`, kind: "open-work", scope: SCOPE, last_verified: `2026-03-${day}T12:00:00Z`, body });
    const one = briefBlock(store.find("w-01")!).length + 1;
    // The default budget of 1,500 characters takes all three.
    expect(one * 3).toBeLessThan(1500);
    expect(buildContext(store, repo).briefs).toEqual(["w-03", "w-02", "w-01"]);
    setConfig(store.home, { budgets: { briefChars: one * 2 + 10 } });
    const result = buildContext(store, repo);
    expect(result.briefs).toEqual(["w-03", "w-02"]);
    expect(result.index).toEqual(["w-01"]);
    expect(result.charsBy.briefs).toBe(one * 2 + "\n## Open work\n".length);
    // 0 turns the briefs off. Open work is then in the index only.
    setConfig(store.home, { budgets: { briefChars: 0 } });
    expect(buildContext(store, repo)).toMatchObject({ briefs: [], index: ["w-03", "w-02", "w-01"] });
  });

  test("a global open-work note is an index line in a repo, and a brief only outside any repo", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "g-work", kind: "open-work", body: "Next: move the laptops." });
    putNote(store, { id: "r-work", kind: "open-work", scope: SCOPE, body: "Next: write the pager." });
    const inRepo = buildContext(store, repo);
    expect(inRepo).toMatchObject({ briefs: ["r-work"], index: ["g-work"] });
    expect(inRepo.text).not.toContain("move the laptops");
    // Another repo has no open work of its own: the global note is still a line there.
    expect(buildContext(store, tempRepo({ remote: "git@github.com:acme/web.git" }))).toMatchObject({ briefs: [], index: ["g-work"] });
    const outside = buildContext(store, plain());
    expect(outside).toMatchObject({ briefs: ["g-work"], index: [] });
    expect(outside.text).toContain("### g-work [open-work] Title of g-work\nNext: move the laptops.\n");
    expect(outside.text).not.toContain("r-work");
  });

  test("open work is never trigger-only: a global open-work note with a trigger keeps its line in a repo", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "g-work", kind: "open-work", triggers: ["cmd: setup laptops"], body: "Next: move the laptops." });
    putNote(store, { id: "g-trap", triggers: ["cmd: setup laptops"] });
    const inRepo = buildContext(store, repo);
    expect(inRepo).toMatchObject({ briefs: [], index: ["g-work"], triggerOnly: ["g-trap"], hidden: [] });
    expect(inRepo.text).toContain("\n- g-work [open-work] Title of g-work\n");
    expect(inRepo.text).toContain("\n1 more global note loads only at its trigger");
    expect(buildBudget(store, repo).notes.map((n) => [n.id, n.shown])).toEqual([["g-work", "index"], ["g-trap", "trigger"]]);
    // Outside any repo it is open work of that scope, so it gets a brief there.
    expect(buildContext(store, plain())).toMatchObject({ briefs: ["g-work"], index: [], triggerOnly: ["g-trap"] });
  });
});

describe("the index", () => {
  test("a global note with a cmd, stop or err trigger has no line: it loads at its trigger, and the pointer counts it", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "g-cmd", triggers: ["cmd: zorp --wipe"] });
    putNote(store, { id: "g-stop", triggers: ["stop: git push --force"] });
    putNote(store, { id: "g-err", triggers: ["err: address already in use"] });
    // An anchor is no trigger, and an item that is no trigger loads nothing.
    putNote(store, { id: "g-anchor", anchors: ["src/a.ts"] });
    putNote(store, { id: "g-broken", triggers: ["when: the moon is full"] });
    putNote(store, { id: "g-plain" });
    // A repo note keeps its line: the index of its repo is where a session finds it.
    putNote(store, { id: "r-cmd", scope: SCOPE, triggers: ["cmd: zorp --wipe"] });
    const result = buildContext(store, repo);
    expect(result.triggerOnly.sort()).toEqual(["g-cmd", "g-err", "g-stop"]);
    expect(result.index).toEqual(["r-cmd", "g-anchor", "g-broken", "g-plain"]);
    expect(result.hidden).toEqual([]);
    for (const id of result.triggerOnly) expect(result.text).not.toContain(id);
    expect(result.text.trimEnd().endsWith(`\n\n3 more global notes load only at their trigger, a command or an error. ${POINTER}`)).toBe(true);
    // The same holds outside any repo, where a global note loads at its trigger too.
    expect(buildContext(store, plain())).toMatchObject({ triggerOnly: expect.arrayContaining(["g-cmd", "g-stop", "g-err"]), index: ["g-anchor", "g-broken", "g-plain"] });
    kb(store, ["trash", "g-cmd", "g-stop"]);
    expect(buildContext(store, repo).text).toContain(`\n1 more global note loads only at its trigger, a command or an error. ${POINTER}`);
    kb(store, ["trash", "g-err"]);
    expect(buildContext(store, repo).text.trimEnd().endsWith(`\n\n${POINTER}`)).toBe(true);
  });

  test("no cap on the global notes: every one with no trigger gets a line while the characters last", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "repo-note", scope: SCOPE });
    // More than the 20 global notes and the 60 lines that an older kb allowed.
    const ids = Array.from({ length: 90 }, (_, i) => `g-${String(i).padStart(2, "0")}`);
    for (const id of ids) putNote(store, { id });
    const result = buildContext(store, repo);
    expect(result.index).toEqual(["repo-note", ...ids]);
    expect(result.hidden).toEqual([]);
    expect(result.text).toContain("### global (90)");
    expect(result.text).not.toContain("over the index budget");
  });

  test("the character budget is the hard limit: lines drop from the bottom, global notes of the lowest rank first", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    setConfig(store.home, { budgets: { contextChars: 2000 } });
    putNote(store, { id: "work", kind: "open-work", scope: SCOPE, body: "Next: write the pager." });
    const repoIds = Array.from({ length: 5 }, (_, i) => `r-${i}`);
    for (const id of repoIds) putNote(store, { id, scope: SCOPE });
    // Later ids rank lower: an older last_verified.
    const globalIds = Array.from({ length: 60 }, (_, i) => `g-${String(i).padStart(2, "0")}`);
    globalIds.forEach((id, i) => putNote(store, { id, title: `Global fact number ${i} with a title of some length`, last_verified: daysBefore(i) }));
    const result = buildContext(store, repo);
    expect(result.chars).toBeLessThanOrEqual(contextBudget(2000));
    expect(result.text.length).toBe(result.chars);
    // The brief and every repo note stay. The lines that fit are the top of the ranking.
    expect(result.briefs).toEqual(["work"]);
    const shown = result.index.length - repoIds.length;
    expect(shown).toBeGreaterThan(5);
    expect(shown).toBeLessThan(globalIds.length);
    expect(result.index).toEqual([...repoIds, ...globalIds.slice(0, shown)]);
    expect(result.hidden).toEqual(globalIds.slice(shown));
    expect(result.text).toContain(`\n${result.hidden.length} more index lines are over the index budget.\n`);
    for (const id of result.hidden) expect(result.text).not.toContain(id);
    // One more line would not fit.
    expect(result.chars + indexLine(store.find(result.hidden[0]!)!).length + 1).toBeGreaterThan(contextBudget(2000));
  });

  test("the cut takes the largest count of lines that fits, at every budget", () => {
    const store = tempStore();
    putNote(store, { id: "work", kind: "open-work", scope: SCOPE, body: "Next: write the pager." });
    // Lines of many lengths, in two sections, and a count of hidden notes that loses a digit on the way.
    for (let i = 0; i < 6; i++) putNote(store, { id: `r-${i}`, scope: SCOPE, title: `Repo fact ${"x".repeat(i * 7)}`, last_verified: daysBefore(i) });
    for (let i = 0; i < 14; i++) putNote(store, { id: `g-${String(i).padStart(2, "0")}`, title: `Global fact ${"y".repeat((i * 13) % 40)}`, last_verified: daysBefore(i) });
    const total = 20;
    const at = (contextChars: number) => {
      setConfig(store.home, { budgets: { contextChars } });
      return contextFor(store, SCOPE);
    };
    const full = at(8000);
    expect(full.index).toHaveLength(total);
    let before = at(500);
    expect(before.index.length).toBeLessThan(5);
    const steps: number[] = [];
    for (let chars = 501; before.index.length < total; chars++) {
      const now = at(chars);
      const budget = contextBudget(chars);
      expect(now.chars).toBeLessThanOrEqual(budget);
      expect(now.index).toEqual(full.index.slice(0, now.index.length));
      expect(now.hidden).toEqual(full.index.slice(now.index.length));
      expect(now.index.length).toBeGreaterThanOrEqual(before.index.length);
      // A line comes in at the first budget that takes it, and no later: the text then fills the budget to the character.
      if (now.index.length > before.index.length) {
        expect(now.chars).toBe(budget);
        steps.push(now.index.length - before.index.length);
      }
      before = now;
    }
    expect(before.text).toBe(full.text);
    // The whole index has no line that counts the hidden notes. So the last line or two come in together, when that line goes.
    expect(steps.slice(0, -1).every((step) => step === 1)).toBe(true);
    expect(steps.at(-1)).toBeGreaterThan(1);
    expect(steps.reduce((sum, step) => sum + step, 0)).toBeLessThanOrEqual(total);
  });

  test("a store of 4,000 notes builds its context fast: the cut does not build the text once for each line that drops", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    for (let i = 0; i < 4000; i++) putNote(store, { id: `note-${String(i).padStart(4, "0")}`, title: `A fact with a title of some length, number ${i}`, scope: i % 4 === 0 ? SCOPE : "global", kind: i % 3 === 0 ? "decision" : "gotcha" });
    // The best of three runs, so a pause of the machine does not fail the test. It takes about 80 ms, most of it to read the notes.
    const best = (run: () => unknown) => Math.min(...[1, 2, 3].map(() => {
      const started = performance.now();
      run();
      return performance.now() - started;
    }));
    for (const where of [repo, plain()]) {
      const result = buildContext(store, where);
      expect(result.index.length).toBeGreaterThan(50);
      expect(result.index.length + result.hidden.length).toBe(where === repo ? 4000 : 3000);
      expect(result.chars).toBeLessThanOrEqual(contextBudget(8000));
      expect(best(() => buildContext(store, where))).toBeLessThan(300);
      // The budget reads the store and the log once, as the context does.
      expect(best(() => buildBudget(store, where))).toBeLessThan(300);
    }
  });

  test("a configured budget above the SessionStart cap is clamped", () => {
    const store = tempStore();
    setConfig(store.home, { budgets: { contextChars: 50_000 } });
    for (let i = 0; i < 300; i++) putNote(store, { id: `big-${i}`, title: `A fact with a title that takes some room in the index, number ${i}` });
    const result = buildContext(store, plain());
    expect(result.chars).toBeLessThanOrEqual(HARD_CONTEXT_CAP);
    expect(result.chars).toBeGreaterThan(HARD_CONTEXT_CAP - 200);
    expect(result.hidden.length).toBeGreaterThan(0);
  });
});

/** A time this many days before a fixed day, so that a later note ranks lower. */
function daysBefore(days: number): string {
  return new Date(Date.parse("2026-03-01T12:00:00Z") - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

describe("kb context visibility", () => {
  test("shows global and the current repo, never another repo", () => {
    const store = tempStore();
    putNote(store, { id: "billing-note", scope: SCOPE });
    putNote(store, { id: "global-note" });
    const other = buildContext(store, tempRepo({ remote: "https://github.com/acme/web.git" }));
    expect(other.text).not.toContain("billing-note");
    expect(other.text).toContain("global-note");
    const outside = buildContext(store, plain());
    expect(outside.scope).toBeNull();
    expect(outside.index).toEqual(["global-note"]);
  });

  test("excludes promoted and trashed notes", () => {
    const store = tempStore();
    putNote(store, { id: "promoted", promoted_to: "CLAUDE.md" });
    putNote(store, { id: "gone" }, true);
    putNote(store, { id: "kept" });
    const result = buildContext(store, plain());
    expect(result.index).toEqual(["kept"]);
  });

  test("a repo note whose file or symbol is gone says so, and a sound note or a global note does not", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/ledger.ts"), "export function append() {}\n");
    putNote(store, { id: "sound", scope: SCOPE, anchors: ["src/ledger.ts#append", "src"] });
    putNote(store, { id: "renamed", scope: SCOPE, anchors: ["src/ledger.ts#post"] });
    putNote(store, { id: "deleted", scope: SCOPE, anchors: ["src/rates.ts", "src/ledger.ts"] });
    putNote(store, { id: "outside", scope: SCOPE, anchors: ["../elsewhere.ts"] });
    putNote(store, { id: "global-anchored", anchors: ["src/nothing.ts"] });
    const { text, gone } = buildContext(store, repo);
    expect(gone).toEqual([
      { id: "deleted", detail: "src/rates.ts does not exist" },
      { id: "outside", detail: "../elsewhere.ts does not exist" },
      { id: "renamed", detail: "post is no longer in src/ledger.ts" },
    ]);
    expect(text).toContain("## Anchors gone\nThese notes name a file or a symbol that is not in the checkout now.");
    expect(text).toContain("- renamed: post is no longer in src/ledger.ts\n");
    // Outside the repo nothing is checked: a global note's anchors name no checkout.
    expect(buildContext(store, plain()).gone).toEqual([]);
  });

  test("a checkout that lacks many anchored files lists five notes, so the index keeps its room", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    for (let i = 0; i < 40; i++) putNote(store, { id: `gone-${String(i).padStart(2, "0")}`, scope: SCOPE, anchors: [`src/file-${i}.ts`] });
    const result = buildContext(store, repo);
    expect(result.index).toHaveLength(40);
    expect(result.gone).toHaveLength(40);
    const section = result.text.slice(result.text.indexOf("## Anchors gone"), result.text.indexOf("## Index"));
    expect(section.match(/^- gone-/gm)).toHaveLength(5);
    expect(section).toContain(`${result.gone.length - 5} more. \`kb stale\` lists them.`);
    // The kb budget of the scope sees the same session as the session start.
    rememberRepo(store, SCOPE, repo);
    expect(budgetOf(store, SCOPE).context.chars).toBe(result.chars);
  });

  test("prints nothing when no note is visible", () => {
    const store = tempStore();
    putNote(store, { id: "elsewhere", scope: "github.com/acme/other" });
    expect(buildContext(store, plain()).text).toBe("");
  });
});

// HOLDBACK: these tests go with the arm.
describe("the hold-back arm", () => {
  /** A session id that the default share of 0.1 puts in the arm, and one that it does not. */
  const HELD = "held-3";
  const FREE = "held-0";

  test("the arm comes from a hash of the session id: one session is always in one arm, and about 1 in 10 is held back", () => {
    expect(inHoldback(HELD, 0.1)).toBe(true);
    expect(inHoldback(FREE, 0.1)).toBe(false);
    for (let i = 0; i < 3; i++) expect(inHoldback(HELD, 0.1)).toBe(true);
    // No session id, or a share of 0: the new policy.
    expect(inHoldback(undefined, 1)).toBe(false);
    expect(inHoldback("", 1)).toBe(false);
    const ids = Array.from({ length: 2000 }, (_, i) => `3f2a91c4-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(ids.filter((id) => inHoldback(id, 0)).length).toBe(0);
    expect(ids.filter((id) => inHoldback(id, 1)).length).toBe(2000);
    const held = ids.filter((id) => inHoldback(id, 0.1)).length;
    expect(held).toBeGreaterThan(150);
    expect(held).toBeLessThan(250);
    // A larger share keeps every session that a smaller one held.
    for (const id of ids.filter((each) => inHoldback(each, 0.1))) expect(inHoldback(id, 0.5)).toBe(true);
  });

  test("a held-back start keeps the old policy: whole bodies in rank order, no briefs, and the other notes in the index", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/a.ts"), "export function run() {}\n");
    putNote(store, { id: "work", kind: "open-work", scope: SCOPE, last_verified: NOON, body: "State: half done.\nNext: write the pager." });
    putNote(store, { id: "trap", scope: SCOPE, title: "First fact", last_verified: NOON, body: "The body of the trap.", anchors: ["src/a.ts#run"], verified_at_commit: "abc1234" });
    putNote(store, { id: "g-cmd", triggers: ["cmd: zorp --wipe"], body: "The body of the global note." });
    const held = buildContext(store, repo, HELD);
    expect(held).toMatchObject({ holdback: true, briefs: [], bodies: ["work", "trap", "g-cmd"], index: [], triggerOnly: [], hidden: [] });
    expect(held.text).toContain("## Notes (3 of 3, by rank)\n### work [open-work] Title of work\nverified 2026-03-02 | confidence medium\nState: half done.\nNext: write the pager.\n");
    expect(held.text).toContain("### trap [gotcha] First fact\nverified 2026-03-02 at abc1234 | confidence medium | anchors: src/a.ts#run\nThe body of the trap.\n");
    expect(held.text).not.toContain("## Open work");
    expect(held.charsBy.bodies).toBeGreaterThan(0);
    expect(held.charsBy.fixed + held.charsBy.bodies).toBe(held.chars);

    // Every other session, and a start with no session id, gets the new policy.
    for (const session of [FREE, undefined]) expect(buildContext(store, repo, session)).toMatchObject({ holdback: false, briefs: ["work"], bodies: [], index: ["trap"], triggerOnly: ["g-cmd"] });
    // `kb context` takes the arm of the session it is given, and `kb budget` always shows the new policy.
    expect(kb(store, ["context", "--json", "--session", HELD], { cwd: repo }).json).toMatchObject({ holdback: true, bodies: ["work", "trap", "g-cmd"] });
    expect(kb(store, ["context", "--json"], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: HELD } }).json).toMatchObject({ holdback: false, briefs: ["work"] });
    expect(kb(store, ["budget", "--json"], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: HELD } }).json).toMatchObject({ briefs: { count: 1 }, index: { lines: 1, triggerOnly: 1 } });
    // A share of 0 turns the arm off, and a share of 1 holds every session back.
    setConfig(store.home, { holdback: 0 });
    expect(buildContext(store, repo, HELD)).toMatchObject({ holdback: false, briefs: ["work"], bodies: [] });
    setConfig(store.home, { holdback: 1 });
    expect(buildContext(store, repo, FREE)).toMatchObject({ holdback: true, briefs: [] });
  });

  test("a held-back start gives the notes that the commit before the briefs gave: the same bodies, index lines and length", () => {
    // What `kb context` of commit f6a850d gives for the store of scripts/seed.ts: the last commit with the old policy.
    // A change of the seed or of the fixed text needs a new recording, from a checkout of that commit on the new store.
    const main: Record<string, { chars: number; bodies: string[]; index: string[]; hidden: string[] }> = JSON.parse(readFileSync(join(ROOT, "test", "holdback-main-f6a850d.json"), "utf8"));
    const seeded = tempDir("kb-seed-");
    sh(ROOT, process.execPath, join(ROOT, "scripts", "seed.ts"), join(seeded, "s"));
    const home = join(seeded, "s", "store");
    expect(Object.keys(main)).toEqual(["plain", "repos/atlas-api", "repos/ferry"]);
    for (const [dir, old] of Object.entries(main)) {
      const held = kb(home, ["context", "--json", "--session", HELD, "--repo", join(seeded, "s", dir)]).json;
      expect(held.holdback).toBe(true);
      expect(held.bodies).toEqual(old.bodies);
      expect(held.index).toEqual(old.index);
      // In no session: over the old limit of the index, then over the old limit of the global notes.
      expect(held.hidden).toEqual(old.hidden);
      expect(held.chars).toBe(old.chars);
      expect(held).toMatchObject({ briefs: [], triggerOnly: [] });
    }
    // The seeded store has more bodies than the index of the new policy leaves room for, and 26 global notes over the old limit.
    expect(main["repos/atlas-api"]!.bodies).toHaveLength(18);
    expect(main["repos/atlas-api"]!.hidden).toHaveLength(26);
  });

  test("the arm keeps the old limits: 60 index lines, and in a repo 20 global notes in rank order", () => {
    expect([OLD_INDEX_LINES, OLD_GLOBAL_NOTES]).toEqual([60, 20]);
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    const body = "x".repeat(2500);
    const repoIds = Array.from({ length: 70 }, (_, i) => `r-${String(i).padStart(2, "0")}`);
    const globalIds = Array.from({ length: 30 }, (_, i) => `g-${String(i).padStart(2, "0")}`);
    repoIds.forEach((id, i) => putNote(store, { id, scope: SCOPE, body, last_verified: daysBefore(i) }));
    // A trigger keeps a global note out of the index of the new policy. The old policy did not look at it.
    globalIds.forEach((id, i) => putNote(store, { id, body, last_verified: daysBefore(i), triggers: i === 0 ? ["cmd: zorp --wipe"] : undefined }));
    const held = buildContext(store, repo, HELD);
    // Two bodies of 2,500 characters fit after the index. The index is the next 60 notes.
    expect(held.bodies).toEqual(repoIds.slice(0, 2));
    expect(held.index).toEqual(repoIds.slice(2, 62));
    // In no session: 28 notes over the limit of the index, then the 10 global notes over their limit.
    expect(held.hidden).toEqual([...repoIds.slice(62), ...globalIds]);
    expect(held.text).toContain("\n28 more index lines are over the index budget.\n");
    expect(held.text.trimEnd()).toEndWith("60 notes are in the index only, because the bodies did not fit. 10 global notes of lower rank are left out here. `kb show <id>` prints one note. `kb search <words>` searches every note.");
    // Outside any repo every global note has a place: the old limit of global notes held in a repo only.
    const outside = buildContext(store, plain(), HELD);
    expect(outside.bodies).toEqual(globalIds.slice(0, 2));
    expect(outside.index).toEqual(globalIds.slice(2));
    expect(outside.hidden).toEqual([]);
    expect(outside.text.trimEnd()).toEndWith("\n28 notes are in the index only, because the bodies did not fit. `kb show <id>` prints one note. `kb search <words>` searches every note.");
  });

  test("the bodies fill the room the index leaves: whole notes from the top of the ranking, and none is cut", () => {
    const store = tempStore();
    setConfig(store.home, { budgets: { contextChars: 2000 }, holdback: 1 });
    const ids = Array.from({ length: 12 }, (_, i) => `note-${String(i).padStart(2, "0")}`);
    // Later ids rank lower: older last_verified.
    ids.forEach((id, i) => putNote(store, { id, body: `START-${id} ${"x".repeat(200)} END-${id}`, last_verified: daysBefore(i) }));
    const result = buildContext(store, plain(), "any");
    expect(result.chars).toBeLessThanOrEqual(contextBudget(2000));
    expect(result.bodies.length).toBeGreaterThan(0);
    expect(result.bodies.length).toBeLessThan(ids.length);
    // The printed bodies are exactly the top of the ranking, and every other note has its index line.
    expect(result.bodies).toEqual(ids.slice(0, result.bodies.length));
    expect(result.index).toEqual(ids.slice(result.bodies.length));
    for (const id of ids) {
      const hasStart = result.text.includes(`START-${id}`);
      expect(result.text.includes(`END-${id}`)).toBe(hasStart);
      expect(hasStart).toBe(result.bodies.includes(id));
      expect(result.text.includes(`\n- ${id} [gotcha]`)).toBe(!hasStart);
    }
    expect(result.text.indexOf("## Index")).toBeLessThan(result.text.indexOf("## Notes"));
  });

  test("a short low-ranked note does not jump ahead of a long one that did not fit", () => {
    const store = tempStore();
    setConfig(store.home, { budgets: { contextChars: 900 }, holdback: 1 });
    putNote(store, { id: "a-top", kind: "open-work", body: "short" });
    putNote(store, { id: "b-long", kind: "gotcha", body: "y".repeat(700) });
    putNote(store, { id: "c-short", kind: "how-to", body: "tiny" });
    const result = buildContext(store, plain(), "any");
    expect(result.bodies).toEqual(["a-top"]);
    expect(result.index).toEqual(["b-long", "c-short"]);
  });
});
