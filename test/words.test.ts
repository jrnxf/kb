import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { queryStem, search } from "../cli/search.ts";
import { Store } from "../cli/store.ts";
import { STOP_WORDS, stem, stems, words } from "../cli/words.ts";
import { ROOT, putNote, sh, tempDir, tempStore } from "./helpers.ts";

// A word and one of its forms. The stemmer must give both the same stem.
const SAME: [string, string][] = [
  ["retry", "retries"], ["retry", "retried"], ["retry", "retrying"], ["copy", "copies"], ["query", "queried"],
  ["cache", "caches"], ["cache", "cached"], ["cache", "caching"], ["share", "shared"], ["share", "sharing"],
  ["note", "notes"], ["note", "noted"], ["cookie", "cookies"], ["api", "apis"], ["cpu", "cpus"],
  ["alias", "aliases"], ["alias", "aliased"], ["status", "statuses"], ["bus", "buses"], ["lens", "lenses"],
  ["embed", "embedded"], ["embed", "embedding"], ["control", "controlled"], ["control", "controlling"], ["install", "installed"],
  ["cancel", "cancelled"], ["cancel", "canceled"], ["call", "called"], ["diff", "diffing"], ["pass", "passed"],
  ["stop", "stopped"], ["plan", "planning"], ["commit", "committed"], ["log", "logged"], ["add", "adding"],
  ["deploy", "deployed"], ["fix", "fixes"], ["branch", "branches"], ["class", "classes"], ["push", "pushed"],
  ["release", "released"], ["release", "releasing"], ["change", "changed"], ["merge", "merging"], ["remove", "removed"],
  ["delete", "deleted"], ["create", "created"], ["update", "updating"], ["configure", "configured"], ["require", "required"],
  ["handle", "handled"], ["enable", "enabling"], ["parse", "parsed"], ["size", "sizes"], ["size", "sized"],
  ["queue", "queued"], ["file", "filing"], ["type", "typing"], ["scope", "scoped"], ["rename", "renamed"],
  ["store", "storing"], ["ignore", "ignored"], ["compile", "compiled"], ["include", "including"], ["encode", "encoded"],
  ["describe", "described"], ["manage", "managed"], ["reference", "referenced"], ["sync", "synced"], ["focus", "focused"],
  ["open", "opened"], ["edit", "edited"], ["filter", "filtered"], ["monitor", "monitoring"], ["develop", "developed"],
  ["fail", "failed"], ["load", "loading"], ["test", "tested"], ["evaluate", "evaluated"], ["repeat", "repeated"],
  ["route", "routing"], ["paste", "pasted"], ["write", "writing"], ["overwrite", "overwriting"], ["toggle", "toggled"],
  ["supersede", "superseded"], ["schedule", "scheduled"], ["resolve", "resolved"], ["index", "indices"], ["hero", "heroes"],
  ["schema", "schemas"], ["repo", "repos"], ["migration", "migrations"], ["Branch", "BRANCHES"],
];

// Two words that differ in meaning. The stemmer must keep them apart.
const APART: [string, string][] = [
  ["note", "not"], ["core", "cors"], ["mode", "mods"], ["state", "stats"], ["class", "clas"],
  ["cache", "cash"], ["paste", "past"], ["hope", "hop"], ["plane", "plan"], ["stare", "star"],
  ["file", "fill"], ["code", "cod"], ["site", "sit"], ["rate", "rat"], ["bite", "bit"],
  ["wall", "wal"], ["null", "nul"], ["news", "new"], ["https", "http"], ["axis", "axi"],
  ["status", "stat"], ["setting", "set"], ["evening", "even"], ["migration", "migrate"], ["embed", "emb"],
];

describe("the stemmer", () => {
  test("the forms of one word give one stem", () => {
    expect(SAME.length).toBeGreaterThanOrEqual(40);
    expect(SAME.filter(([word, form]) => stem(word) !== stem(form)).map(([word, form]) => `${word} ${stem(word)} | ${form} ${stem(form)}`)).toEqual([]);
  });

  test("two words that differ in meaning keep two stems", () => {
    expect(APART.length).toBeGreaterThanOrEqual(15);
    expect(APART.filter(([one, other]) => stem(one) === stem(other)).map(([one, other]) => `${one} ${other} ${stem(one)}`)).toEqual([]);
  });

  test("it leaves short words, words with a digit and words that only look inflected", () => {
    for (const word of ["bus", "status", "alias", "analysis", "previous", "class", "string", "need", "speed", "red", "embed", "hundred", "v2s", "sha256", "is"]) expect(stem(word)).toBe(word);
  });

  test("a stem keeps its final e, so it is a word the reader knows", () => {
    expect(["cached", "sharing", "notes", "routes", "changed"].map(stem)).toEqual(["cache", "share", "note", "route", "change"]);
  });

  test("stems drops the stop words and single characters, and splits at every other character", () => {
    expect(stems("The JSON parser breaks `express.raw()` on a route")).toEqual(["json", "parser", "break", "express", "raw", "route"]);
  });

  // NFKD puts the accent in its own character. That character is no letter, so it cut the word in two.
  test("an accented word is one word", () => {
    expect(words("A migração falhou, naïve café")).toEqual(["a", "migracao", "falhou", "naive", "cafe"]);
  });

  // words kept [a-z0-9] only. A note in Cyrillic or in Chinese then had no word, and "søk" was "s" and "k".
  test("a word is a run of letters and digits of any script, and only a word in ASCII letters gets a stem", () => {
    expect(words("Søk i Straße 7: миграция упала, 数据库迁移失败。")).toEqual(["søk", "i", "straße", "7", "миграция", "упала", "数据库迁移失败"]);
    expect(stems("Миграции упали on the søkes pages")).toEqual(["миграции", "упали", "søkes", "page"]);
    for (const word of ["søkes", "straßes", "миграции", "naïves"]) expect(stem(word)).toBe(word);
  });
});

describe("kb search and the forms of a word", () => {
  const ids = (store: Store, query: string) => [...new Set(search(store, query).map((h) => h.id))];

  test("a form never widens a query to another word: note is not not, and cors is not cores", () => {
    const store = tempStore();
    putNote(store, { id: "drill", title: "This is not a drill", body: "Do not ignore the pager." });
    putNote(store, { id: "notes", title: "Release notes go in the PR", body: "One line per change." });
    putNote(store, { id: "cors", title: "The API needs CORS headers", body: "The browser blocks the call." });
    putNote(store, { id: "cores", title: "The build uses all cores", body: "Set the core count for CI." });
    expect(ids(store, "note")).toEqual(["notes"]);
    expect(ids(store, "notes")).toEqual(["notes"]);
    expect(ids(store, "cors")).toEqual(["cors"]);
    expect(ids(store, "cores")).toEqual(["cores"]);
    expect(ids(store, "core")).toEqual(["cores"]);
  });

  test("a stop word matches as text only, in the query and in the line", () => {
    const store = tempStore();
    putNote(store, { id: "drill", title: "This is not a drill", body: "Do not ignore the pager." });
    // "nots" has the stem "not". The "not" of the line is a stop word, so it has no stem.
    expect(stem("nots")).toBe("not");
    expect(ids(store, "nots")).toEqual([]);
    expect(ids(store, "not")).toEqual(["drill"]);
    for (const word of STOP_WORDS) expect(queryStem(word)).toBeUndefined();
  });

  test("a stem of fewer than 3 letters matches nothing, and a query that is no plain word has no stem", () => {
    expect(queryStem("ci")).toBeUndefined();
    expect(queryStem("express.raw()")).toBeUndefined();
    expect(queryStem("notes")).toBe("note");
    expect(queryStem("ids")).toBe("ids");
  });

  test("a word with no accent finds the accented word", () => {
    const store = tempStore();
    putNote(store, { id: "pt", title: "A migração falhou em produção", body: "Corre de novo." });
    expect(ids(store, "migracao")).toEqual(["pt"]);
    expect(ids(store, "migração")).toEqual(["pt"]);
  });

  // The query word had no stem when it had an accent, so it matched as text only.
  test("a word with an accent finds the word with no accent, and its other forms", () => {
    const store = tempStore();
    putNote(store, { id: "plain", title: "A migracao falhou em producao", body: "Corre de novo." });
    putNote(store, { id: "cafes", title: "The cafes close at six", body: "Go before." });
    expect(queryStem("migração")).toBe("migracao");
    expect(ids(store, "migração")).toEqual(["plain"]);
    expect(ids(store, "MIGRAÇÃO produção")).toEqual(["plain"]);
    expect(ids(store, "café")).toEqual(["cafes"]);
  });

  test("a note in another script is found by its own words", () => {
    const store = tempStore();
    putNote(store, { id: "ru", title: "Миграция падает на общей базе", body: "Запускай миграции только на локальной копии." });
    putNote(store, { id: "zh", title: "数据库迁移在共享环境失败", body: "只在本地副本上运行迁移。" });
    putNote(store, { id: "no", title: "Søk i loggen før du spør", body: "Feilen står ofte der." });
    expect(ids(store, "миграция")).toEqual(["ru"]);
    expect(ids(store, "ОБЩЕЙ базе")).toEqual(["ru"]);
    // Chinese writes no space between words. A part of a line matches as text.
    expect(ids(store, "数据库")).toEqual(["zh"]);
    expect(ids(store, "共享环境 本地副本")).toEqual(["zh"]);
    expect(ids(store, "预览链接")).toEqual([]);
    expect(ids(store, "søk")).toEqual(["no"]);
    // "sok" is another word in a language that has the letter ø.
    expect(ids(store, "sok")).toEqual([]);
  });

  // The stem match read the frontmatter key of the title line as a word of the note.
  test("the key of the title line is no word: titles finds only a note that says title", () => {
    const store = tempStore();
    putNote(store, { id: "page", title: "Set the title of the page in the layout", body: "The router does not." });
    putNote(store, { id: "ports", title: "The dev server needs port 4100 free", body: "It fails when the port is taken." });
    expect(ids(store, "titles")).toEqual(["page"]);
    expect(ids(store, "titled")).toEqual(["page"]);
    // The text match is as it was: the line starts with "title:".
    expect(ids(store, "title")).toEqual(["page", "ports"]);
  });

  // main matched a word as text only. The forms must add the lines of the same word and no line of another word.
  test("on the seeded store, a one-word query matches only lines that hold the word or a form of it", () => {
    const dir = join(tempDir(), "seed");
    sh(ROOT, process.execPath, join(ROOT, "scripts", "seed.ts"), dir);
    const store = new Store(join(dir, "store"));
    const lines = store.notes().flatMap((note) => readFileSync(note.path, "utf8").toLowerCase().split("\n"));

    const note = search(store, "note");
    expect(note.length).toBeGreaterThan(10);
    expect(note.filter((hit) => !/note|\bnoting\b/i.test(hit.text))).toEqual([]);
    // The store has lines with "not" and no "note". None of them is a hit.
    expect(lines.filter((line) => /\bnot\b/.test(line) && !line.includes("note")).length).toBeGreaterThan(10);
    expect(search(store, "notes").filter((hit) => !/note|\bnoting\b/i.test(hit.text))).toEqual([]);

    // The store has "core" and "cores", and no "cors".
    expect(lines.filter((line) => /\bcores?\b/.test(line)).length).toBeGreaterThan(0);
    expect(lines.filter((line) => line.includes("cors"))).toEqual([]);
    expect(search(store, "cors")).toEqual([]);
    expect(search(store, "core").filter((hit) => !/core/i.test(hit.text))).toEqual([]);

    // No seeded note says "titles" or "titled", and none has "title" outside the key of its title line.
    expect(lines.filter((line) => line.replace(/^title:/, "").includes("title"))).toEqual([]);
    expect(search(store, "titles")).toEqual([]);
    expect(search(store, "titled")).toEqual([]);
  });
});
