import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.ts";

// Claude Code installs a plugin's packages when the plugin root holds a package.json and a lockfile
// (bun.lock, bun.lockb, npm-shrinkwrap.json or package-lock.json). It installs devDependencies too,
// so each cached version of kb once held 53 MB of test tools. kb runs from its sources and
// web/dist, with no package at run time. The dev tools install and lock in web/, so the root
// holds a package.json for its scripts and never a lockfile.
describe("what a plugin install brings", () => {
  // A checkout gets an untracked, ignored lockfile after a stray `bun install` at the root, and a
  // local-directory marketplace install would still see it. So this checks the folder, not git.
  for (const name of ["bun.lock", "bun.lockb", "npm-shrinkwrap.json", "package-lock.json"]) {
    test(`the root holds no ${name}`, () => {
      expect(existsSync(join(ROOT, name))).toBe(false);
    });
  }

  test("the root package.json lists no package", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "workspaces"]) {
      expect(pkg[key]).toBeUndefined();
    }
  });

  test("the dev tools the root tests import are locked in web/", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "web", "package.json"), "utf8"));
    for (const tool of ["playwright", "@types/bun"]) expect(pkg.devDependencies[tool]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(join(ROOT, "web", "bun.lock"))).toBe(true);
  });
});
