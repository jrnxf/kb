import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.ts";

// Claude Code installs a plugin's packages when the plugin's root holds both a package.json and a
// lockfile (bun.lock, npm-shrinkwrap.json or package-lock.json). It installs devDependencies too,
// so each cached version of kb once held 53 MB of test tools. kb runs from its sources and
// web/dist, with no package at run time, so the root ships no lockfile and no install runs.
describe("what a plugin install brings", () => {
  test("git tracks no lockfile at the root", () => {
    const tracked = Bun.spawnSync(["git", "ls-files", "--", "bun.lock", "bun.lockb", "npm-shrinkwrap.json", "package-lock.json"], { cwd: ROOT });
    expect(tracked.exitCode).toBe(0);
    expect(tracked.stdout.toString()).toBe("");
  });

  test("the root package.json lists no runtime package, and pins each dev tool to one version", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    // Claude Code notes "the packages it lists are not installed" on a plugin with any of these.
    for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "workspaces"]) expect(pkg[key]).toBeUndefined();
    // With no root lockfile, an exact version is what keeps a dev install the same on every machine.
    for (const version of Object.values(pkg.devDependencies)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
