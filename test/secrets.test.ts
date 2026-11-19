import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyAudit, proposeAudit } from "../cli/audit.ts";
import type { RepoInfo } from "../cli/scope.ts";
import { LINE_LEFT_OUT, findSecret, maskSecrets } from "../cli/secrets.ts";
import { updateNote } from "../cli/write.ts";
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
  "a Slack webhook": `${"hooks.slack.com"}/services/T${upper(8)}/B${upper(8)}/${rand(24)}`,
  "a SendGrid key": `${"SG."}${rand(22)}.${rand(43)}`,
  "a Hugging Face token": `${"hf_"}${rand(34, "abcdefghijkLMNOPQRSTUVwxyz")}`,
  "a password in a URL": `DATABASE_URL=postgres://app:${rand(14)}@db.example.com/app`,
  "a secret value": `API_KEY="${rand(32)}"`,
};

/** More shapes of the kinds above. */
const MORE: [string, string][] = [
  ["a password in a URL", `REDIS_URL=redis://:${rand(14)}@cache.example.com:6379`],
  ["a secret value", `client_secret: ${rand(40, "0123456789abcdef")}`],
];

describe("findSecret", () => {
  test.each(Object.entries(FAKES))("finds %s", (kind, text) => {
    expect(findSecret(`A line of prose.\n${text}\nMore prose.`)).toEqual({ kind, line: 2 });
  });

  test.each(MORE)("finds %s in another shape", (kind, text) => {
    expect(findSecret(text)).toEqual({ kind, line: 1 });
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
      "The secret: docs/how-to/rotate-keys-v2-in-vault.md has the steps.",
      "Read it as API_KEY=process.env.OPENAI_API_KEY_V2_xx in the server.",
      "The token: 123e4567-e89b-12d3-a456-426614174000 is the request id.",
    ]) expect(findSecret(text)).toBeNull();
  });

  test("a long line with no secret is fast", () => {
    const start = performance.now();
    for (const text of ["a-".repeat(50_000) + "token", "a_".repeat(50_000) + "secret=", "a-".repeat(50_000) + "://"]) expect(findSecret(text)).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
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

  test("kb add refuses it in an anchor, and the page's edit refuses it too", () => {
    const store = tempStore();
    const r = kb(store, ["add", "--json"], { stdin: JSON.stringify({ title: "Deploy", kind: "gotcha", scope: "global", body: "b", anchors: ["src/a.ts", secret] }) });
    expect(r.json.error).toContain("a GitHub token (anchors, item 2)");
    expect(store.notes()).toEqual([]);
    putNote(store, { id: "n", body: "clean" });
    expect(() => updateNote(store, { id: "n", body: secret }, { scope: null, head: null })).toThrow("a GitHub token (body)");
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

  test("audit Apply refuses a rule with a secret, and the instructions file stays as it was", () => {
    const store = tempStore();
    sh(store.home, "git", "init", "-q", "-b", "main");
    putNote(store, { id: "g", scope: "global", kind: "convention", body: "a rule" });
    const file = join(store.home, "..", "CLAUDE.md");
    writeFileSync(file, "# Rules\n");
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ globalInstructions: file }));
    proposeAudit(store, { items: [{ id: "g", action: "promote", why: "x", rule: "- A rule.", section: "Style" }] }, { scope: null, root: null, head: null } as unknown as RepoInfo);
    expect(() => applyAudit(store, "global", { picks: [{ id: "g", action: "promote", rule: secret }] })).toThrow("the rule of g looks like it holds a GitHub token");
    expect(readFileSync(file, "utf8")).toBe("# Rules\n");
    expect(store.find("g")!.promoted_to).toBeUndefined();
  });
});

// /kb:recover shows an agent the text of an old session, which kb did not write. A mask takes the
// place of each secret, so the rest of the line still says what happened.
describe("maskSecrets", () => {
  for (const [kind, fake] of Object.entries(FAKES)) {
    test(`masks ${kind}, and the scan finds nothing in the result`, () => {
      const text = `before\nthe command was: ${fake} --verbose\nafter`;
      const masked = maskSecrets(text);
      expect(findSecret(masked)).toBeNull();
      expect(masked).toContain(kind === "a password in a URL" ? "<masked: a password>" : `<masked: ${kind}>`);
      expect(masked).toStartWith("before\nthe command was: ");
      expect(masked).toEndWith(" --verbose\nafter");
    });
  }

  test("keeps the name of a value, and the scheme, the user and the host of a URL", () => {
    expect(maskSecrets(FAKES["a secret value"]!)).toBe('API_KEY="<masked: a secret value>"');
    expect(maskSecrets(FAKES["a password in a URL"]!)).toBe("DATABASE_URL=postgres://app:<masked: a password>@db.example.com/app");
    expect(maskSecrets(`redis://:${rand(12)}@cache.example.com and ${FAKES["a Stripe key"]}`)).toBe("redis://:<masked: a password>@cache.example.com and <masked: a Stripe key>");
  });

  test("masks a private key from its first line to its last, as lines and as one line of a JSON file", () => {
    const head = `-----BEGIN ${"RSA"} PRIVATE KEY-----`;
    const tail = `-----END ${"RSA"} PRIVATE KEY-----`;
    const body = [rand(64), rand(64), `${rand(10)}==`];
    expect(maskSecrets(`cat key.pem\n${head}\n${body.join("\n")}\n${tail}\nexit 0`)).toBe("cat key.pem\n<masked: a private key>\nexit 0");
    expect(maskSecrets(`"private_key": "${head}\\n${body.join("\\n")}\\n${tail}\\n", "id": 7`)).toBe('"private_key": "<masked: a private key>\\n", "id": 7');
    // A key that the output cut short has no last line. The lines of the key still go.
    expect(maskSecrets(`${head}\n${body[0]}\n${body[1]}`)).toBe("<masked: a private key>");
    // A sentence that only names the first line keeps its words.
    expect(maskSecrets(`The file starts with ${head} and then the key follows.`)).toBe("The file starts with <masked: a private key> and then the key follows.");
  });

  test("leaves text with no secret as it is, also a text that names a format", () => {
    for (const text of ["GitHub tokens start with ghp_ and have 36 more characters.", "token: ${GITHUB_TOKEN}", "postgres://app:<password>@db.example.com/app", "password = process.env.DB_PASSWORD", "", "a\n\nb"]) expect(maskSecrets(text)).toBe(text);
  });

  test("a line that still holds a secret after the masks is not written", () => {
    expect(LINE_LEFT_OUT).toBe("<a line that held a secret was left out>");
    expect(findSecret(LINE_LEFT_OUT)).toBeNull();
    // The result of a mask is never a secret itself, also when it is masked again.
    const once = maskSecrets(Object.values(FAKES).join("\n"));
    expect(maskSecrets(once)).toBe(once);
    expect(once).not.toContain(LINE_LEFT_OUT);
  });
});
