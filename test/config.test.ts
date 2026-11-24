import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalInstructions, shortPath } from "../cli/instructions.ts";
import { Store } from "../cli/store.ts";
import { kb, machineConfig, tempDir, tempStore } from "./helpers.ts";

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

  test("a config that an older kb wrote whole keeps what the user changed, per-machine keys too", () => {
    const store = oldStore({ ...OLD_CONFIG, budgets: { ...OLD_CONFIG.budgets, contextChars: 5000 }, trashDays: 7, sync: false, globalInstructions: "~/dotfiles/CLAUDE.md" });
    store.ensure();
    // The shared file keeps the per-machine keys: a machine that runs an older kb reads them there.
    expect(read(join(store.home, "kb.config.json"))).toEqual({ budgets: { contextChars: 5000 }, trashDays: 7, sync: false, globalInstructions: "~/dotfiles/CLAUDE.md" });
    expect(store.local()).toMatchObject({ sync: false, globalInstructions: "~/dotfiles/CLAUDE.md" });
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

  test("a config the user wrote by hand stays as it is, and this machine copies its per-machine keys", () => {
    const config = { holdback: 0.1, decayDays: 180, globalInstructions: "~/notes/RULES.md" };
    const store = oldStore(config);
    store.ensure();
    expect(read(join(store.home, "kb.config.json"))).toEqual(config);
    expect(store.local().globalInstructions).toBe("~/notes/RULES.md");
    expect(store.config().globalInstructions).toBe("~/notes/RULES.md");
  });

  test("a read writes nothing, and it works in a folder that kb cannot write", () => {
    const store = oldStore({ sync: false, globalInstructions: "~/dotfiles/CLAUDE.md" });
    chmodSync(store.home, 0o500);
    try {
      // The shared file speaks for the per-machine keys until ensure() copies them.
      expect(store.config()).toMatchObject({ sync: false, globalInstructions: "~/dotfiles/CLAUDE.md" });
    } finally {
      chmodSync(store.home, 0o700);
    }
    expect(existsSync(join(store.home, "local.json"))).toBe(false);
  });

  test("a store with no notes folder, as git keeps it, still pins its sync setting", () => {
    const store = new Store(join(tempDir(), "store"));
    mkdirSync(store.home, { recursive: true });
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ sync: false }));
    expect(store.exists()).toBe(false);
    expect(store.config().sync).toBe(false);
    store.ensure();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ sync: true }));
    expect(store.config().sync).toBe(false);
  });

  test("a pulled config cannot change a key that this machine pinned", () => {
    const store = tempStore();
    store.ensure();
    machineConfig(store, { sync: false, globalInstructions: "~/mine.md" });
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ sync: true, globalInstructions: "~/elsewhere.md", trashDays: 9 }));
    expect(store.config()).toMatchObject({ sync: false, globalInstructions: "~/mine.md", trashDays: 9 });
  });

  test("a store that nobody set up still syncs by default, so a clone of it pushes", () => {
    expect(tempStore().config().sync).toBe(true);
  });

  test("a write to local.json keeps what another process wrote since the last read", () => {
    const home = join(tempDir(), "store");
    const a = new Store(home);
    const b = new Store(home);
    mkdirSync(home, { recursive: true });
    expect(a.local().machine).toBe("");
    const id = b.machine();
    a.updateLocal((local) => {
      local.aliases["/x"] = "x";
    });
    expect(a.local()).toMatchObject({ machine: id, aliases: { "/x": "x" } });
    // The move of the per-machine keys merges too, and ensure() keeps the machine id.
    writeFileSync(join(home, "kb.config.json"), JSON.stringify({ sync: false }));
    a.ensure();
    expect(new Store(home).local()).toMatchObject({ machine: id, aliases: { "/x": "x" }, sync: false });
  });

  test("a change to a config file shows at once in a store that read it before", () => {
    const store = tempStore();
    expect(store.config().trashDays).toBe(30);
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ trashDays: 9 }));
    expect(store.config().trashDays).toBe(9);
    machineConfig(store, { sync: false });
    expect(store.config().sync).toBe(false);
    new Store(store.home).saveLocal({ ...store.local(), sync: true });
    expect(store.config().sync).toBe(true);
  });
});

describe("the global instructions file", () => {
  test("a file outside the home folder works, also at the end of a link, as a dotfiles checkout does", () => {
    const store = tempStore();
    const target = join(tempDir(), "CLAUDE.md");
    writeFileSync(target, "# Rules\n");
    const link = join(tempDir(), "link.md");
    symlinkSync(target, link);
    machineConfig(store, { globalInstructions: link });
    expect(globalInstructions(store)).toMatchObject({ path: target, link: true });
  });

  test("a HOME with a trailing slash still shortens a path to ~", () => {
    const saved = process.env.HOME;
    try {
      process.env.HOME = `${saved}/`;
      expect(shortPath(join(saved as string, ".claude", "CLAUDE.md"))).toBe("~/.claude/CLAUDE.md");
    } finally {
      process.env.HOME = saved;
    }
  });
});
