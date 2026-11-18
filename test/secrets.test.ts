import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { applyAudit, proposeAudit } from "../cli/audit.ts";
import { findSecret } from "../cli/secrets.ts";
import { kb, putNote, sh, tempStore } from "./helpers.ts";

// Fake tokens are put together at run time, so this file holds no string that looks like a real secret.
const rand = (n: number, chars = "aB3dE5gH7jK9mN1pQ2sT4vW6yZ8") => Array.from({ length: n }, (_, i) => chars[(i * 7 + 3) % chars.length]).join("");
const upper = (n: number) => rand(n, "ABCDEFGHJKLMNPQRSTUVWXYZ234567");
const FAKES: Record<string, string> = {
  "a private key": `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----\n${rand(60)}`,
  "an AWS access key": `aws_access_key_id = ${"AKIA"}${upper(16)}`,
  "a GitHub token": `export GH_TOKEN=${"ghp_"}${rand(36)}`,
  "an Anthropic API key": `key ${"sk-ant-"}api03-${rand(80)}`,
  "an OpenAI API key": `${"sk-"}proj-${rand(48)}`,
  "a Slack token": `${"xoxb-"}${rand(12)}-${rand(24)}`,
  "a Stripe key": `${"sk_live_"}${rand(24)}`,
  "a Google API key": `${"AIza"}${rand(35)}`,
  "an npm token": `//registry.npmjs.org/:_authToken=${"npm_"}${rand(36)}`,
  "a JSON web token": `Bearer ${"eyJ"}${rand(20)}.${"eyJ"}${rand(30)}.${rand(30)}`,
  "a password in a URL": `DATABASE_URL=postgres://app:${rand(14)}@db.example.com/app`,
  "a secret value": `API_KEY="${rand(32)}"`,
};

describe("findSecret", () => {
  test.each(Object.entries(FAKES))("finds %s", (kind, text) => {
    expect(findSecret(`A line of prose.\n${text}\nMore prose.`)).toEqual({ kind, line: 2 });
  });

  test("lets a note talk about secrets without holding one", () => {
    for (const text of [
      "GitHub tokens start with ghp_ and Anthropic keys with sk-ant-.",
      "Put the key in .env as API_KEY=<your key>, never in a note.",
      "Connect with postgres://user:<password>@localhost/app or postgres://${USER}:${PASS}@db/app.",
      "The token is in the 1Password item named deploy, and the secret: ask the user.",
      "Pin it: commit 0123456789abcdef0123456789abcdef01234567 fixed it.",
      "password = hunter2 is a famous joke, and token: short-one.",
      "A long id like secret_rotation_is_handled_by_vault_every_day stays prose.",
    ]) expect(findSecret(text)).toBeNull();
  });
});

describe("a note with a secret is never written", () => {
  const secret = FAKES["a GitHub token"]!;

  test("kb add refuses it, names the kind and not the secret, and writes nothing", () => {
    const store = tempStore();
    const r = kb(store, ["add", "--json"], { stdin: JSON.stringify({ title: "Deploy token", kind: "gotcha", scope: "global", body: `Use this:\n${secret}` }) });
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("a GitHub token (body, line 2)");
    expect(r.stdout + r.stderr).not.toContain(secret.split("=")[1]!);
    expect(store.notes()).toEqual([]);
  });

  test("kb add refuses it in an update, and the note keeps its text", () => {
    const store = tempStore();
    putNote(store, { id: "n", body: "clean" });
    const r = kb(store, ["add", "--json"], { stdin: JSON.stringify({ id: "n", title: secret }) });
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("a GitHub token (title)");
    expect(store.find("n")!.body).toBe("clean");
  });

  test("audit Apply refuses new text or a rule with a secret, before any change", () => {
    const store = tempStore();
    sh(store.home, "git", "init", "-q", "-b", "main");
    putNote(store, { id: "r", scope: "global", body: "old" });
    putNote(store, { id: "t", scope: "global", body: "done" });
    proposeAudit(store, { items: [{ id: "r", action: "rewrite", why: "x", body: "new" }, { id: "t", action: "trash", why: "x" }] }, { scope: null, root: null, head: null });
    const picks = [{ id: "r", action: "rewrite", body: secret }, { id: "t", action: "trash" }];
    expect(() => applyAudit(store, "global", { picks })).toThrow("a GitHub token");
    expect(store.find("r")!.body).toBe("old");
    expect(readdirSync(join(store.home, "notes", "global")).sort()).toEqual(["r.md", "t.md"]);
  });
});
