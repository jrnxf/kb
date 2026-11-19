import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyAudit, proposeAudit } from "../cli/audit.ts";
import type { RepoInfo } from "../cli/scope.ts";
import { LINE_LEFT_OUT, findSecret, maskSecrets, maskToolText } from "../cli/secrets.ts";
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
      // Also after the first line of a key with no last line: the lines of the key go, and what is no key stays.
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
    // Two keys in one text: each goes, and the text between them stays.
    expect(maskSecrets(`${head}\n${body[0]}\n${tail}\nand the second:\n${head}\n${body[1]}\n${tail}\ndone`)).toBe("<masked: a private key>\nand the second:\n<masked: a private key>\ndone");
  });

  // The lines of a key have no shape of their own, and the headers in front of them have another shape again.
  test("masks a key with armor headers whole, and of a key with no last line the headers and the lines of base64", () => {
    const head = `-----BEGIN ${"RSA"} PRIVATE KEY-----`;
    const tail = `-----END ${"RSA"} PRIVATE KEY-----`;
    const body = [rand(64), rand(64), `${rand(10)}==`];
    const encrypted = `${head}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,${"0123456789ABCDEF".repeat(2)}\n\n${body.join("\n")}\n${tail}`;
    expect(maskSecrets(`cat key.pem\n${encrypted}\nexit 0`)).toBe("cat key.pem\n<masked: a private key>\nexit 0");
    // As one line, as a failed tool call gives it.
    expect(maskSecrets(`cat key.pem ${encrypted.replace(/\s+/g, " ")} exit 0`)).toBe("cat key.pem <masked: a private key> exit 0");

    const pgp = (end: boolean) => `-----BEGIN ${"PGP"} PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\nComment: the key of the deploy bot\n\n${body.join("\n")}\n=${rand(4)}${end ? `\n-----END ${"PGP"} PRIVATE KEY BLOCK-----` : ""}`;
    expect(maskSecrets(`gpg --export-secret-keys\n${pgp(true)}\nexit 0`)).toBe("gpg --export-secret-keys\n<masked: a private key>\nexit 0");
    // A key that the output cut short has no last line. Its headers and its lines go, and the text after them stays.
    const cuts = [pgp(false), `${head}\nProc-Type: 4,ENCRYPTED\n\n${body[0]}`, `${head}\n${body[0]}\n${body[1]}`, `${head}\r\n${body[0]}\r\n\r\n${body[1]}`];
    for (const cut of cuts) {
      const masked = maskSecrets(`the output was:\n${cut}\n\nmore lines, of what came after it`);
      expect(masked).toBe("the output was:\n<masked: a private key>\n\nmore lines, of what came after it");
      expect(findSecret(masked)).toBeNull();
    }
    // The same as one line: with \n written out as in a JSON file, and with spaces as in one line of output.
    expect(maskSecrets(`"private_key": "${head}\\n${body[0]}\\n${body[1]}", "id": 7`)).toBe('"private_key": "<masked: a private key>", "id": 7');
    expect(maskSecrets(`head -3 id_rsa: ${head} ${body[0]} ${body[1]} exit 1`)).toBe("head -3 id_rsa: <masked: a private key> exit 1");
    for (const left of ["Proc-Type", "DEK-Info", "GnuPG", "deploy bot", body[0]!]) expect(maskSecrets(`${encrypted}\n${pgp(true)}\n${pgp(false)}`)).not.toContain(left);
  });

  // An agent that writes about a key file names its first line. A mask to the end of the text took the rest of the turn.
  test("a sentence that names the first line of a key loses that mark only", () => {
    const head = `-----BEGIN ${"RSA"} PRIVATE KEY-----`;
    const tail = `-----END ${"RSA"} PRIVATE KEY-----`;
    const said = (mark: string) => `The file starts with ${mark} so I will check it.\n\nThen I ran the build.\nIt passed: 14 tests in /home/user/projects/shop/test.`;
    expect(maskSecrets(said(head))).toBe(said("<masked: a private key>"));
    expect(findSecret(maskSecrets(said(head)))).toBeNull();
    // A line of a sentence after the mark is no line of a key, also when it has a colon or a long word.
    const lines = "It is the deploy key of the shop.\nNote the internationalization of the comment.";
    expect(maskSecrets(`${head}\n${lines}`)).toBe(`<masked: a private key>\n${lines}`);
    // A sentence that names the first line does not reach the END line of a key far below it.
    const key = `${head}\n${rand(64)}\n${tail}`;
    expect(maskSecrets(`${said(head)}\n${key}\nexit 0`)).toBe(`${said("<masked: a private key>")}\n<masked: a private key>\nexit 0`);
    expect(maskSecrets(`It starts with ${head} and it ends with ${tail}.`)).toBe("It starts with <masked: a private key>.");
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

// A tool call and its output are not text that somebody wrote for a reader. A short value there
// is a secret as often as a long random one, so these masks are wider than the scan of a note.
describe("maskToolText", () => {
  test("masks the value of an authorization header and of a Bearer or Basic scheme, of any length", () => {
    expect(maskToolText('curl -H "Authorization: Bearer abc" https://api.example.com')).toBe('curl -H "Authorization: Bearer <masked: a credential>" https://api.example.com');
    expect(maskToolText("Authorization: Basic dXNlcjpw")).toBe("Authorization: Basic <masked: a credential>");
    expect(maskToolText("authorization=tok123 was refused")).toBe("authorization=<masked: a credential> was refused");
    expect(maskToolText('{"Authorization": "Token 9f8e7d"}')).toBe('{"Authorization": "Token <masked: a credential>"}');
    expect(maskToolText("the proxy sent bearer a1b2c3d4 and Basic dXNlcjpwYXNz on")).toBe("the proxy sent bearer <masked: a credential> and Basic <masked: a credential> on");
  });

  test("masks the value given to a name that says secret, token, password, key or credential", () => {
    const cases: [string, string][] = [
      ["DB_PASSWORD=hunter2 npm start", "DB_PASSWORD=<masked: a secret value> npm start"],
      ['{"client_secret":"s3","access_token": "t"}', '{"client_secret":"<masked: a secret value>","access_token": "<masked: a secret value>"}'],
      ["apiKey: 'a b c'", "apiKey: '<masked: a secret value>'"],
      ["--api-key=k1 --passwd=p1 pwd=p2", "--api-key=<masked: a secret value> --passwd=<masked: a secret value> pwd=<masked: a secret value>"],
      ["https://example.com/cb?token=abc&state=1", "https://example.com/cb?token=<masked: a secret value>&state=1"],
      ["aws.credentials = xyz; ssh.key: id9", "aws.credentials = <masked: a secret value>; ssh.key: <masked: a secret value>"],
    ];
    for (const [text, masked] of cases) expect(maskToolText(text)).toBe(masked);
  });

  // A command line gives a credential with no `=`: after a flag, after a user name, glued to -p, or in a URL.
  test("masks the value after a flag that says secret, the password after a user name, and a short password in a URL", () => {
    const cases: [string, string][] = [
      ["curl -u admin:hunter2 --token abc123 https://api.example.com", "curl -u admin:<masked: a password> --token <masked: a secret value> https://api.example.com"],
      ["deploy --password hunter2 --host db.example.com", "deploy --password <masked: a secret value> --host db.example.com"],
      ["tool --api-key k1 --client-secret 's 2' -passwd p3 --auth me:pw --credential c4 --key k5", "tool --api-key <masked: a secret value> --client-secret '<masked: a secret value>' -passwd <masked: a secret value> --auth <masked: a secret value> --credential <masked: a secret value> --key <masked: a secret value>"],
      ["tool --auth=me:pw --auth-token=t1", "tool --auth=<masked: a secret value> --auth-token=<masked: a secret value>"],
      ["curl --user 'bob:pw' --proxy-user=p:q -x proxy.example.com", "curl --user 'bob:<masked: a password>' --proxy-user=p:<masked: a password> -x proxy.example.com"],
      ["mysql -psecret -h db shop", "mysql -p<masked: a password> -h db shop"],
      ["mysqldump -u root -p'se cret' shop | gzip", "mysqldump -u root -p'<masked: a password>' shop | gzip"],
      ["sshpass -ppw ssh -p2222 host && psql -pS3cret shop", "sshpass -p<masked: a password> ssh -p2222 host && psql -p<masked: a password> shop"],
      ["git clone https://bob:pw@example.com/shop.git", "git clone https://bob:<masked: a password>@example.com/shop.git"],
      ["redis-cli -u redis://:p1@cache.example.com:6379", "redis-cli -u redis://:<masked: a password>@cache.example.com:6379"],
    ];
    for (const [text, masked] of cases) {
      expect(maskToolText(text)).toBe(masked);
      expect(maskToolText(masked)).toBe(masked);
    }
  });

  test("keeps what is no secret after a flag: a file, a number, a variable, the next flag, and the flags of other tools", () => {
    const kept = [
      "curl --key-file /home/user/client.pem --password-file /run/secrets/db --token-file t.txt https://api.example.com",
      "claude --max-tokens 4096 --keyboard us --author me",
      "deploy --token $DEPLOY_TOKEN --password \"${DB_PASSWORD}\" --secret <secret> -u me:$PASSWORD",
      "mysql --password --verbose",
      "psql --no-password shop",
      "git push -u origin main",
      "docker run -u 1000:1000 -p8080:80 shop",
      "psql -p5433 -U app shop",
      "cp -pr src out; mkdir -pv build; ssh -p2222 host",
      "the token abc is not a flag, and the key value is a pair",
      "https://example.com:8080/a@b and https://user:${PASSWORD}@example.com",
    ];
    for (const text of kept) expect(maskToolText(text)).toBe(text);
  });

  test("keeps a variable, a placeholder, and a word that only holds the letters of key or token", () => {
    for (const text of ["Authorization: Bearer $TOKEN", "API_KEY=${API_KEY} TOKEN=$1", "password: <password>", "token = process.env.GH_TOKEN", "KeyError: 'name'", "max_tokens=4096 monkey=1 keyboard: us", "Basic authentication failed", "password="]) expect(maskToolText(text)).toBe(text);
  });

  test("does all that maskSecrets does, and its result is stable", () => {
    for (const fake of Object.values(FAKES)) expect(findSecret(maskToolText(`ran: ${fake} --verbose`))).toBeNull();
    const once = maskToolText(`TOKEN=abc ${FAKES["a GitHub token"]} Authorization: Bearer xyz`);
    expect(once).toBe("TOKEN=<masked: a secret value> export GH_TOKEN=<masked: a GitHub token> Authorization: Bearer <masked: a credential>");
    expect(maskToolText(once)).toBe(once);
  });

  test("a long text with no secret is fast", () => {
    const text = `${"a.b-c_d".repeat(5000)} ${"x".repeat(20_000)} ${"key ".repeat(5000)} ${"mysql ".repeat(3000)} ${"--token ".repeat(3000)} ${"-----BEGIN ".repeat(2000)}`;
    const started = performance.now();
    expect(maskToolText(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
