import { describe, expect, test } from "bun:test";
import { type Note, parseNote, serializeNote, slugify, titleId, titleKey } from "../cli/note.ts";

const note = (fields: Partial<Note> = {}): Note => ({
  id: "a-note",
  title: "A note",
  scope: "global",
  kind: "gotcha",
  created: "2026-01-01T00:00:00Z",
  last_verified: "2026-01-02T03:04:05Z",
  anchors: [],
  confidence: "medium",
  body: "The body.",
  ...fields,
});

describe("titleId", () => {
  test("gives an ASCII title the id it always had", () => {
    expect(titleId("Stripe needs the raw body")).toBe("stripe-needs-the-raw-body");
    expect(titleId("zorp --wipe removes the cache of every project")).toBe("zorp-wipe-removes-the-cache-of-every-project");
    expect(titleId("The deploy CLI exits 0 when the upload was rejected")).toBe("the-deploy-cli-exits-0-when-the-upload-was");
    expect(titleId("  C++ & Node.js: v2.0 (beta)  ")).toBe("c-node-js-v2-0-beta");
  });

  test("folds an accent into its letter and leaves out a letter with no ASCII form", () => {
    expect(titleId("Ünïcode 日本語 🚀 title")).toBe("unicode-title");
    expect(titleId("Café crème brûlée")).toBe("cafe-creme-brulee");
    expect(titleId("ﬁle Ⅳ")).toBe("file-iv");
  });

  test("gives a title with no ASCII letter or digit a short id that the same title always gets", () => {
    const id = titleId("日本語だけのタイトル");
    expect(id).toMatch(/^note-[0-9a-f]{8}$/);
    expect(titleId("日本語だけのタイトル")).toBe(id);
    // Case and spaces do not make a new note.
    expect(titleId("  日本語だけの   タイトル ")).toBe(titleId("日本語だけの タイトル"));
    expect(titleId("Привет мир")).toBe(titleId("привет  мир"));
    expect(titleId("🚀 ✨")).toMatch(/^note-[0-9a-f]{8}$/);
    expect(titleId("日本語")).not.toBe(titleId("中文"));
  });

  test("is empty only for an empty title", () => {
    expect(titleId("")).toBe("");
    expect(titleId("   ")).toBe("");
  });

  test("keeps the cut of a long title at a word boundary", () => {
    expect(slugify("never run the migration tool against the shared staging database")).toBe("never-run-the-migration-tool-against-the-shared");
  });
});

describe("titleKey", () => {
  test("compares ASCII words, and a title with none in full", () => {
    expect(titleKey("Stripe: needs the RAW body!")).toBe(titleKey("stripe needs the raw body"));
    expect(titleKey("Ünïcode title")).toBe(titleKey("unicode title"));
    expect(titleKey("日本語")).toBe("日本語");
    expect(titleKey("Привет  Мир")).toBe("привет мир");
  });
});

describe("serializeNote", () => {
  test("writes the front matter the same way on every version of Bun", () => {
    const text = serializeNote(
      note({
        verified_at_commit: "0123456789abcdef0123456789abcdef01234567",
        anchors: ["cli/note.ts", "src/**/*.ts"],
        triggers: ["cmd: zorp --wipe", "err: Flux capacitor underflow"],
        supersedes: ["old-note"],
        promoted_to: "CLAUDE.md",
        trashed_at: "2026-02-01T00:00:00Z",
      }),
    );
    expect(text).toBe(
      [
        "---",
        "id: a-note",
        "title: A note",
        "scope: global",
        "kind: gotcha",
        "created: 2026-01-01T00:00:00Z",
        "last_verified: 2026-01-02T03:04:05Z",
        "verified_at_commit: 0123456789abcdef0123456789abcdef01234567",
        "anchors:",
        "  - cli/note.ts",
        "  - src/**/*.ts",
        "triggers:",
        '  - "cmd: zorp --wipe"',
        '  - "err: Flux capacitor underflow"',
        "confidence: medium",
        "promoted_to: CLAUDE.md",
        "supersedes:",
        "  - old-note",
        "trashed_at: 2026-02-01T00:00:00Z",
        "---",
        "The body.",
        "",
      ].join("\n"),
    );
    // An empty list stays on the line of its key. Bun 1.3 wrote it on the next line.
    expect(serializeNote(note())).toContain("\nanchors: []\nconfidence: medium\n");
  });

  test("quotes a text that a YAML reader would take for something else, and reads every one back", () => {
    const texts = [
      "yes", "No", "on", "OFF", "y", "null", "~", "true", "123", "-1.5", "1e5", ".5", "0x1F", "0o17", "0b101", "12:30", ".inf", ".NaN",
      "2026-01-01", "2026-01-01T00:00:00Z", "<<", "---", "...", " lead", "trail ", "a: b", "a:", "a #b", "#a", "- a", "? a", ": a",
      "[a]", "{a}", "a,b", "'a'", '"a"', "`a`", "@a", "%a", "!a", "&a", "*a", "|a", ">a", "tab\there", "line\nbreak", "cr\rhere",
      "nbsp here", "nel\u0085here", "ls here", "bom﻿here", "back\\slash", "Ünïcode 日本語 🚀", "a - b & c % d ! e",
    ];
    for (const text of texts) {
      const file = serializeNote(note({ title: text, anchors: [text], promoted_to: text }));
      const front = Bun.YAML.parse(file.split("\n---\n")[0]!.slice(4)) as Record<string, unknown>;
      expect([front.title, front.anchors, front.promoted_to]).toEqual([text, [text], text]);
    }
    // The note reads back whole.
    expect(parseNote(serializeNote(note({ title: "yes: no #1", anchors: ["- a"] })))).toEqual(note({ title: "yes: no #1", anchors: ["- a"] }));
    expect(serializeNote(note({ title: "yes" }))).toContain('\ntitle: "yes"\n');
    expect(serializeNote(note({ title: "2026-01-01" }))).toContain('\ntitle: "2026-01-01"\n');
    expect(serializeNote(note({ title: "Ünïcode 日本語 🚀" }))).toContain("\ntitle: Ünïcode 日本語 🚀\n");
  });
});
