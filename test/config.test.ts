import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalInstructions } from "../cli/instructions.ts";
import { Store } from "../cli/store.ts";
import { ROOT, kb, machineConfig, tempDir, tempStore } from "./helpers.ts";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** What an older kb wrote into every new store: each default, and the per-machine keys. */
const OLD_CONFIG = {
  budgets: { indexLines: 60, contextChars: 8000, globalIndexLines: 20, briefChars: 1500 },
  holdback: 0.1,
  decayDays: 180,
  expireDays: 90,
  trashDays: 30,
  autocommit: true,
  sync: true,
  globalInstructions: "~/.claude/CLAUDE.md",
};

/** A store made by an older kb: the layout, and a config with the given keys. */
function oldStore(config: object): Store {
  const store = new Store(join(tempDir(), "store"));
  mkdirSync(join(store.home, "notes"), { recursive: true });
  writeFileSync(join(store.home, "kb.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  return store;
}

describe("kb.config.json", () => {
  test("a new store gets no config file, so a later default reaches it", () => {
    const home = join(tempDir(), "fresh");
    expect(kb(home, ["add", "--json"], { stdin: JSON.stringify({ title: "A first note", kind: "gotcha", body: "x", scope: "global" }) }).code).toBe(0);
    expect(existsSync(join(home, "kb.config.json"))).toBe(false);
    expect(new Store(home).config()).toMatchObject({ holdback: 0.1, sync: true, globalInstructions: "~/.claude/CLAUDE.md" });
  });

  test("a config that an older kb wrote whole keeps only what the user changed", () => {
    const store = oldStore({ ...OLD_CONFIG, budgets: { ...OLD_CONFIG.budgets, contextChars: 5000 }, trashDays: 7, sync: false, globalInstructions: "~/dotfiles/CLAUDE.md" });
    store.ensure();
    expect(read(join(store.home, "kb.config.json"))).toEqual({ budgets: { contextChars: 5000 }, trashDays: 7 });
    expect(store.local()).toMatchObject({ sync: false, globalInstructions: "~/dotfiles/CLAUDE.md", movedKeys: true });
    expect(store.config()).toMatchObject({ budgets: { contextChars: 5000, briefChars: 1500 }, holdback: 0.1, trashDays: 7, sync: false, globalInstructions: "~/dotfiles/CLAUDE.md" });
  });

  test("an untouched config of an older kb ends empty, and local.json takes no default", () => {
    const store = oldStore(OLD_CONFIG);
    store.ensure();
    expect(read(join(store.home, "kb.config.json"))).toEqual({});
    expect(store.local()).not.toHaveProperty("sync");
    expect(store.local()).not.toHaveProperty("globalInstructions");
    expect(store.config().holdback).toBe(0.1);
  });

  test("a config the user wrote by hand keeps a default value, and loses only the per-machine keys", () => {
    const store = oldStore({ holdback: 0.1, decayDays: 180, globalInstructions: "~/notes/RULES.md" });
    store.ensure();
    expect(read(join(store.home, "kb.config.json"))).toEqual({ holdback: 0.1, decayDays: 180 });
    expect(store.config().globalInstructions).toBe("~/notes/RULES.md");
  });

  test("a machine reads the per-machine keys of kb.config.json once, even before it writes", () => {
    const store = oldStore({ sync: false });
    // A read, such as a session start, moves them, so a pulled file that lacks them loses nothing.
    expect(store.config().sync).toBe(false);
    writeFileSync(join(store.home, "kb.config.json"), "{}\n");
    expect(store.config().sync).toBe(false);
  });

  test("a pulled config cannot turn sync on or say where Apply writes", () => {
    const store = tempStore();
    machineConfig(store, { sync: false });
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ sync: true, globalInstructions: "~/elsewhere.md", trashDays: 9 }));
    expect(store.config()).toMatchObject({ sync: false, globalInstructions: "~/.claude/CLAUDE.md", trashDays: 9 });
    store.ensure();
    expect(read(join(store.home, "kb.config.json"))).toEqual({ trashDays: 9 });
  });
});

describe("the global instructions file", () => {
  test("a file outside the home folder is refused, also at the end of a link", () => {
    const store = tempStore();
    // The tests run with the temp folder as the home folder. The checkout is outside it.
    const outside = join(ROOT, "README.md");
    machineConfig(store, { globalInstructions: outside });
    expect(() => globalInstructions(store)).toThrow("outside your home folder");
    const link = join(tempDir(), "CLAUDE.md");
    symlinkSync(outside, link);
    machineConfig(store, { globalInstructions: link });
    expect(() => globalInstructions(store)).toThrow("outside your home folder");
    const inside = join(tempDir(), "CLAUDE.md");
    writeFileSync(inside, "# Rules\n");
    machineConfig(store, { globalInstructions: inside });
    expect(globalInstructions(store).path).toBe(inside);
  });
});
