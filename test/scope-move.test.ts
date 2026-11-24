import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { movedHint } from "../cli/context.ts";
import type { Store } from "../cli/store.ts";
import { kb, putNote, sh, tempRepo, tempStore } from "./helpers.ts";

const OLD = "app";
const NEW = "example.com/team/app";

/** A store in git with two notes of a repo that had no remote, one of them in the trash. */
function setup(): Store {
  const store = tempStore();
  sh(store.home, "git", "init", "-q", "-b", "main");
  putNote(store, { id: "warm-cache", scope: OLD });
  putNote(store, { id: "old-idea", scope: OLD, trashed_at: "2026-11-01T00:00:00Z" }, true);
  putNote(store, { id: "other", scope: "example.com/team/web" });
  sh(store.home, "git", "add", "-A");
  sh(store.home, "git", "commit", "-q", "-m", "base");
  return store;
}

const log = (store: Store) => sh(store.home, "git", "log", "--format=%s").split("\n");

describe("kb scope move", () => {
  test("gives every note of the scope, also in the trash, the new scope in one commit", () => {
    const store = setup();
    const r = kb(store, ["scope", "move", OLD, NEW]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`moved 1 note and 1 in the trash from ${OLD} to ${NEW}: warm-cache, old-idea (trash)`);
    const active = store.notes().find((n) => n.id === "warm-cache")!;
    const trashed = store.notes({ trashed: true }).find((n) => n.id === "old-idea")!;
    expect(active.scope).toBe(NEW);
    expect(active.path).toBe(join(store.home, "notes", NEW, "warm-cache.md"));
    expect(trashed.scope).toBe(NEW);
    expect(trashed.trashed_at).toBe("2026-11-01T00:00:00Z");
    expect(readFileSync(trashed.path, "utf8")).toContain(`scope: ${NEW}\n`);
    // The old folders are gone, and the note of another repo did not move.
    expect(existsSync(join(store.home, "notes", OLD))).toBe(false);
    expect(existsSync(join(store.home, "trash", OLD))).toBe(false);
    expect(store.notes().find((n) => n.id === "other")!.scope).toBe("example.com/team/web");
    expect(log(store)).toEqual([`kb: move the scope ${OLD} to ${NEW} (2)`, "base"]);
    expect(sh(store.home, "git", "status", "--porcelain")).toBe("");
  });

  test("with --dry-run says what would move and writes nothing", () => {
    const store = setup();
    const r = kb(store, ["scope", "move", OLD, NEW, "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ from: OLD, to: NEW, notes: ["warm-cache"], trashed: ["old-idea"], dryRun: true });
    expect(kb(store, ["scope", "move", OLD, NEW, "--dry-run"]).stdout).toContain("would move 1 note and 1 in the trash");
    expect(store.notes().find((n) => n.id === "warm-cache")!.scope).toBe(OLD);
    expect(log(store)).toEqual(["base"]);
  });

  test("refuses to overwrite a note of the new scope, and moves nothing", () => {
    const store = setup();
    putNote(store, { id: "old-idea", scope: NEW });
    const r = kb(store, ["scope", "move", OLD, NEW]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`cannot move old-idea: ${NEW} has a note with that id. Nothing moved.`);
    expect(store.notes().find((n) => n.id === "warm-cache")!.scope).toBe(OLD);
    expect(store.notes({ trashed: true }).find((n) => n.id === "old-idea")!.scope).toBe(OLD);
  });

  test("refuses global, the same scope, a scope with no notes and a scope that is not a repo id", () => {
    const store = setup();
    expect(kb(store, ["scope", "move", "global", NEW]).stderr).toContain('"global" is not a project');
    expect(kb(store, ["scope", "move", OLD, "global"]).stderr).toContain('"global" is not a project');
    expect(kb(store, ["scope", "move", OLD, OLD]).stderr).toContain("is the scope already");
    expect(kb(store, ["scope", "move", "nothing-here", NEW]).stderr).toContain('no notes have the scope "nothing-here"');
    expect(kb(store, ["scope", "move", OLD, "../escape"]).stderr).toContain("is not a repo id");
    expect(kb(store, ["scope", "move", OLD]).stderr).toContain("usage: kb scope move");
    expect(log(store)).toEqual(["base"]);
  });

  test("kb scope with no subcommand still prints the scope", () => {
    const store = setup();
    const dir = tempRepo({ remote: "https://example.com/team/app.git" });
    expect(kb(store, ["scope"], { cwd: dir }).stdout.trim()).toBe(NEW);
  });
});

describe("a session start in a repo with no notes", () => {
  test("names a scope of the same repo name that has notes, and the move", () => {
    const store = setup();
    const dir = tempRepo({ remote: "https://example.com/team/app.git" });
    const text = kb(store, ["context"], { cwd: dir }).stdout;
    expect(text).toContain(`No note has the scope ${NEW}, but ${OLD} has 1 note and the same repo name.`);
    expect(text).toContain(`\`kb scope move ${OLD} ${NEW} --dry-run\``);
    // After the move the repo has its notes, and the line is gone.
    kb(store, ["scope", "move", OLD, NEW]);
    const after = kb(store, ["context"], { cwd: dir }).stdout;
    expect(after).not.toContain("No note has the scope");
    expect(after).toContain("warm-cache");
  });

  test("says nothing when the repo has notes, or no scope has its name", () => {
    const store = setup();
    const notes = store.notes();
    expect(movedHint(notes, OLD)).toBeNull();
    expect(movedHint(notes, "example.com/team/api")).toBeNull();
    expect(movedHint(notes, "global")).toBeNull();
    expect(movedHint(notes, "example.com/fork/web")).toContain("example.com/team/web has 1 note");
  });
});
