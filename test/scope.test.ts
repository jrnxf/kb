import { describe, expect, test } from "bun:test";
import { realpathSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeRemote, resolveRepo } from "../cli/scope.ts";
import { plain, sh, tempDir, tempRepo, tempStore } from "./helpers.ts";

describe("normalizeRemote", () => {
  test("SSH, HTTPS and other forms of one remote give one id", () => {
    const forms = [
      "git@github.com:Acme/Billing.git",
      "https://github.com/acme/billing.git",
      "https://github.com/acme/billing",
      "https://user:token@github.com/acme/billing.git/",
      "ssh://git@github.com/acme/billing.git",
      "ssh://git@github.com:22/acme/billing",
      "git://github.com/acme/billing.git",
      "github.com:acme/billing.git",
    ];
    for (const form of forms) expect(normalizeRemote(form), form).toBe("github.com/acme/billing");
  });

  test("keeps nested groups and rejects local paths", () => {
    expect(normalizeRemote("git@gitlab.example.com:group/sub/project.git")).toBe("gitlab.example.com/group/sub/project");
    expect(normalizeRemote("/home/user/repos/project.git")).toBeNull();
    expect(normalizeRemote("../project")).toBeNull();
    expect(normalizeRemote("file:///home/user/project.git")).toBeNull();
    expect(normalizeRemote("")).toBeNull();
  });
});

describe("resolveRepo", () => {
  test("an SSH clone and an HTTPS clone share one scope", () => {
    const store = tempStore();
    const ssh = resolveRepo(tempRepo({ remote: "git@github.com:acme/billing.git" }), store);
    const https = resolveRepo(tempRepo({ remote: "https://github.com/acme/billing.git" }), store);
    expect(ssh.scope).toBe("github.com/acme/billing");
    expect(https.scope).toBe(ssh.scope);
    expect(ssh.head).toMatch(/^[0-9a-f]{7,}$/);
  });

  test("a subdirectory resolves to its repo", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    sh(repo, "mkdir", "-p", "src/deep");
    expect(resolveRepo(join(repo, "src/deep"), store).scope).toBe("github.com/acme/billing");
  });

  test("with no remote it uses the directory name and records the path", () => {
    const store = tempStore();
    const repo = tempRepo({ name: "My Project" });
    expect(resolveRepo(repo, store).scope).toBe("my-project");
    expect(store.local().aliases[repo]).toBe("my-project");
  });

  test("an alias that another process wrote after the read wins over the computed slug", () => {
    const store = tempStore();
    const repo = tempRepo({ name: "first-name" });
    const main = realpathSync(repo);
    // Another process writes an alias, as a second hook would. This process read the file before.
    store.updateLocal((local) => {
      local.aliases[main] = "pinned-name";
    });
    const real = store.local.bind(store);
    let reads = 0;
    store.local = () => (reads++ === 0 ? { machine: "", aliases: {} } : real());
    expect(resolveRepo(repo, store).scope).toBe("pinned-name");
  });

  test("a recorded alias wins, so the id can be pinned after a rename", () => {
    const store = tempStore();
    const repo = tempRepo({ name: "first-name" });
    expect(resolveRepo(repo, store).scope).toBe("first-name");
    const renamed = join(dirname(repo), "second-name");
    renameSync(repo, renamed);
    expect(resolveRepo(renamed, store).scope).toBe("second-name");
    const local = store.local();
    local.aliases[renamed] = "first-name";
    store.saveLocal(local);
    expect(resolveRepo(renamed, store).scope).toBe("first-name");
  });

  test("a worktree shares the scope of its main checkout", () => {
    const store = tempStore();
    const withRemote = tempRepo({ remote: "git@github.com:acme/billing.git" });
    const treeA = join(tempDir(), "wt-a");
    sh(withRemote, "git", "worktree", "add", "-q", treeA, "-b", "feature");
    expect(resolveRepo(treeA, store).scope).toBe("github.com/acme/billing");

    const noRemote = tempRepo({ name: "local-only" });
    const treeB = join(tempDir(), "some-other-name");
    sh(noRemote, "git", "worktree", "add", "-q", treeB, "-b", "feature");
    expect(resolveRepo(treeB, store).scope).toBe("local-only");
  });

  test("outside a git repo there is no repo scope", () => {
    const store = tempStore();
    expect(resolveRepo(plain(), store)).toEqual({ scope: null, root: null, head: null });
    expect(resolveRepo(join(plain(), "does-not-exist"), store).scope).toBeNull();
  });
});
